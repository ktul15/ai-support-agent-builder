/**
 * Eval harness (#40): measures RAG quality against the #39 ground-truth set.
 *
 * Ingests api/eval/corpus through the REAL pipeline (parse -> chunk -> embed via
 * OpenAI -> pgvector), then runs every eval question through the REAL chat route
 * (retrieval -> threshold gate -> Claude generation -> citations) and scores the
 * answers. Reports answer accuracy, citation accuracy, and refusal
 * precision/recall, and writes a machine-readable eval-report.json.
 *
 * Needs real provider keys (OPENAI_API_KEY, ANTHROPIC_API_KEY) + `npm run db:up`:
 *   npm run eval -w @asab/api
 *
 * Non-deterministic (real LLM) — this is a measurement, not a pass/fail proof.
 * Exits non-zero only on a hard error (or a failed gate when EVAL_GATE=1).
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../src/config.js';
import { createProviders } from '../src/providers/index.js';
import { chatRouter } from '../src/routes/chat.js';
import { makeTenantContext } from '../src/middleware/tenant-context.js';
import { signTenantToken } from '../src/auth/tenant-token.js';
import { createRetrievalService } from '../src/retrieval/retrieval-service.js';
import { createGenerationService } from '../src/chat/generation-service.js';
import { parseDocument } from '../src/ingestion/parsing/index.js';
import { chunkDocument } from '../src/ingestion/chunking/index.js';
import { hashChunkContent } from '../src/ingestion/chunking/hash.js';
import { loadEvalSet, CORPUS_DIR, EVAL_DATA_DIR } from '../src/eval/eval-set.js';
import {
  scoreInCorpus,
  scoreOffCorpus,
  computeMetrics,
  type PipelineOutput,
  type InCorpusResult,
  type OffCorpusResult,
} from '../src/eval/scoring.js';
import { collectChat, type SseFrame } from '../src/eval/sse.js';
import { silentLogger } from '../src/observability/logger.js';
import { UsageMeter } from '../src/observability/usage-meter.js';
import { disconnectDb } from '../src/db.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed the eval corpus');

const SECRET = 'eval-harness-secret-at-least-32-characters-long';
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

// Hoisted so the finally can clean up even if the run errors mid-way (an open
// listening socket would otherwise keep the process alive and hang a CI gate).
let seededTenant: string | null = null;
let server: Server | null = null;

const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

/** Read a chat SSE stream into frames, then reduce with the pure collectChat. */
async function readChat(body: ReadableStream<Uint8Array>): Promise<PipelineOutput> {
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (frame.startsWith(':')) continue;
      const event = /event: (.*)/.exec(frame)?.[1] ?? 'message';
      const data = /data: (.*)/.exec(frame)?.[1] ?? '';
      frames.push({ event, data });
    }
  }
  return collectChat(frames);
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

