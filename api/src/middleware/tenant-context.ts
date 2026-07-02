import type { Request, RequestHandler } from 'express';
import { getConfig } from '../config.js';
import { verifyTenantToken, type TenantClaims } from '../auth/tenant-token.js';

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Case-insensitive scheme; tolerant of extra surrounding whitespace; rejects a
 * value containing more than one token. Always fails closed (returns null).
 */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

/**
 * Build the tenant-context middleware against a specific signing secret. The
 * verified token's `tenantId` is attached to `req.tenant` — the ONLY tenant
 * source any downstream handler may trust. Handlers then pass `req.tenant.id`
 * into `withTenant()` so RLS scopes the queries.
 *
 * Fails closed: a missing, malformed, expired, or wrongly-signed token gets a
 * generic 401 (no detail leaked about why), and `req.tenant` is never set.
 */
export function makeTenantContext(secret: string): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }
    // .then(onFulfilled, onRejected): the rejection handler catches ONLY token
    // verification failures, NOT errors thrown by downstream handlers via
    // next(). That stops a real 500 from being masked as a 401 and avoids a
    // double-response after a handler has already started writing.
    verifyTenantToken(token, secret).then(
      (claims) => {
        req.tenant = claims;
        next();
      },
      () => {
        res.status(401).json({ error: 'invalid or expired token' });
      },
    );
  };
}

/**
 * Read the verified tenant from a request, asserting the middleware ran. Use
 * this in handlers instead of `req.tenant!`, so a route accidentally mounted
 * without `tenantContext` fails loudly with a clear message rather than running
 * an unscoped query.
 */
export function requireTenant(req: Request): TenantClaims {
  if (!req.tenant) {
    throw new Error('requireTenant: no tenant context — mount tenantContext on this route');
  }
  return req.tenant;
}

/**
 * An admin (human) session vs a consumer/assistant-scoped one. A user login
 * carries `userId` and no assistant scope; a consumer/API-key token carries
 * `assistantId`. Requiring BOTH conditions means a future issuance path that put
 * a `userId` on a consumer token can't silently gain admin access. Interim admin
 * signal until real RBAC.
 */
export function isAdminSession(claims: TenantClaims): boolean {
  return Boolean(claims.userId) && !claims.assistantId;
}

// Lazily bound to the runtime JWT secret on first request (config validates at
// boot, but we don't want importing this module to force config loading in tests).
let runtime: RequestHandler | undefined;

/** The mountable middleware using the app's configured JWT secret. */
export const tenantContext: RequestHandler = (req, res, next) => {
  runtime ??= makeTenantContext(getConfig().JWT_SECRET);
  return runtime(req, res, next);
};
