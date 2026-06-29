/**
 * Live, adversarial proof of tenant isolation via Row-Level Security.
 *
 * Seeds two tenants (as the OWNER, which bypasses RLS), then queries as the
 * restricted `asab_app` role with a tenant context set, and asserts a tenant can
 * NEVER see another tenant's rows — and that an unscoped query sees nothing
 * (fail-closed). Exits non-zero on any failure.
 *
 *   DATABASE_URL=<asab_app>  DIRECT_DATABASE_URL=<owner>  tsx scripts/verify-rls.ts
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

// Load the repo-root .env so DATABASE_URL (asab_app, runtime) and
// DIRECT_DATABASE_URL (owner, for seeding) are available standalone.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } }); // bypasses RLS
const app = new PrismaClient(); // connects as asab_app (DATABASE_URL) — RLS applies

const A = randomUUID();
const B = randomUUID();
const asstA = randomUUID();
const asstB = randomUUID();

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

/** Run a query as a given tenant context inside one transaction (the #9 pattern). */
async function asTenant<T>(
  tenantId: string | null,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return app.$transaction(async (tx) => {
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

async function countChunks(tx: PrismaClient): Promise<number> {
  const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM chunk`;
  return Number(r[0]!.n);
}

async function main() {
  // Seed two isolated tenants as the owner (RLS-bypassing).
  for (const [t, asst, hash] of [
    [A, asstA, 'hashA'],
    [B, asstB, 'hashB'],
  ] as const) {
    const doc = randomUUID();
    await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${t}::uuid, 'T')`;
    await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${asst}::uuid, ${t}::uuid, 'A', now())`;
    await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,updated_at) VALUES (${doc}::uuid, ${t}::uuid, ${asst}::uuid, 'D', 'PDF', 'k', now())`;
    await owner.$executeRaw`INSERT INTO chunk (id,tenant_id,document_id,assistant_id,content,token_count,content_hash) VALUES (${randomUUID()}::uuid, ${t}::uuid, ${doc}::uuid, ${asst}::uuid, 'secret', 1, ${hash})`;
  }

  // 1. Tenant A sees exactly its own chunk.
  const seenByA = await asTenant(A, countChunks);
  check('tenant A sees only its own chunk', seenByA === 1, `saw ${seenByA}`);

  // 2. Tenant A cannot see tenant B's chunk by any means.
  const bVisibleToA = await asTenant(A, async (tx) => {
    const r = await tx.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM chunk WHERE tenant_id = ${B}::uuid`;
    return Number(r[0]!.n);
  });
  check('tenant A cannot see tenant B rows', bVisibleToA === 0, `saw ${bVisibleToA}`);

  // 3. Unscoped query (no tenant context) is fail-closed.
  const unscoped = await asTenant(null, countChunks);
  check('unscoped query sees nothing (fail-closed)', unscoped === 0, `saw ${unscoped}`);

  // 4. WITH CHECK blocks writing a row for another tenant.
  let writeBlocked = false;
  try {
    await asTenant(A, async (tx) => {
      const doc = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM document LIMIT 1`)[0]!.id;
      await tx.$executeRaw`INSERT INTO chunk (id,tenant_id,document_id,assistant_id,content,token_count,content_hash) VALUES (${randomUUID()}::uuid, ${B}::uuid, ${doc}::uuid, ${asstB}::uuid, 'x', 1, ${'h' + randomUUID()})`;
    });
  } catch {
    writeBlocked = true;
  }
  check('WITH CHECK blocks cross-tenant insert', writeBlocked);

  // Cleanup.
  await owner.$executeRaw`DELETE FROM tenant WHERE id IN (${A}::uuid, ${B}::uuid)`;
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await app.$disconnect();
    await owner.$disconnect();
    console.log(
      failures === 0
        ? '\nRLS isolation: ALL CHECKS PASSED'
        : `\nRLS isolation: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
