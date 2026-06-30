/**
 * End-to-end proof of the ingestion worker + job lifecycle (issue #13).
 *
 * Uploads a real document (via the #12 endpoint), starts the real worker, and
 * waits for the document to reach READY — proving the worker consumes the queue
 * and advances the lifecycle. Then enqueues a job whose raw object is missing
 * and asserts it ends FAILED with an error. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-worker.ts   (needs `npm run db:up`: postgres + redis + minio)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { getConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { disconnectDb } from '../src/db.js';
import { S3Storage } from '../src/storage/index.js';
import { BullIngestQueue, INGEST_QUEUE_NAME } from '../src/queue/index.js';
import { createIngestWorker } from '../src/worker/ingest-worker.js';
import { PrismaDocumentStatusStore } from '../src/worker/document-store.js';

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
const rawConnection = new Redis(appConfig.REDIS_URL, { maxRetriesPerRequest: null });
const rawQueue = new Queue(INGEST_QUEUE_NAME, { connection: rawConnection });
const workerHandle = createIngestWorker({
  redisUrl: appConfig.REDIS_URL,
  store: new PrismaDocumentStatusStore(),
  storage,
  concurrency: 2,
});

let failures = 0;
const tenants: string[] = [];
const jobIds: string[] = [];
const keys: string[] = [];
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(
  documentId: string,
  target: string,
  timeoutMs = 20_000,
): Promise<{ status: string; error: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await owner.$queryRaw<
      { status: string; error: string | null }[]
    >`SELECT status, error FROM document WHERE id = ${documentId}::uuid`;
    if (rows[0]?.status === target) return rows[0];
    await sleep(250);
  }
  return null;
}

async function main() {
  await storage.ensureBucket();
  const app = createApp({ storage, queue, maxBytes: appConfig.UPLOAD_MAX_BYTES });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  // Signup + seed assistant.
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

  // Happy path: upload a REAL pdf -> worker parses it -> READY.
  const pdfBytes = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/sample.pdf'),
  );
  const fd = new FormData();
  fd.append('assistantId', assistantId);
  fd.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'doc.pdf');
  const upRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  const { documentId } = (await upRes.json()) as { documentId: string };
  jobIds.push(documentId);
  keys.push(`tenants/${tenantId}/${documentId}/original`);

  const ok = await waitForStatus(documentId, 'READY');
  check(
    'worker consumes the job and advances the document to READY',
    ok?.status === 'READY',
    ok?.status ?? 'timeout',
  );

  // The parse stage persisted the page count from the real PDF.
  const pc = await owner.$queryRaw<
    { page_count: number | null }[]
  >`SELECT page_count FROM document WHERE id = ${documentId}::uuid`;
  check(
    'parse stage recorded the page count',
    pc[0]?.page_count === 1,
    `page_count=${pc[0]?.page_count}`,
  );

  // Chunks were persisted with a real sha256 content_hash and NO embedding yet
  // (that's #17). A sample hash must be 64 hex chars; embedding count must be 0.
  const chunkStats = await owner.$queryRaw<
    { n: number; embedded: number; sample_hash: string | null }[]
  >`SELECT count(*)::int AS n, count(embedding)::int AS embedded, min(content_hash) AS sample_hash
    FROM chunk WHERE document_id = ${documentId}::uuid`;
  const cs = chunkStats[0]!;
  check(
    'chunks persisted with a sha256 content_hash, no embedding yet',
    cs.n >= 1 && cs.embedded === 0 && /^[0-9a-f]{64}$/.test(cs.sample_hash ?? ''),
    `n=${cs.n} embedded=${cs.embedded} hash=${cs.sample_hash?.slice(0, 12)}…`,
  );

  // Dedup: re-run parse on the SAME document (force it back to UPLOADED) — the
  // content_hash unique must skip every chunk, leaving the count unchanged.
  await owner.$executeRaw`UPDATE document SET status = 'UPLOADED' WHERE id = ${documentId}::uuid`;
  const dedupJobId = randomUUID();
  jobIds.push(dedupJobId);
  await rawQueue.add(
    'ingest',
    { documentId, tenantId, assistantId },
    { jobId: dedupJobId, attempts: 1 },
  );
  const reParsed = await waitForStatus(documentId, 'READY'); // must actually re-run, not fail early
  const afterDedup = await owner.$queryRaw<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM chunk WHERE document_id = ${documentId}::uuid`;
  check(
    're-parsing the same document inserts no duplicate chunks',
    reParsed?.status === 'READY' && afterDedup[0]!.n === cs.n,
    `reparsed=${reParsed?.status} before=${cs.n} after=${afterDedup[0]!.n}`,
  );

  // Idempotency against the REAL Prisma store: re-enqueue the same (now READY)
  // document under a fresh jobId; the worker must process it and leave it READY.
  const reJobId = randomUUID();
  jobIds.push(reJobId);
  await rawQueue.add(
    'ingest',
    { documentId, tenantId, assistantId },
    { jobId: reJobId, attempts: 1 },
  );
  let reDone = false;
  const reDeadline = Date.now() + 10_000;
  while (Date.now() < reDeadline) {
    const job = await rawQueue.getJob(reJobId);
    if (job && (await job.getState()) === 'completed') {
      reDone = true;
      break;
    }
    await sleep(200);
  }
  const afterRe = await owner.$queryRaw<
    { status: string }[]
  >`SELECT status FROM document WHERE id = ${documentId}::uuid`;
  check(
    're-enqueuing a READY document is an idempotent no-op',
    reDone && afterRe[0]?.status === 'READY',
    afterRe[0]?.status ?? 'unknown',
  );

  // Failure path: a document whose raw object is missing -> FAILED + error.
  const missingDocId = randomUUID();
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${missingDocId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'missing', 'PDF', ${`tenants/${tenantId}/${missingDocId}/original`}, 'UPLOADED', now())`;
  jobIds.push(missingDocId);
  await rawQueue.add(
    'ingest',
    { documentId: missingDocId, tenantId, assistantId },
    { jobId: missingDocId, attempts: 1 },
  );

  const failed = await waitForStatus(missingDocId, 'FAILED');
  check(
    'a job whose object is missing ends FAILED with an error',
    failed?.status === 'FAILED' && !!failed.error,
    failed ? `${failed.status}: ${failed.error?.slice(0, 40)}` : 'timeout',
  );

  // Scanned / no-text PDF: parses but yields no text -> FAILED (not silently READY).
  const scannedBytes = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/lowtext.pdf'),
  );
  const scannedForm = new FormData();
  scannedForm.append('assistantId', assistantId);
  scannedForm.append('file', new Blob([scannedBytes], { type: 'application/pdf' }), 'scan.pdf');
  const scanRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: scannedForm,
  });
  const scanned = (await scanRes.json()) as { documentId: string };
  jobIds.push(scanned.documentId);
  keys.push(`tenants/${tenantId}/${scanned.documentId}/original`);
  const scannedFailed = await waitForStatus(scanned.documentId, 'FAILED');
  check(
    'a scanned/no-text PDF ends FAILED (not silently READY)',
    scannedFailed?.status === 'FAILED' && !!scannedFailed.error,
    scannedFailed ? scannedFailed.error?.slice(0, 40) : 'timeout',
  );

  await new Promise<void>((r) => server.close(() => r()));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    try {
      for (const id of jobIds) {
        await rawQueue.remove(id).catch(() => {});
      }
      for (const key of keys) await storage.delete(key).catch(() => {});
      for (const t of tenants) await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`;
    } catch (e) {
      console.warn('cleanup failed (non-fatal):', e);
    }
    await workerHandle.shutdown();
    await queue.close();
    await rawQueue.close();
    await rawConnection.quit();
    await disconnectDb();
    await owner.$disconnect();
    console.log(
      failures === 0 ? '\nWorker: ALL CHECKS PASSED' : `\nWorker: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
