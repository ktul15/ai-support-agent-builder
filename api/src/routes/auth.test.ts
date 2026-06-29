import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp, type AppDeps } from '../app.js';
import { MemoryStorage } from '../storage/memory-storage.js';

// Fake deps so createApp doesn't reach for config / Redis / S3 in unit tests.
const testDeps: AppDeps = {
  storage: new MemoryStorage(),
  queue: { enqueue: () => Promise.resolve(), close: () => Promise.resolve() },
  maxBytes: 1024 * 1024,
};

// Validation-only tests: malformed bodies are rejected BEFORE any DB call, so
// these run without a database. The full signup/login round-trip against the
// SECURITY DEFINER functions is proven in scripts/verify-auth.ts.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp(testDeps).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('auth routes (validation)', () => {
  it('400s signup with an empty body', async () => {
    expect((await post('/auth/signup', {})).status).toBe(400);
  });

  it('400s signup with an invalid email', async () => {
    const res = await post('/auth/signup', {
      tenantName: 'Acme',
      email: 'not-an-email',
      password: 'longenough',
    });
    expect(res.status).toBe(400);
  });

  it('400s signup with too-short a password', async () => {
    const res = await post('/auth/signup', {
      tenantName: 'Acme',
      email: 'owner@acme.test',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('400s login with a missing password', async () => {
    expect((await post('/auth/login', { email: 'owner@acme.test' })).status).toBe(400);
  });
});
