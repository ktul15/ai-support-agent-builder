/**
 * End-to-end proof of the tenant-context middleware (issue #9).
 *
 * Stands up a real Express app guarded by the actual `makeTenantContext`
 * middleware, where the route counts chunks through the actual `withTenant`
 * helper. Seeds two tenants (as the owner, bypassing RLS), then drives the app
 * over HTTP with signed tokens and asserts each tenant sees ONLY its own rows —
 * proving the full path: JWT -> SET LOCAL app.tenant_id -> RLS. Exits non-zero
 * on any failure.
 *
 *   DATABASE_URL=<asab_app>  DIRECT_DATABASE_URL=<owner>  tsx scripts/verify-tenant.ts
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { withTenant, disconnectDb } from '../src/db.js';
import { makeTenantContext, requireTenant } from '../src/middleware/tenant-context.js';
import { signTenantToken } from '../src/auth/tenant-token.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET required');

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } }); // bypasses RLS

const A = randomUUID();
const B = randomUUID();

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

/** Seed a tenant with `count` chunks, as the owner (RLS-bypassing). */
async function seed(tenantId: string, count: number): Promise<void> {
  const asst = randomUUID();
  const doc = randomUUID();
  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantId}::uuid, 'T')`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${asst}::uuid, ${tenantId}::uuid, 'A', now())`;
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,updated_at) VALUES (${doc}::uuid, ${tenantId}::uuid, ${asst}::uuid, 'D', 'PDF', 'k', now())`;
  for (let i = 0; i < count; i++) {
    await owner.$executeRaw`INSERT INTO chunk (id,tenant_id,document_id,assistant_id,content,token_count,content_hash) VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${doc}::uuid, ${asst}::uuid, 'secret', 1, ${randomUUID()})`;
  }
}

async function main() {
  await seed(A, 2);
  await seed(B, 3);

  // Real app: real middleware guards a route that counts via real withTenant.
  const app = express();
  app.use(makeTenantContext(SECRET!));
  app.get('/chunks', (req, res) => {
    withTenant(requireTenant(req).tenantId, async (tx) => {
      const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM chunk`;
      return Number(r[0]!.n);
    })
      .then((count) => res.json({ count }))
      .catch((e) => res.status(500).json({ error: String(e) }));
  });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const countFor = async (tenantId: string): Promise<number> => {
    const token = await signTenantToken({ tenantId }, SECRET!);
    const res = await fetch(`${base}/chunks`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { count: number };
    return body.count;
  };

  // 1. Each tenant sees exactly its own rows through the full HTTP path.
  const seenA = await countFor(A);
  check('tenant A sees only its own chunks', seenA === 2, `saw ${seenA}`);
  const seenB = await countFor(B);
  check('tenant B sees only its own chunks', seenB === 3, `saw ${seenB}`);

  // 2. No token -> 401, no tenant context ever established.
  const noAuth = await fetch(`${base}/chunks`);
  check(
    'request without a token is rejected (401)',
    noAuth.status === 401,
    `status ${noAuth.status}`,
  );

  await new Promise<void>((r) => server.close(() => r()));
  // Teardown must not mask the isolation result: a cleanup error (e.g. a missing
  // FK cascade) is logged, not counted as a failure of the checks above.
  try {
    await owner.$executeRaw`DELETE FROM tenant WHERE id IN (${A}::uuid, ${B}::uuid)`;
  } catch (e) {
    console.warn('cleanup failed (non-fatal):', e);
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await disconnectDb();
    await owner.$disconnect();
    console.log(
      failures === 0
        ? '\nTenant-context isolation: ALL CHECKS PASSED'
        : `\nTenant-context isolation: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
