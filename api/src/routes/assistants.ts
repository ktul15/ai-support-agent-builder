import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { requireTenant, isAdminSession } from '../middleware/tenant-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// refusal_threshold is a cosine similarity in [0, 1]; clamp so a bad value can't
// make the assistant refuse everything (>1) or never refuse on score (<0).
const patchSchema = z.object({
  refusalThreshold: z.coerce.number().min(0).max(1),
});

/**
 * Assistant management — admin-only (human session, not assistant-scoped). Lists
 * the tenant's assistants (upload/publish/tuning targets) and updates tuning
 * settings. Tenant-scoped by RLS via withTenant; tenant from the verified JWT.
 */
export function assistantsRouter(authMiddleware: RequestHandler): Router {
  const r = Router();

  r.get('/assistants', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    if (!isAdminSession(tenant)) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    withTenant(tenant.tenantId, (tx) =>
      tx.assistant.findMany({
        select: {
          id: true,
          name: true,
          status: true,
          model: true,
          refusalThreshold: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    )
      .then((assistants) =>
        res.json({
          assistants: assistants.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            model: a.model,
            refusal_threshold: a.refusalThreshold,
            created_at: a.createdAt.toISOString(),
          })),
        }),
      )
      .catch((err) => {
        console.error('assistants list error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // Update tuning settings (currently the refusal threshold — the playground
  // tuner writes here). Admin-only, tenant-scoped, idempotent.
  r.patch('/assistants/:id', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    if (!isAdminSession(tenant)) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid assistant id' });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'refusalThreshold must be a number in [0, 1]' });
      return;
    }
    withTenant(tenant.tenantId, (tx) =>
      tx.assistant.updateMany({
        where: { id },
        data: { refusalThreshold: parsed.data.refusalThreshold },
      }),
    )
      .then((result) => {
        if (result.count === 0) {
          res.status(404).json({ error: 'assistant not found' });
          return;
        }
        res.json({ id, refusal_threshold: parsed.data.refusalThreshold });
      })
      .catch((err) => {
        console.error('assistant patch error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  return r;
}
