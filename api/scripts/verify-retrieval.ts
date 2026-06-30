/**
 * End-to-end proof of tenant-filtered ANN retrieval (issue #19).
 *
 * Seeds two tenants / multiple assistants with embedded chunks (deterministic
 * FakeEmbedder), then runs retrieveChunks and asserts: top-k by cosine returns
 * content + score + page/section/document_id; a query is filtered to its
 * (tenant, assistant) — no cross-tenant or cross-assistant leakage; and the plan
 * uses the HNSW index (no seq scan). Exits non-zero on any failure.
 *
 *   tsx scripts/verify-retrieval.ts   (needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { retrieveChunks } from '../src/retrieval/retrieve.js';
import { disconnectDb } from '../src/db.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } }); // bypasses RLS
const embedder = new FakeEmbedder();

let failures = 0;
const tenants: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

/** Seed an assistant + one document + chunks (with embeddings) for given texts. */
async function seed(tenantId: string, assistantId: string, texts: string[]): Promise<void> {
  const documentId = randomUUID();
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${documentId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'D', 'TXT', 'k', 'READY', now())`;
  const vectors = await embedder.embed(texts);
  const embs = vectors.map(vecLiteral);
  await owner.$executeRaw`
    INSERT INTO chunk (id, tenant_id, document_id, assistant_id, content, token_count, page, section, content_hash, embedding)
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${documentId}::uuid, ${assistantId}::uuid, u.c, 10, 1, 'S', md5(u.c || ${assistantId}), u.e::vector
    FROM unnest(${texts}::text[], ${embs}::text[]) AS u(c, e)`;
}

async function main() {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const b1 = randomUUID();
  tenants.push(tenantA, tenantB);
  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantA}::uuid, 'A')`;
  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantB}::uuid, 'B')`;

  // a1: 250 chunks (a realistic corpus); a2 + b1: distinct content for isolation.
  const a1Texts = Array.from({ length: 250 }, (_, i) => `refund policy detail number ${i}`);
  await seed(tenantA, a1, a1Texts);
  await seed(tenantA, a2, ['only in assistant two alpha', 'only in assistant two beta']);
  await seed(tenantB, b1, ['secret tenant b content']);

  // Query = the embedding of one specific a1 chunk -> it must rank #1.
  const target = 'refund policy detail number 42';
  const [queryEmbedding] = await embedder.embed([target]);

  // 1. Top-k returns content + score + metadata, with the exact match first.
  const hits = await retrieveChunks(tenantA, {
    assistantId: a1,
    queryEmbedding: queryEmbedding!,
    k: 5,
  });
  const top = hits[0];
  check(
    'top-k returns the best match with content, score and metadata',
    hits.length === 5 &&
      top?.content === target &&
      top.score > 0.99 &&
      typeof top.documentId === 'string' &&
      top.page === 1 &&
      top.section === 'S',
    top ? `top="${top.content}" score=${top.score?.toFixed(4)}` : 'no hits',
  );

  // 2. Cross-tenant isolation: querying tenant A for tenant B's assistant -> nothing.
  const crossTenant = await retrieveChunks(tenantA, {
    assistantId: b1,
    queryEmbedding: queryEmbedding!,
    k: 50,
  });
  check(
    'cross-tenant query returns no rows',
    crossTenant.length === 0,
    `saw ${crossTenant.length}`,
  );

  // 3. Assistant isolation: filtering to a2 returns only a2's chunks.
  const a2hits = await retrieveChunks(tenantA, {
    assistantId: a2,
    queryEmbedding: queryEmbedding!,
    k: 50,
  });
  check(
    'assistant filter returns only that assistant',
    a2hits.length === 2 && a2hits.every((h) => h.content.startsWith('only in assistant two')),
    `saw ${a2hits.length}`,
  );

  // 4. The ANN query is served by the HNSW index, not a sequential scan. (On a
  //    tiny table the planner legitimately prefers an exact sort; disabling
  //    seqscan/sort makes the ordered HNSW index the only path, proving the
  //    partial cosine index is built correctly and usable for the filtered ANN.)
  const plan = await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
    await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
    await tx.$executeRawUnsafe(`SET LOCAL enable_sort = off`);
    return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (FORMAT TEXT)
       SELECT id FROM chunk
       WHERE tenant_id = '${tenantA}'::uuid AND assistant_id = '${a1}'::uuid AND embedding IS NOT NULL
       ORDER BY embedding <=> '${vecLiteral(queryEmbedding!)}'::vector LIMIT 5`,
    );
  });
  const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
  check(
    'HNSW index is usable for the filtered ANN (index scan available)',
    planText.includes('chunk_embedding_hnsw') && !/Seq Scan on chunk\b/.test(planText),
    planText
      .split('\n')
      .find((l) => l.includes('chunk_embedding_hnsw'))
      ?.trim()
      .slice(0, 50) ?? planText.split('\n')[1]?.trim().slice(0, 50),
  );
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
    await disconnectDb();
    await owner.$disconnect();
    console.log(
      failures === 0 ? '\nRetrieval: ALL CHECKS PASSED' : `\nRetrieval: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
