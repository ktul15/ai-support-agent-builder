import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { makeTenantContext } from './tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';

const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';

// A tiny app: the real middleware guards a route that echoes the verified tenant.
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(makeTenantContext(SECRET));
  app.get('/whoami', (req, res) => {
    res.json({ tenant: req.tenant });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('tenantContext middleware', () => {
  it('401s when no Authorization header is present', async () => {
    const res = await fetch(`${base}/whoami`);
    expect(res.status).toBe(401);
  });

  it('401s on a non-Bearer scheme', async () => {
    const res = await fetch(`${base}/whoami`, { headers: { authorization: 'Token abc' } });
    expect(res.status).toBe(401);
  });

  it('401s on an empty Bearer value', async () => {
    const res = await fetch(`${base}/whoami`, { headers: { authorization: 'Bearer ' } });
    expect(res.status).toBe(401);
  });

  it('401s on a garbage token', async () => {
    const res = await fetch(`${base}/whoami`, { headers: { authorization: 'Bearer not.a.jwt' } });
    expect(res.status).toBe(401);
  });

  it('attaches the verified tenant on a valid token', async () => {
    const token = await signTenantToken({ tenantId: TENANT }, SECRET);
    const res = await fetch(`${base}/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant?: { tenantId: string } };
    expect(body.tenant?.tenantId).toBe(TENANT);
  });

  it('ignores a tenant id supplied in headers/query (only the token counts)', async () => {
    const token = await signTenantToken({ tenantId: TENANT }, SECRET);
    const res = await fetch(`${base}/whoami?tenantId=99999999-9999-9999-9999-999999999999`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': '99999999-9999-9999-9999-999999999999',
      },
    });
    const body = (await res.json()) as { tenant?: { tenantId: string } };
    expect(body.tenant?.tenantId).toBe(TENANT);
  });
});
