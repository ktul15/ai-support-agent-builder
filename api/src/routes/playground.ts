import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { requireTenant, isAdminSession } from '../middleware/tenant-context.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import { assembleContext, DEFAULT_ASSEMBLE_OPTIONS } from '../chat/prompt-assembly.js';
import { evaluateThreshold } from '../chat/refusal.js';
import type { ChatLimits } from './chat.js';

export interface PlaygroundDeps {
  retrieval: RetrievalService;
  limits: ChatLimits;
}

const bodySchema = z.object({
  assistantId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
  k: z.coerce.number().int().min(1).max(50).optional(),
});

const SNIPPET_MAX = 200;

/**
 * Retrieval debug / tuning surface (#27). Runs the prod retrieval path —
 * retrieval-service -> threshold gate -> prompt assembly (same budget) — but,
 * instead of streaming an LLM answer, returns the intermediate results as JSON:
 * the chosen chunks + scores, the threshold decision, and what would be sent to
 * the model. No LLM call, so it's cheap to iterate on refusal_threshold. `k` is
 * an operator knob here (prod uses the default); the threshold decision is
 * k-independent (top score), so tuning stays faithful.
 *
 * Admin-only: gated to human/admin sessions (JWT carries userId AND no
 * assistant scope). Consumer / assistant-scoped tokens (mobile API keys) get
 * 403; a real RBAC layer is future work.
 */
export function playgroundRouter(deps: PlaygroundDeps, tenantContext: RequestHandler): Router {
  const r = Router();

  r.post('/playground/retrieve', tenantContext, (req, res) => {
    const tenant = requireTenant(req);
    if (!isAdminSession(tenant)) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { assistantId, question, k } = parsed.data;

    void (async () => {
      try {
        const assistant = await withTenant(tenant.tenantId, (tx) =>
          tx.assistant.findUnique({
            where: { id: assistantId },
            select: { id: true, refusalThreshold: true },
          }),
        );
        if (!assistant) {
          res.status(404).json({ error: 'assistant not found' });
          return;
        }

        const hits = await deps.retrieval.retrieve(tenant.tenantId, { assistantId, question, k });
        const gate = evaluateThreshold(hits, assistant.refusalThreshold);
        // Mirror prod: assembly only runs when the gate would let generation proceed.
        const ctx = gate.refuse
          ? null
          : assembleContext(hits, {
              maxSources: DEFAULT_ASSEMBLE_OPTIONS.maxSources,
              tokenBudget: deps.limits.contextTokenBudget,
            });

        res.json({
          assistant_id: assistant.id,
          question,
          threshold: assistant.refusalThreshold,
          decision: { refuse: gate.refuse, reason: gate.reason, top_score: gate.topScore },
          retrieved: hits.map((h) => ({
            id: h.id,
            document_id: h.documentId,
            title: h.title,
            page: h.page,
            section: h.section,
            score: h.score,
            snippet: h.content.slice(0, SNIPPET_MAX),
          })),
          assembled: ctx
            ? {
                total_tokens: ctx.totalTokens,
                // chunk_id + score so an admin can correlate each promoted
                // source back to a `retrieved[]` hit (which chunk made the cut).
                sources: ctx.sources.map((s) => ({
                  marker: s.marker,
                  chunk_id: s.chunkId,
                  document_id: s.documentId,
                  title: s.title,
                  page: s.page,
                  section: s.section,
                  score: s.score,
                })),
              }
            : null,
        });
      } catch (err) {
        console.error(`playground error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.status(503).json({ error: 'service unavailable' });
      }
    })();
  });

  return r;
}
