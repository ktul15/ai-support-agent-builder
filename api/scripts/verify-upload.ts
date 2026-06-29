/**
 * End-to-end proof of the document upload endpoint (issue #12).
 *
 * Drives the real app over HTTP: signup -> seed an assistant (owner) -> multipart
 * upload. Asserts the file lands in object storage at the per-tenant key, the
 * document row is UPLOADED, an ingest job is enqueued in BullMQ, and a
 * cross-tenant assistant is rejected. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-upload.ts   (needs `npm run db:up`: postgres + redis + minio)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { getConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { disconnectDb } from '../src/db.js';
import { createStorage } from '../src/storage/index.js';
import { BullIngestQueue, INGEST_QUEUE_NAME } from '../src/queue/index.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed/inspect');

const appConfig = getConfig();
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } }); // bypasses RLS
const storage = createStorage(appConfig);
const queue = new BullIngestQueue(appConfig.REDIS_URL);
const inspect = new Queue(INGEST_QUEUE_NAME, {
  connection: new Redis(appConfig.REDIS_URL, { maxRetriesPerRequest: null }),
});

let failures = 0;
const tenants: string[] = [];
const keys: string[] = [];
const jobIds: string[] = [];
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

async function main() {
  const app = createApp({ storage, queue, maxBytes: appConfig.UPLOAD_MAX_BYTES });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  // Signup -> token + tenant.
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

  // Seed an assistant for this tenant (no assistant-create endpoint yet).
  const assistantId = randomUUID();
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;

  const uploadForm = new FormData();
  uploadForm.append('assistantId', assistantId);
  uploadForm.append(
    'file',
    new Blob(['hello document body'], { type: 'application/pdf' }),
    'doc.pdf',
  );
  const upRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: uploadForm,
  });
  const upBody = (await upRes.json()) as { documentId?: string; status?: string };
  check(
    'upload returns 201 + UPLOADED',
    upRes.status === 201 && upBody.status === 'UPLOADED',
    `status ${upRes.status}`,
  );
  const documentId = upBody.documentId!;
  if (documentId) {
    jobIds.push(documentId);
    keys.push(`tenants/${tenantId}/${documentId}/original`);
  }

  // Document row exists, UPLOADED, correct key + sourceType (owner-inspected).
  const rows = await owner.$queryRaw<
    { status: string; storage_key: string; source_type: string }[]
  >`
    SELECT status, storage_key, source_type FROM document WHERE id = ${documentId}::uuid`;
  const row = rows[0];
  check(
    'document row is UPLOADED with the per-tenant key and PDF type',
    !!row &&
      row.status === 'UPLOADED' &&
      row.storage_key === `tenants/${tenantId}/${documentId}/original` &&
      row.source_type === 'PDF',
    row ? `${row.status} ${row.source_type}` : 'no row',
  );

  // The raw bytes are actually in object storage.
  check(
    'raw file is in object storage',
    await storage.exists(`tenants/${tenantId}/${documentId}/original`),
  );

  // An ingest job was enqueued (jobId = documentId).
  const job = await inspect.getJob(documentId);
  check('an ingest job was enqueued', !!job && job.data.documentId === documentId);

  // Cross-tenant assistant is rejected (assistant not in this tenant -> 404).
  const otherForm = new FormData();
  otherForm.append('assistantId', randomUUID());
  otherForm.append('file', new Blob(['x'], { type: 'application/pdf' }), 'x.pdf');
  const badRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: otherForm,
  });
  check(
    'upload to a non-tenant assistant is 404',
    badRes.status === 404,
    `status ${badRes.status}`,
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
      for (const id of jobIds) await inspect.remove(id);
      for (const key of keys) await storage.delete(key);
      for (const t of tenants) await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`;
    } catch (e) {
      console.warn('cleanup failed (non-fatal):', e);
    }
    await queue.close();
    await inspect.close();
    await disconnectDb();
    await owner.$disconnect();
    console.log(
      failures === 0 ? '\nUpload: ALL CHECKS PASSED' : `\nUpload: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
