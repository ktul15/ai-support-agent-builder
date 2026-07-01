import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { GenerationService } from '../chat/generation-service.js';
import { assembleContext, DEFAULT_ASSEMBLE_OPTIONS } from '../chat/prompt-assembly.js';
import { buildGroundingSystem } from '../chat/grounding.js';
import { evaluateThreshold, REFUSAL_MESSAGE } from '../chat/refusal.js';
import { buildCitations } from '../chat/citations.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { RateLimiter } from '../ratelimit/index.js';

export interface ChatLimits {
  /** Token budget for the assembled sources block (#28; cl100k-approx). */
  contextTokenBudget: number;
  /** Hard cap on generated answer tokens (cost ceiling). */
  maxOutputTokens: number;
}

export interface ChatDeps {
  retrieval: RetrievalService;
  generation: GenerationService;
  rateLimiter: RateLimiter;
  limits: ChatLimits;
}

const bodySchema = z.object({
  assistantId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
});

const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 120_000;

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * SSE chat endpoint (invariant #5): retrieve -> threshold gate -> assemble ->
 * generate, streamed token-by-token over text/event-stream. The final `done`
 * event carries citations + grounded + latency_ms. Client disconnect aborts the
 * upstream Claude call (stops token billing); a heartbeat keeps it alive.
 *
 * `Cache-Control: no-transform` defends the stream against a proxy/middleware
 * re-compressing it. No compression middleware is mounted yet — when one is
 * added globally it MUST skip this route, or buffering defeats streaming.
 *
 * Both refusal gates (invariant #3) are wired: the pre-LLM threshold gate (#25)
 * and the in-prompt grounding contract (#26). `grounded` is true only when the
 * answer cited >=1 source (#24). Cost/abuse controls (#28): a per-tenant Redis
 * token bucket (429 on exceed), a per-request context token budget, a hard
 * output-token cap, and SSE backpressure (await drain).
 */
export function chatRouter(deps: ChatDeps, tenantContext: RequestHandler): Router {
  const r = Router();

  r.post('/chat', tenantContext, rateLimit(deps.rateLimiter, 'chat'), (req, res) => {
    const tenant = requireTenant(req);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { assistantId, question } = parsed.data;

    void (async () => {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const safeWrite = (chunk: string): boolean => {
        if (closed || res.writableEnded) return true;
        return res.write(chunk);
      };
      // Backpressure (#28): if the socket buffer is full, wait for it to flush
      // before writing more — bounds in-flight memory for a slow reader instead
      // of buffering the whole answer. Also resolve on disconnect/abort so a
      // wedged socket (reader stalls but holds the connection) can't hang the
      // coroutine past the abort/timeout — the timeout path destroys it too.
      const drain = (): Promise<void> =>
        new Promise((resolve) => {
          const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            req.off('close', done);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          if (controller.signal.aborted) {
            done();
            return;
          }
          res.once('drain', done);
          res.once('close', done);
          req.once('close', done);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      const end = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (maxTimer) clearTimeout(maxTimer);
        if (!res.writableEnded) res.end();
      };
      // Register disconnect handling BEFORE the first await: a client drop during
      // the assistant DB load must still abort + clean up — a 'close' event fired
      // before we listen is never replayed by the EventEmitter.
      req.on('close', () => {
        controller.abort();
        end();
      });
      res.on('error', () => {
        controller.abort();
        end();
      });

      const t0 = performance.now();
      try {
        // Assistant is tenant-scoped by RLS (withTenant). Inside the try so a DB
        // error becomes a handled response, not an unhandled rejection that would
        // crash the process (the IIFE is void-ed, so Express can't catch it).
        const assistant = await withTenant(tenant.tenantId, (tx) =>
          tx.assistant.findUnique({
            where: { id: assistantId },
            select: { id: true, model: true, systemPrompt: true, refusalThreshold: true },
          }),
        );
        if (closed) return; // client disconnected during the load
        if (!assistant) {
          res.status(404).json({ error: 'assistant not found' });
          return;
        }

        // Stream starts here — past this point errors are SSE `error` frames.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        heartbeat = setInterval(() => safeWrite(`: ping\n\n`), HEARTBEAT_MS);
        maxTimer = setTimeout(() => {
          safeWrite(sse('error', { message: 'timeout' }));
          controller.abort();
          end();
          // A graceful res.end() can't flush a buffer stuck behind a dead
          // reader — destroy the socket so it actually tears down.
          res.socket?.destroy();
        }, MAX_STREAM_MS);

        const hits = await deps.retrieval.retrieve(tenant.tenantId, { assistantId, question });
        if (closed) return;

        // Pre-LLM gate (#25, invariant #3): if nothing clears the assistant's
        // refusal threshold, refuse WITHOUT spending an LLM call.
        const gate = evaluateThreshold(hits, assistant.refusalThreshold);
        if (gate.refuse) {
          console.info(
            `chat refusal: assistant=${assistant.id} reason=${gate.reason} ` +
              `top_score=${gate.topScore ?? 'none'} threshold=${assistant.refusalThreshold}`,
          );
          safeWrite(sse('token', { text: REFUSAL_MESSAGE }));
          safeWrite(
            sse('done', {
              grounded: false,
              citations: [],
              latency_ms: Math.round(performance.now() - t0),
            }),
          );
          end();
          return;
        }

        // Enforce the per-request context token budget (#28) — trims the sources
        // block so the prompt sent to Claude stays within a bounded size.
        const ctx = assembleContext(hits, {
          maxSources: DEFAULT_ASSEMBLE_OPTIONS.maxSources,
          tokenBudget: deps.limits.contextTokenBudget,
        });

        // Accumulate the answer so we can tell an in-prompt refusal (gate 2, #26)
        // from a grounded answer — the contract makes the model emit EXACTLY the
        // refusal string when the sources don't support an answer.
        let answer = '';
        for await (const event of deps.generation.stream({
          model: assistant.model,
          system: buildGroundingSystem(assistant.systemPrompt),
          question,
          context: ctx.text,
          maxTokens: deps.limits.maxOutputTokens,
          signal: controller.signal,
        })) {
          if (closed) break;
          if (event.type === 'text') {
            answer += event.text;
            if (!safeWrite(sse('token', { text: event.text }))) {
              await drain();
              if (closed) break;
            }
          } else if (event.type === 'error') {
            safeWrite(sse('error', { message: 'generation failed', retryable: event.retryable }));
            end();
            return;
          }
        }

        if (!closed) {
          // The model refused in-prompt iff it emitted exactly the refusal string.
          const refused = answer.trim() === REFUSAL_MESSAGE;
          // Only the sources the answer actually cited (#24), not every source
          // shown to the model.
          const citations = refused ? [] : buildCitations(answer, ctx.sources);
          safeWrite(
            sse('done', {
              // Grounded = a real answer anchored to >=1 cited source. An answer
              // that refused, or that cited nothing (incl. an empty answer), is
              // not something the corpus verifiably backs.
              grounded: !refused && citations.length > 0,
              citations,
              latency_ms: Math.round(performance.now() - t0),
            }),
          );
          end();
        }
      } catch {
        if (closed) return;
        // Pre-headers (DB/setup) error -> plain HTTP 503; post-headers -> SSE
        // error frame. Never leak internals either way.
        if (res.headersSent) safeWrite(sse('error', { message: 'internal error' }));
        else res.status(503).json({ error: 'service unavailable' });
        end();
      }
    })();
  });

  return r;
}
