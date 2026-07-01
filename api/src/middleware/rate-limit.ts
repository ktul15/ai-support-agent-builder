import type { RequestHandler } from 'express';
import { requireTenant } from './tenant-context.js';
import type { RateLimiter } from '../ratelimit/index.js';

/**
 * Per-tenant rate limiting. Mount AFTER tenantContext so the tenant is from the
 * verified JWT (never client input). On limit exceeded -> 429 + Retry-After.
 *
 * Fails OPEN: if the limiter errors (e.g. a Redis blip), the request proceeds
 * rather than taking chat down for everyone. Availability is chosen over strict
 * enforcement for a transient failure; the error is logged. (The per-request
 * token/output budgets still cap cost even when the rate limiter is degraded.)
 */
export function rateLimit(limiter: RateLimiter, keyPrefix: string): RequestHandler {
  return (req, res, next) => {
    const tenant = requireTenant(req);
    void (async () => {
      try {
        const { allowed, retryAfterSec } = await limiter.consume(`${keyPrefix}:${tenant.tenantId}`);
        if (!allowed) {
          res.setHeader('Retry-After', String(retryAfterSec));
          res.status(429).json({ error: 'rate limit exceeded' });
          return;
        }
      } catch (err) {
        console.warn(
          `rate limiter error (failing open): ${err instanceof Error ? err.message : err}`,
        );
      }
      next();
    })();
  };
}
