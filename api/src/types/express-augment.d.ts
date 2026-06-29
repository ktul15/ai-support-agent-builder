import type { TenantClaims } from '../auth/tenant-token.js';

// Attach the verified tenant identity to the request. Optional because it is
// only present AFTER the tenantContext middleware runs; handlers behind that
// middleware can rely on it being set.
declare module 'express-serve-static-core' {
  interface Request {
    tenant?: TenantClaims;
  }
}
