import { Router, type RequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { requireTenant, isAdminSession } from '../middleware/tenant-context.js';
import { generateApiKey } from '../auth/api-key.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tuning + publish. refusal_threshold is a cosine similarity in [0, 1]; status
// is the publish toggle. At least one field must be present.
const patchSchema = z
  .object({
    refusalThreshold: z.coerce.number().min(0).max(1).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  })
  .refine((v) => v.refusalThreshold !== undefined || v.status !== undefined, {
    message: 'nothing to update',
  });

/**
 * Assistant management — admin-only (human session, not assistant-scoped). Lists
 * assistants, updates tuning/publish state, and manages consumer API keys.
 * Tenant-scoped by RLS via withTenant; tenant from the verified JWT.
 */
export function assistantsRouter(authMiddleware: RequestHandler): Router {
  const r = Router();

  const requireAdmin = (req: Request, res: Response) => {
    const tenant = requireTenant(req);
    if (!isAdminSession(tenant)) {
      res.status(403).json({ error: 'admin only' });
      return null;
    }
    return tenant;
  };

  r.get('/assistants', authMiddleware, (req, res) => {
    const tenant = requireAdmin(req, res);
    if (!tenant) return;
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

  // Update tuning (refusal threshold) and/or publish state (status). Admin-only,
  // tenant-scoped, idempotent.
  r.patch('/assistants/:id', authMiddleware, (req, res) => {
    const tenant = requireAdmin(req, res);
    if (!tenant) return;
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid assistant id' });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'refusalThreshold (0..1) and/or status (DRAFT|PUBLISHED)' });
      return;
    }
    const data: { refusalThreshold?: number; status?: 'DRAFT' | 'PUBLISHED' } = {};
    if (parsed.data.refusalThreshold !== undefined)
      data.refusalThreshold = parsed.data.refusalThreshold;
    if (parsed.data.status !== undefined) data.status = parsed.data.status;

    withTenant(tenant.tenantId, (tx) => tx.assistant.updateMany({ where: { id }, data }))
      .then((result) => {
        if (result.count === 0) {
          res.status(404).json({ error: 'assistant not found' });
          return;
        }
        res.json({
          id,
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.refusalThreshold !== undefined
            ? { refusal_threshold: data.refusalThreshold }
            : {}),
        });
      })
      .catch((err) => {
        console.error('assistant patch error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // Mint a consumer API key. The plaintext is returned ONCE; only the hash is
  // stored. The key is scoped to this assistant (+ tenant).
  r.post('/assistants/:id/api-keys', authMiddleware, (req, res) => {
    const tenant = requireAdmin(req, res);
    if (!tenant) return;
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid assistant id' });
      return;
    }
    const { key, hash } = generateApiKey();
    withTenant(tenant.tenantId, async (tx) => {
      const assistant = await tx.assistant.findUnique({ where: { id }, select: { id: true } });
      if (!assistant) return null;
      return tx.apiKey.create({
        data: { tenantId: tenant.tenantId, assistantId: id, keyHash: hash },
        select: { id: true, createdAt: true },
      });
    })
      .then((created) => {
        if (!created) {
          res.status(404).json({ error: 'assistant not found' });
          return;
        }
        // `key` is the only time the plaintext is ever available.
        res.status(201).json({ id: created.id, key, created_at: created.createdAt.toISOString() });
      })
      .catch((err) => {
        console.error('api key create error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // List an assistant's API keys (metadata only — never the hash or plaintext).
  r.get('/assistants/:id/api-keys', authMiddleware, (req, res) => {
    const tenant = requireAdmin(req, res);
    if (!tenant) return;
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid assistant id' });
      return;
    }
    withTenant(tenant.tenantId, (tx) =>
      tx.apiKey.findMany({
        where: { assistantId: id },
        select: { id: true, createdAt: true, lastUsedAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    )
      .then((keys) =>
        res.json({
          api_keys: keys.map((k) => ({
            id: k.id,
            created_at: k.createdAt.toISOString(),
            last_used_at: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
          })),
        }),
      )
      .catch((err) => {
        console.error('api key list error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // Revoke a key (deletes the row -> the hash no longer resolves). Idempotent.
  r.delete('/assistants/:id/api-keys/:keyId', authMiddleware, (req, res) => {
    const tenant = requireAdmin(req, res);
    if (!tenant) return;
    const { id, keyId } = req.params;
    if (!id || !UUID_RE.test(id) || !keyId || !UUID_RE.test(keyId)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    withTenant(tenant.tenantId, (tx) =>
      tx.apiKey.deleteMany({ where: { id: keyId, assistantId: id } }),
    )
      .then((result) => {
        if (result.count === 0) {
          res.status(404).json({ error: 'api key not found' });
          return;
        }
        res.status(204).end();
      })
      .catch((err) => {
        console.error('api key delete error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  return r;
}
