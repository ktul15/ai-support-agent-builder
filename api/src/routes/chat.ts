import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { GenerationService } from '../chat/generation-service.js';
import { assembleContext } from '../chat/prompt-assembly.js';
import { buildGroundingSystem } from '../chat/grounding.js';
import { evaluateThreshold, REFUSAL_MESSAGE } from '../chat/refusal.js';
import { buildCitations } from '../chat/citations.js';

export interface ChatDeps {
  retrieval: RetrievalService;
  generation: GenerationService;
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
 * and the in-prompt grounding contract (#26, buildGroundingSystem). `grounded`
 * is true only when the model produced a real answer (not the refusal string)
 * over a non-empty source set. Still pending: the precise citations payload
 * (#24, narrows to only the markers the answer actually cited).
 */
export function chatRouter(deps: ChatDeps, tenantContext: RequestHandler): Router {
  const r = Router();

  r.post('/chat', tenantContext, (req, res) => {
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
      const safeWrite = (chunk: string): void => {
        if (!closed && !res.writableEnded) res.write(chunk);
      };
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

        const ctx = assembleContext(hits);

        // Accumulate the answer so we can tell an in-prompt refusal (gate 2, #26)
        // from a grounded answer — the contract makes the model emit EXACTLY the
        // refusal string when the sources don't support an answer.
        let answer = '';
        for await (const event of deps.generation.stream({
          model: assistant.model,
          system: buildGroundingSystem(assistant.systemPrompt),
          question,
          context: ctx.text,
          signal: controller.signal,
        })) {
          if (closed) break;
          if (event.type === 'text') {
            answer += event.text;
            safeWrite(sse('token', { text: event.text }));
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
