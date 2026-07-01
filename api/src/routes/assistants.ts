import { Router, type RequestHandler } from 'express';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';

/**
 * Lists the tenant's assistants (the admin needs an assistant id to target for
 * uploads, retrieval, publish, etc.). Tenant-scoped by RLS via withTenant; the
 * tenant comes from the verified JWT, never the client. Every tenant has at
 * least one (a default assistant is provisioned at signup).
 */
export function assistantsRouter(authMiddleware: RequestHandler): Router {
  const r = Router();

  r.get('/assistants', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    withTenant(tenant.tenantId, (tx) =>
      tx.assistant.findMany({
        select: { id: true, name: true, status: true, model: true, createdAt: true },
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
            created_at: a.createdAt.toISOString(),
          })),
        }),
      )
      .catch((err) => {
        console.error('assistants list error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  return r;
}
