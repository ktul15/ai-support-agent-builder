import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { assistantsRouter } from './assistants.js';
import { makeTenantContext } from '../middleware/tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';

// Auth + validation rejections need no DB; the authed list/patch are proven in
// scripts/verify-auth.ts and scripts/verify-playground.ts.
const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const ASSISTANT = '33333333-3333-3333-3333-333333333333';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(assistantsRouter(makeTenantContext(SECRET)));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

const adminToken = (): Promise<string> => signTenantToken({ tenantId: TENANT, userId: USER }, SECRET);
const consumerToken = (): Promise<string> =>
  signTenantToken({ tenantId: TENANT, assistantId: ASSISTANT }, SECRET);

describe('GET /assistants (access)', () => {
  it('401s without a token', async () => {
    expect((await fetch(`${base}/assistants`)).status).toBe(401);
  });
  it('403s a consumer (assistant-scoped) token', async () => {
    const res = await fetch(`${base}/assistants`, {
      headers: { authorization: `Bearer ${await consumerToken()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /assistants/:id (access + validation)', () => {
  const patch = (id: string, body: unknown, token?: string): Promise<Response> =>
    fetch(`${base}/assistants/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('401s without a token', async () => {
    expect((await patch(ASSISTANT, { refusalThreshold: 0.5 })).status).toBe(401);
  });
  it('403s a consumer token', async () => {
    expect((await patch(ASSISTANT, { refusalThreshold: 0.5 }, await consumerToken())).status).toBe(
      403,
    );
  });
  it('400s a non-uuid id (admin)', async () => {
    expect((await patch('nope', { refusalThreshold: 0.5 }, await adminToken())).status).toBe(400);
  });
  it('400s an out-of-range threshold (admin)', async () => {
    expect((await patch(ASSISTANT, { refusalThreshold: 1.5 }, await adminToken())).status).toBe(400);
    expect((await patch(ASSISTANT, { refusalThreshold: -0.1 }, await adminToken())).status).toBe(
      400,
    );
  });
});
