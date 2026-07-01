import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { playgroundRouter, type PlaygroundDeps } from './playground.js';
import { makeTenantContext } from '../middleware/tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';

// All cases reject before any retrieval/DB work (auth + admin gate + validation),
// so no infra — the happy path is proven in scripts/verify-playground.ts.
const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const ASSISTANT = '33333333-3333-3333-3333-333333333333';

const deps: PlaygroundDeps = {
  limits: { contextTokenBudget: 2000, maxOutputTokens: 2048 },
  retrieval: {
    retrieve: () => {
      throw new Error('retrieval should not run for a rejected request');
    },
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(playgroundRouter(deps, makeTenantContext(SECRET)));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

async function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/playground/retrieve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const adminToken = (): Promise<string> =>
  signTenantToken({ tenantId: TENANT, userId: USER }, SECRET);
const consumerToken = (): Promise<string> =>
  signTenantToken({ tenantId: TENANT, assistantId: ASSISTANT }, SECRET);

describe('POST /playground/retrieve (access + validation)', () => {
  it('401s without a token', async () => {
    const res = await post({ assistantId: ASSISTANT, question: 'hi' });
    expect(res.status).toBe(401);
  });

  it('403s for a consumer (assistant-scoped) token — admin only', async () => {
    const res = await post({ assistantId: ASSISTANT, question: 'hi' }, await consumerToken());
    expect(res.status).toBe(403);
  });

  it('400s on a non-uuid assistantId (admin)', async () => {
    const res = await post({ assistantId: 'nope', question: 'hi' }, await adminToken());
    expect(res.status).toBe(400);
  });

  it('400s on an empty question (admin)', async () => {
    const res = await post({ assistantId: ASSISTANT, question: '  ' }, await adminToken());
    expect(res.status).toBe(400);
  });

  it('400s on an out-of-range k (admin)', async () => {
    const res = await post({ assistantId: ASSISTANT, question: 'hi', k: 999 }, await adminToken());
    expect(res.status).toBe(400);
  });
});
