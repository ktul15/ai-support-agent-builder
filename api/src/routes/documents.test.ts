import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { documentsRouter, type UploadDeps } from './documents.js';
import { makeTenantContext } from '../middleware/tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';
import { MemoryStorage } from '../storage/memory-storage.js';

// These cases all reject BEFORE any DB/storage/queue work, so no infra is
// needed — the full happy path is proven in scripts/verify-upload.ts.
const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';

function makeApp(maxBytes = 1024 * 1024): express.Express {
  const deps: UploadDeps = {
    storage: new MemoryStorage(),
    queue: { enqueue: () => Promise.resolve(), close: () => Promise.resolve() },
    maxBytes,
  };
  const app = express();
  app.use(documentsRouter(deps, makeTenantContext(SECRET)));
  return app;
}

let server: Server;
let smallServer: Server;
let base: string;
let smallBase: string;

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  ({ server, base } = await listen(makeApp()));
  ({ server: smallServer, base: smallBase } = await listen(makeApp(10)));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => smallServer.close(() => r()));
});

function token(): Promise<string> {
  return signTenantToken({ tenantId: TENANT }, SECRET);
}

function form(parts: { assistantId?: string; file?: { name: string; bytes: number } }): FormData {
  const fd = new FormData();
  if (parts.assistantId !== undefined) fd.append('assistantId', parts.assistantId);
  if (parts.file) {
    fd.append(
      'file',
      new Blob(['x'.repeat(parts.file.bytes)], { type: 'application/octet-stream' }),
      parts.file.name,
    );
  }
  return fd;
}

describe('POST /documents (validation)', () => {
  it('401s without a token', async () => {
    const res = await fetch(`${base}/documents`, {
      method: 'POST',
      body: form({ assistantId: ASSISTANT, file: { name: 'a.pdf', bytes: 4 } }),
    });
    expect(res.status).toBe(401);
  });

  it('400s when assistantId is missing', async () => {
    const res = await fetch(`${base}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: form({ file: { name: 'a.pdf', bytes: 4 } }),
    });
    expect(res.status).toBe(400);
  });

  it('400s when no file is attached', async () => {
    const res = await fetch(`${base}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: form({ assistantId: ASSISTANT }),
    });
    expect(res.status).toBe(400);
  });

  it('415s on an unsupported file type', async () => {
    const res = await fetch(`${base}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: form({ assistantId: ASSISTANT, file: { name: 'malware.exe', bytes: 4 } }),
    });
    expect(res.status).toBe(415);
  });

  it('413s when the file exceeds the size limit', async () => {
    const res = await fetch(`${smallBase}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: form({ assistantId: ASSISTANT, file: { name: 'big.pdf', bytes: 1000 } }),
    });
    expect(res.status).toBe(413);
  });
});

describe('GET /documents (validation)', () => {
  it('401s the list without a token', async () => {
    expect((await fetch(`${base}/documents?assistantId=${ASSISTANT}`)).status).toBe(401);
  });

  it('400s the list when assistantId is missing or not a uuid', async () => {
    const auth = { authorization: `Bearer ${await token()}` };
    expect((await fetch(`${base}/documents`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/documents?assistantId=nope`, { headers: auth })).status).toBe(400);
  });

  it('400s a single document with a non-uuid id', async () => {
    const res = await fetch(`${base}/documents/not-a-uuid`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('400s the events stream with a non-uuid id', async () => {
    const res = await fetch(`${base}/documents/not-a-uuid/events`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});
