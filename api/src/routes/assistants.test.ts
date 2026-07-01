import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { assistantsRouter } from './assistants.js';
import { makeTenantContext } from '../middleware/tenant-context.js';

// The unauthenticated rejection needs no DB; the authed listing is proven in
// scripts/verify-auth.ts.
const SECRET = 'test-secret-at-least-32-characters-long-xx';

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

describe('GET /assistants', () => {
  it('401s without a token', async () => {
    const res = await fetch(`${base}/assistants`);
    expect(res.status).toBe(401);
  });
});
