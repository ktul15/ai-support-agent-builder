import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { chatRouter, type ChatDeps } from './chat.js';
import { makeTenantContext } from '../middleware/tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';

// These cases all reject BEFORE any retrieval/generation/DB work (auth + body
// validation), so no infra is needed — the streaming happy path is proven in
// scripts/verify-chat.ts.
const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';

// Stubs that throw if reached — proves the request was rejected before use.
const deps: ChatDeps = {
  retrieval: {
    retrieve: () => {
      throw new Error('retrieval should not run for a rejected request');
    },
  },
  generation: {
    stream: () => {
      throw new Error('generation should not run for a rejected request');
    },
  },
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter(deps, makeTenantContext(SECRET)));
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = makeApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

const token = (): Promise<string> => signTenantToken({ tenantId: TENANT }, SECRET);

async function post(body: unknown, auth = true): Promise<Response> {
  return fetch(`${base}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${await token()}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /chat (rejections)', () => {
  it('401s without a token', async () => {
    const res = await post({ assistantId: ASSISTANT, question: 'hi' }, false);
    expect(res.status).toBe(401);
  });

  it('400s on a non-uuid assistantId', async () => {
    const res = await post({ assistantId: 'not-a-uuid', question: 'hi' });
    expect(res.status).toBe(400);
  });

  it('400s on a missing question', async () => {
    const res = await post({ assistantId: ASSISTANT });
    expect(res.status).toBe(400);
  });

  it('400s on an empty question', async () => {
    const res = await post({ assistantId: ASSISTANT, question: '   ' });
    expect(res.status).toBe(400);
  });

  it('400s on an over-long question', async () => {
    const res = await post({ assistantId: ASSISTANT, question: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });
});
