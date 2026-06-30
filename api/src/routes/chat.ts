import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { GenerationService } from '../chat/generation-service.js';
import { assembleContext, type AssembledSource } from '../chat/prompt-assembly.js';
import { DEFAULT_GROUNDING_PROMPT } from '../chat/grounding.js';

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

/** marker -> chunk citation. #24 refines (only markers the answer actually cites). */
interface ChatCitation {
  marker: number;
  documentId: string;
  title: string;
  page: number | null;
  section: string | null;
  charStart: number | null;
  charEnd: number | null;
  snippet: string;
}

function toCitations(sources: AssembledSource[]): ChatCitation[] {
  return sources.map((s) => ({
    marker: s.marker,
    documentId: s.documentId,
    title: s.title,
    page: s.page,
    section: s.section,
    charStart: s.charStart,
    charEnd: s.charEnd,
    snippet: s.content.slice(0, 300),
  }));
}

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * SSE chat endpoint (invariant #5): retrieve -> assemble -> generate, streamed
 * token-by-token over text/event-stream. The final `done` event carries
 * citations + grounded + latency_ms. Client disconnect aborts the upstream
 * Claude call (stops token billing); a heartbeat keeps the connection alive.
 *
 * `Cache-Control: no-transform` defends the stream against a proxy/middleware
 * re-compressing it. No compression middleware is mounted yet — when one is
 * added globally it MUST skip this route, or buffering defeats streaming.
 *
 * Boundaries: the refusal threshold gate is #25; the grounding contract +
 * exact refusal string is #26; the precise citations payload is #24. Here
 * `grounded` is a placeholder (had-sources) until #25/#26 land.
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
            select: { id: true, model: true, systemPrompt: true },
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
        const ctx = assembleContext(hits);

        for await (const event of deps.generation.stream({
          model: assistant.model,
          system: assistant.systemPrompt ?? DEFAULT_GROUNDING_PROMPT,
          question,
          context: ctx.text,
          signal: controller.signal,
        })) {
          if (closed) break;
          if (event.type === 'text') {
            safeWrite(sse('token', { text: event.text }));
          } else if (event.type === 'error') {
            safeWrite(sse('error', { message: 'generation failed', retryable: event.retryable }));
            end();
            return;
          }
        }

        if (!closed) {
          safeWrite(
            sse('done', {
              grounded: ctx.sources.length > 0,
              citations: toCitations(ctx.sources),
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
