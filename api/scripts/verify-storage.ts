/**
 * Live round-trip proof of object storage (issue #11) against MinIO.
 *
 * Builds the real S3Storage from .env, ensures the bucket, uploads an object at
 * the canonical per-tenant key, fetches it back THROUGH A SIGNED URL over HTTP
 * (proving reads need a signature, not a public URL), asserts the bytes match,
 * then deletes it. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-storage.ts   (reads S3_* from .env; needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Storage } from '../src/storage/s3-storage.js';
import { tenantObjectKey } from '../src/storage/object-key.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const required = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];
for (const k of required) {
  if (!process.env[k]) throw new Error(`${k} required (configure MinIO in .env)`);
}

const storage = new S3Storage({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION!,
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
});

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

async function main() {
  await storage.ensureBucket();

  const tenantId = randomUUID();
  const documentId = randomUUID();
  const key = tenantObjectKey(tenantId, documentId);
  check('key uses the per-tenant prefix', key === `tenants/${tenantId}/${documentId}/original`);

  const payload = `secret-contents-${randomUUID()}`;
  await storage.put({ key, body: Buffer.from(payload), contentType: 'text/plain' });
  check('object exists after upload', await storage.exists(key));

  // Read MUST go through a signed URL — fetch it over HTTP and compare bytes.
  const url = await storage.signedReadUrl(key, 120);
  check('signed URL is signed (carries a signature)', /X-Amz-Signature=/.test(url));
  const res = await fetch(url);
  const body = await res.text();
  check(
    'signed URL returns the exact bytes',
    res.status === 200 && body === payload,
    `status ${res.status}`,
  );

  // The same object path without a signature must NOT be publicly readable.
  const unsigned = url.split('?')[0]!;
  const anon = await fetch(unsigned);
  check(
    'unsigned URL is denied (private bucket)',
    anon.status === 403 || anon.status === 401,
    `status ${anon.status}`,
  );

  await storage.delete(key);
  check('object is gone after delete', !(await storage.exists(key)));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    console.log(
      failures === 0 ? '\nStorage: ALL CHECKS PASSED' : `\nStorage: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
