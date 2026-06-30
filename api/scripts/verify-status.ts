/**
 * End-to-end proof of ingestion status + progress (issue #18).
 *
 * Uploads documents, runs the real worker, then exercises the status surface:
 * the single/list status endpoints (status + chunk count), the SSE progress
 * stream, a FAILED document's sanitized (leak-free) error, and the stuck-doc
 * reconciler. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-status.ts   (needs `npm run db:up`: postgres + redis + minio)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { disconnectDb } from '../src/db.js';
import { S3Storage } from '../src/storage/index.js';
import { BullIngestQueue } from '../src/queue/index.js';
import { createIngestWorker } from '../src/worker/ingest-worker.js';
import { PrismaDocumentStatusStore } from '../src/worker/document-store.js';
import { reconcileStuckDocuments } from '../src/worker/reconciler.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed/inspect');

const appConfig = getConfig();
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const storage = new S3Storage({
  endpoint: appConfig.S3_ENDPOINT,
  region: appConfig.S3_REGION!,
  bucket: appConfig.S3_BUCKET!,
  accessKeyId: appConfig.S3_ACCESS_KEY_ID!,
  secretAccessKey: appConfig.S3_SECRET_ACCESS_KEY!,
});
const queue = new BullIngestQueue(appConfig.REDIS_URL);
const workerHandle = createIngestWorker({
  redisUrl: appConfig.REDIS_URL,
  store: new PrismaDocumentStatusStore(),
  storage,
  embedder: new FakeEmbedder(),
  concurrency: 2,
});

let failures = 0;
const tenants: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fixture = (name: string): Buffer =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures', name));

async function main() {
  await storage.ensureBucket();
  const app = createApp({ storage, queue, maxBytes: appConfig.UPLOAD_MAX_BYTES });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const email = `owner-${randomUUID()}@acme.test`;
  const signupRes = await fetch(`${base}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantName: 'Acme', email, password: 'correct horse battery staple' }),
  });
  const { token } = (await signupRes.json()) as { token: string };
  const tenantId = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    .tid as string;
  tenants.push(tenantId);
  const assistantId = randomUUID();
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;
  const auth = { authorization: `Bearer ${token}` };

  const upload = async (file: string, type: string, name: string): Promise<string> => {
    const fd = new FormData();
    fd.append('assistantId', assistantId);
    fd.append('file', new Blob([fixture(file)], { type }), name);
    const res = await fetch(`${base}/documents`, { method: 'POST', headers: auth, body: fd });
    return ((await res.json()) as { documentId: string }).documentId;
  };
  const waitView = async (id: string, status: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/documents/${id}`, { headers: auth });
      const view = (await res.json()) as {
        status: string;
        chunkCount: number;
        error: string | null;
      };
      if (view.status === status) return view;
      await sleep(250);
    }
    return null;
  };

  // 1. Happy path: status endpoint shows READY + chunk count, no error.
  const goodId = await upload('sample.pdf', 'application/pdf', 'good.pdf');
  const readyView = await waitView(goodId, 'READY');
  check(
    'GET /documents/:id reports READY with a chunk count and no error',
    !!readyView && readyView.chunkCount >= 1 && readyView.error === null,
    readyView ? `status=${readyView.status} chunks=${readyView.chunkCount}` : 'timeout',
  );

  // 2. List endpoint includes the document.
  const listRes = await fetch(`${base}/documents?assistantId=${assistantId}`, { headers: auth });
  const list = (await listRes.json()) as { documents: { id: string }[] };
  check(
    'GET /documents lists the document',
    list.documents.some((d) => d.id === goodId),
  );

  // 3. SSE progress stream emits a status event then done (on the READY doc it
  //    immediately reports READY + done).
  const sseText = await readSse(`${base}/documents/${goodId}/events`, token);
  check(
    'SSE /events streams a status event and a done event',
    sseText.includes('event: status') &&
      sseText.includes('"status":"READY"') &&
      sseText.includes('event: done'),
    sseText.replace(/\n/g, ' ').slice(0, 60),
  );

  // 4. A scanned/no-text PDF fails — the surfaced error is friendly, not raw.
  const badId = await upload('lowtext.pdf', 'application/pdf', 'scan.pdf');
  const failedView = await waitView(badId, 'FAILED');
  check(
    'FAILED document surfaces a sanitized (leak-free) error',
    !!failedView &&
      failedView.error !== null &&
      /scanned|image-only|failed/i.test(failedView.error) &&
      !failedView.error.includes('tenants/'),
    failedView?.error ?? 'timeout',
  );

  // 5. Reconciler: a document stuck in PARSING (old updated_at) is swept to FAILED.
  const stuckId = randomUUID();
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${stuckId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'stuck', 'PDF', 'k', 'PARSING', now() - interval '1 hour')`;
  const fixed = await reconcileStuckDocuments(15 * 60);
  const stuckRow = await owner.$queryRaw<
    { status: string; error: string | null }[]
  >`SELECT status, error FROM document WHERE id = ${stuckId}::uuid`;
  check(
    'reconciler marks a stuck document FAILED',
    fixed >= 1 && stuckRow[0]?.status === 'FAILED' && !!stuckRow[0]?.error,
    `fixed=${fixed} status=${stuckRow[0]?.status}`,
  );

  // 6. A freshly-heartbeated EMBEDDING doc (recent updated_at) must NOT be swept —
  //    this is what per-batch heartbeating protects (a long live embed stays live).
  const liveId = randomUUID();
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${liveId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'live', 'PDF', 'k', 'EMBEDDING', now())`;
  await reconcileStuckDocuments(15 * 60);
  const liveRow = await owner.$queryRaw<
    { status: string }[]
  >`SELECT status FROM document WHERE id = ${liveId}::uuid`;
  check(
    'reconciler leaves a freshly-updated EMBEDDING document alone',
    liveRow[0]?.status === 'EMBEDDING',
    `status=${liveRow[0]?.status}`,
  );

  await new Promise<void>((r) => server.close(() => r()));
}

async function readSse(url: string, token: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text = '';
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      if (text.includes('event: done')) break;
    }
  } catch {
    // aborted or closed — return what we have
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return text;
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    try {
      for (const t of tenants) await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`;
    } catch (e) {
      console.warn('cleanup failed (non-fatal):', e);
    }
    await workerHandle.shutdown();
    await queue.close();
    await disconnectDb();
    await owner.$disconnect();
    console.log(
      failures === 0 ? '\nStatus: ALL CHECKS PASSED' : `\nStatus: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
