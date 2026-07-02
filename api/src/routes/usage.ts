import { Router, type RequestHandler } from 'express';
import { requireTenant, isAdminSession } from '../middleware/tenant-context.js';
import type { UsageMeter } from '../observability/usage-meter.js';

/**
 * The tenant's own usage totals (admin-only). The meter holds every tenant's
 * numbers, so this exposes ONLY `forTenant(jwt.tenant)` — never a cross-tenant
 * snapshot — keeping metering tenant-isolated like everything else.
 */
export function usageRouter(meter: UsageMeter, authMiddleware: RequestHandler): Router {
  const r = Router();

  r.get('/usage', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    if (!isAdminSession(tenant)) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    res.json({ usage: meter.forTenant(tenant.tenantId) });
  });

  return r;
}