async function main() {
  const cfg = getConfig();
  const providers = createProviders(cfg);
  const evalSet = loadEvalSet();

  const tenantId = randomUUID();
  const assistantId = randomUUID();
  seededTenant = tenantId;

  console.log(`Seeding tenant ${tenantId} and ingesting ${evalSet.corpus} corpus…`);
  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantId}::uuid, 'eval')`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at)
    VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'Eval assistant', now())`;

  // Ingest each corpus doc through the real parse -> chunk -> embed pipeline.
  // document.title is the filename so a returned citation maps to expectedDocs.
  let chunkTotal = 0;
  for (const doc of new Set(evalSet.inCorpus.flatMap((c) => c.expectedDocs))) {
    const bytes = readFileSync(join(CORPUS_DIR, doc));
    const parsed = await parseDocument(bytes, 'MD');
    const chunks = chunkDocument(parsed);
    const embeddings = await providers.embedder.embed(chunks.map((c) => c.content));

    const documentId = randomUUID();
    await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
      VALUES (${documentId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, ${doc}, 'MD', ${`eval/${doc}`}, 'READY', now())`;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      // ON CONFLICT DO NOTHING mirrors the real worker (saveChunks skipDuplicates)
      // so a repeated chunk is skipped, not a crash.
      await owner.$executeRaw`
        INSERT INTO chunk (id, tenant_id, document_id, assistant_id, content, token_count, page, section, char_start, char_end, content_hash, embedding)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${documentId}::uuid, ${assistantId}::uuid,
          ${c.content}, ${c.tokenCount}, ${c.page}, ${c.section}, ${c.charStart}, ${c.charEnd},
          ${hashChunkContent(c.content)}, ${vecLiteral(embeddings[i]!)}::vector)
        ON CONFLICT (tenant_id, assistant_id, content_hash) DO NOTHING`;
    }
    chunkTotal += chunks.length;
    console.log(`  ${doc}: ${chunks.length} chunks`);
  }
  console.log(`Ingested ${chunkTotal} chunks.\n`);

  // Mount the real chat route (permissive rate limiter — this is a batch run).
  const app = express();
  app.use(express.json());
  app.use(
    chatRouter(
      {
        rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterSec: 0 }) },
        logger: silentLogger,
        meter: new UsageMeter(),
        limits: { contextTokenBudget: 2000, maxOutputTokens: 1024 },
        retrieval: createRetrievalService(providers.embedder),
        generation: createGenerationService(providers.chat),
      },
      makeTenantContext(SECRET),
    ),
  );
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/chat`;
  const auth = `Bearer ${await signTenantToken({ tenantId }, SECRET)}`;

  const ask = async (question: string): Promise<PipelineOutput> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ assistantId, question }),
    });
    // A non-OK response (e.g. 503 before the stream) is an error, NOT a refusal.
    if (!res.ok || !res.body) return { answer: '', grounded: false, citations: [], error: true };
    return readChat(res.body);
  };

  // Errored cases (transport / SSE error) are excluded from the quality metrics
  // and reported separately — an infra blip must not masquerade as a quality drop.
  console.log('Running on-corpus questions…');
  const inResults: InCorpusResult[] = [];
  const erroredIn: string[] = [];
  for (const c of evalSet.inCorpus) {
    const out = await ask(c.question);
    if (out.error) {
      erroredIn.push(c.id);
      console.log(`  [ERR] ${c.id} pipeline error (excluded)`);
      continue;
    }
    const r = scoreInCorpus(c, out);
    inResults.push(r);
    if (!(r.factsMatched && r.citationCorrect)) {
      const mark = r.answered ? 'wk ' : 'REF';
      console.log(`  [${mark}] ${c.id} facts=${r.factsMatched} cite=${r.citationCorrect}`);
    }
  }

  console.log('Running off-corpus questions…');
  const offResults: OffCorpusResult[] = [];
  const erroredOff: string[] = [];
  for (const c of evalSet.offCorpus) {
    const out = await ask(c.question);
    if (out.error) {
      erroredOff.push(c.id);
      console.log(`  [ERR] ${c.id} pipeline error (excluded)`);
      continue;
    }
    const r = scoreOffCorpus(c, out);
    offResults.push(r);
    if (!r.refused) console.log(`  [MISS] ${c.id} answered instead of refusing`);
  }

  const metrics = computeMetrics(inResults, offResults);
  const errored = { inCorpus: erroredIn, offCorpus: erroredOff };
  const report = {
    corpus: evalSet.corpus,
    evalVersion: evalSet.version,
    model: cfg.CHAT_MODEL,
    embeddingModel: cfg.EMBEDDING_MODEL,
    metrics,
    errored,
    inResults,
    offResults,
  };
  const reportPath = join(EVAL_DATA_DIR, 'eval-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const refused = metrics.falseRefusals + Math.round(metrics.refusalRecall * metrics.offCorpus);
  console.log('\n──────── Eval report ────────');
  console.log(`corpus            ${evalSet.corpus} (v${evalSet.version})`);
  console.log(`model             ${cfg.CHAT_MODEL} / ${cfg.EMBEDDING_MODEL}`);
  console.log(
    `answer accuracy   ${pct(metrics.answerAccuracy)}  (facts matched / ${metrics.inCorpus})`,
  );
  console.log(
    `citation accuracy ${pct(metrics.citationAccuracy)} all · ${pct(metrics.citationPrecisionAnswered)} of answered`,
  );
  console.log(`false refusals    ${metrics.falseRefusals} / ${metrics.inCorpus}`);
  console.log(
    `refusal precision ${refused ? pct(metrics.refusalPrecision) : 'n/a (nothing refused)'}`,
  );
  console.log(
    `refusal recall    ${pct(metrics.refusalRecall)}  (off-corpus refused / ${metrics.offCorpus})`,
  );
  console.log(`errored           ${erroredIn.length + erroredOff.length} (excluded from metrics)`);
  console.log(`report written    ${reportPath}`);
  console.log('─────────────────────────────');

  // Optional CI gate: fail if quality drops below floors (#41 will set these).
  if (process.env.EVAL_GATE === '1') {
    const minAnswer = Number(process.env.EVAL_MIN_ANSWER ?? '0.7');
    const minRecall = Number(process.env.EVAL_MIN_REFUSAL_RECALL ?? '0.8');
    if (metrics.answerAccuracy < minAnswer || metrics.refusalRecall < minRecall) {
      console.error(
        `\nGATE FAILED: answer=${pct(metrics.answerAccuracy)} (min ${pct(minAnswer)}), ` +
          `refusalRecall=${pct(metrics.refusalRecall)} (min ${pct(minRecall)})`,
      );
      process.exitCode = 1;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the listening socket (else the event loop stays alive and hangs),
    // then drop the seeded tenant (chunks/documents cascade) — both on error too.
    server?.close();
    if (seededTenant) {
      await owner.$executeRaw`DELETE FROM tenant WHERE id = ${seededTenant}::uuid`.catch(() => {});
    }
    await owner.$disconnect();
    await disconnectDb();
  });
