import { describe, expect, it, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { documentsRouter, type UploadDeps } from './documents.js';
import { makeTenantContext } from '../middleware/tenant-context.js';
import { signTenantToken } from '../auth/tenant-token.js';

// Mock the DB layer so the handler's branching logic (assistant lookup -> 404 vs
// create + enqueue) is testable without Postgres. The REAL RLS scoping is proven
// in scripts/verify-upload.ts; this guards the short-circuit + no-orphan behavior.
vi.mock('../db.js', () => ({ withTenant: vi.fn() }));
const { withTenant } = await import('../db.js');
const withTenantMock = withTenant as unknown as Mock;

const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';

const putSpy = vi.fn(() => Promise.resolve());
const enqueueSpy = vi.fn(() => Promise.resolve());

const deps: UploadDeps = {
  storage: {
    put: putSpy,
    signedReadUrl: () => Promise.resolve(''),
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
  },
  queue: { enqueue: enqueueSpy, close: () => Promise.resolve() },
  maxBytes: 1024 * 1024,
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(documentsRouter(deps, makeTenantContext(SECRET)));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  withTenantMock.mockReset();
  putSpy.mockClear();
  enqueueSpy.mockClear();
});

async function upload(): Promise<Response> {
  const fd = new FormData();
  fd.append('assistantId', ASSISTANT);
  fd.append('file', new Blob(['body'], { type: 'application/pdf' }), 'doc.pdf');
  return fetch(`${base}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await signTenantToken({ tenantId: TENANT }, SECRET)}` },
    body: fd,
  });
}

describe('POST /documents (handler logic)', () => {
  it('404s and stores nothing when the assistant is not in the tenant', async () => {
    withTenantMock.mockResolvedValueOnce(null); // assistant lookup -> not found
    const res = await upload();
    expect(res.status).toBe(404);
    expect(putSpy).not.toHaveBeenCalled(); // no orphan object
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('stores, records, and enqueues on the happy path', async () => {
    withTenantMock
      .mockResolvedValueOnce({ id: ASSISTANT }) // assistant lookup ok
      .mockResolvedValueOnce({}); // document.create ok
    const res = await upload();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'UPLOADED' });
    expect(putSpy).toHaveBeenCalledOnce();
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(enqueueSpy.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      assistantId: ASSISTANT,
    });
  });
});
