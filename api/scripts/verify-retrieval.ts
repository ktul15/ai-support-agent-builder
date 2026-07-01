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
import { createRetrievalService } from '../src/retrieval/retrieval-service.js';
import { assembleContext } from '../src/chat/prompt-assembly.js';
import { createGenerationService, collectAnswer } from '../src/chat/generation-service.js';
import { PrismaDocumentStatusStore } from '../src/worker/document-store.js';
import { disconnectDb } from '../src/db.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';
import { FakeChat } from '../src/providers/fake-chat.js';

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
    embeddingModel: 'fake-embedder',
    k: 5,
  });
  const top = hits[0];
  check(
    'top-k returns the best match with content, score and metadata',
    hits.length === 5 &&
      top?.content === target &&
      top.score > 0.99 &&
      typeof top.documentId === 'string' &&
      top.title === 'D' &&
      top.page === 1 &&
      top.section === 'S',
    top ? `top="${top.content}" title="${top.title}" score=${top.score?.toFixed(4)}` : 'no hits',
  );

  // 2. Cross-tenant isolation: querying tenant A for tenant B's assistant -> nothing.
  const crossTenant = await retrieveChunks(tenantA, {
    assistantId: b1,
    queryEmbedding: queryEmbedding!,
    embeddingModel: 'fake-embedder',
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
    embeddingModel: 'fake-embedder',
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
    // The real (joined) query, so the plan check mirrors what retrieveChunks runs.
    return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (FORMAT TEXT)
       SELECT c.id FROM chunk c
       JOIN document d ON d.id = c.document_id
       WHERE c.tenant_id = '${tenantA}'::uuid AND c.assistant_id = '${a1}'::uuid AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> '${vecLiteral(queryEmbedding!)}'::vector LIMIT 5`,
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

  // 5. Retrieval service (#20): embeds the question (same embedder/model as the
  //    corpus) and returns ranked chunks; k is configurable.
  const service = createRetrievalService(embedder);
  const serviceHits = await service.retrieve(tenantA, { assistantId: a1, question: target, k: 3 });
  check(
    'retrieval service embeds the question and returns k ranked chunks',
    serviceHits.length === 3 && serviceHits[0]?.content === target,
    serviceHits[0] ? `top="${serviceHits[0].content}" k=${serviceHits.length}` : 'no hits',
  );

  // 5b. Invariant #4: a corpus embedded with a different model is rejected loudly
  //     (not silently mis-scored). Stamp a2's corpus with a foreign model, then
  //     query it with the fake embedder's model.
  await owner.$executeRaw`UPDATE assistant SET embedding_model = 'foreign-model-x' WHERE id = ${a2}::uuid`;
  let rejected = false;
  try {
    await retrieveChunks(tenantA, {
      assistantId: a2,
      queryEmbedding: queryEmbedding!,
      embeddingModel: 'fake-embedder',
      k: 3,
    });
  } catch (err) {
    rejected = err instanceof Error && /embedding model mismatch/.test(err.message);
  }
  check('a query whose model differs from the corpus is rejected', rejected, 'mismatch threw');
  await owner.$executeRaw`UPDATE assistant SET embedding_model = NULL WHERE id = ${a2}::uuid`;

  // 5c. Ingest side (real document-store SQL, not the fake): ensureEmbeddingModel
  //     claims the model on first call, then rejects a different model.
  const store = new PrismaDocumentStatusStore();
  await store.ensureEmbeddingModel(tenantA, a2, 'model-x');
  const claimed = await owner.$queryRaw<{ embedding_model: string | null }[]>`
    SELECT embedding_model FROM assistant WHERE id = ${a2}::uuid`;
  let mixRejected = false;
  try {
    await store.ensureEmbeddingModel(tenantA, a2, 'model-y');
  } catch (err) {
    mixRejected = err instanceof Error && /refusing to mix/.test(err.message);
  }
  check(
    'ensureEmbeddingModel claims the model then rejects a second model',
    claimed[0]?.embedding_model === 'model-x' && mixRejected,
    `claimed=${claimed[0]?.embedding_model} mixRejected=${mixRejected}`,
  );
  await owner.$executeRaw`UPDATE assistant SET embedding_model = NULL WHERE id = ${a2}::uuid`;

  // 6. Prompt assembly (#21): chunks -> numbered, deterministic sources block.
  const ctx = assembleContext(serviceHits);
  check(
    'prompt assembly numbers sources [1]..[n] with title/page',
    ctx.sources.length === 3 &&
      ctx.sources[0]?.marker === 1 &&
      ctx.text.startsWith('[1] "D" — page 1') &&
      ctx.text.includes('[3]'),
    ctx.text.split('\n')[0]?.slice(0, 40),
  );

  // 7. Full consumer pipeline (#22): retrieve -> assemble -> generate. Uses a
  //    deterministic FakeChat (no Claude call); proves model selection + usage.
  const generator = createGenerationService(
    new FakeChat({
      reply: 'Refunds are processed within 30 days [1].',
      usage: { inputTokens: 120, outputTokens: 9 },
    }),
  );
  const answer = await collectAnswer(
    generator.stream({
      model: 'claude-haiku-4-5',
      system: 'Answer only from the sources.',
      question: target,
      context: ctx.text,
    }),
  );
  check(
    'generation streams a grounded answer + captures token usage',
    answer.text.includes('[1]') && answer.usage?.outputTokens === 9 && answer.error === undefined,
    `answer="${answer.text.slice(0, 30)}…" out=${answer.usage?.outputTokens}`,
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
