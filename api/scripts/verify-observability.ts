/**
 * Proof of the observability layer (#42): structured per-request logs, the
 * per-tenant usage meter, and the unanswered-questions log.
 *
 * Seeds a grounded assistant + an empty one (deterministic fakes, no real
 * providers), fires chats through the real chat route with a CAPTURING logger +
 * a UsageMeter, and asserts: a grounded request emits a chat_request log +
 * meters tokens; a refusal emits an unanswered_question log + a refused
 * chat_request; and GET /usage returns the tenant's own totals (403 otherwise).
 *
 *   tsx scripts/verify-observability.ts   (needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { chatRouter } from '../src/routes/chat.js';
import { usageRouter } from '../src/routes/usage.js';
import { makeTenantContext } from '../src/middleware/tenant-context.js';
import { signTenantToken } from '../src/auth/tenant-token.js';
import { createRetrievalService } from '../src/retrieval/retrieval-service.js';
import { createGenerationService } from '../src/chat/generation-service.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';
import { FakeChat } from '../src/providers/fake-chat.js';
import { createLogger } from '../src/observability/logger.js';
import { UsageMeter } from '../src/observability/usage-meter.js';
import { disconnectDb } from '../src/db.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');

const SECRET = 'verify-observability-secret-at-least-32-chars';
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const embedder = new FakeEmbedder();
const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

let failures = 0;
const tenants: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

interface LogLine {
  event: string;
  [k: string]: unknown;
}
const logs: LogLine[] = [];
const logger = createLogger((line) => logs.push(JSON.parse(line) as LogLine));
const meter = new UsageMeter();

async function readSse(body: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) decoder.decode(chunk);
}

async function main() {
  const tenantId = randomUUID();
  const assistantId = randomUUID();
  const emptyAssistantId = randomUUID();
  const documentId = randomUUID();
  tenants.push(tenantId);

  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantId}::uuid, 'obs')`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${emptyAssistantId}::uuid, ${tenantId}::uuid, 'Empty', now())`;
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${documentId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'Refund Policy', 'TXT', 'k', 'READY', now())`;

  const texts = ['refunds are processed within 30 days of request'];
  const embs = (await embedder.embed(texts)).map(vecLiteral);
  await owner.$executeRaw`
    INSERT INTO chunk (id, tenant_id, document_id, assistant_id, content, token_count, page, section, content_hash, embedding)
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${documentId}::uuid, ${assistantId}::uuid, u.c, 10, 1, 'Refunds', md5(u.c), u.e::vector
    FROM unnest(${texts}::text[], ${embs}::text[]) AS u(c, e)`;

  const deps = {
    rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterSec: 0 }) },
    limits: { contextTokenBudget: 2000, maxOutputTokens: 1024 },
    retrieval: createRetrievalService(embedder),
    generation: createGenerationService(
      new FakeChat({ reply: 'Refunds are processed within 30 days [1].' }),
    ),
    logger,
    meter,
  };

  const app = express();
  app.use(express.json());
  app.use(chatRouter(deps, makeTenantContext(SECRET)));
  app.use(usageRouter(meter, makeTenantContext(SECRET)));
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const consumerAuth = `Bearer ${await signTenantToken({ tenantId }, SECRET)}`;
  const adminAuth = `Bearer ${await signTenantToken({ tenantId, userId: randomUUID() }, SECRET)}`;

  const ask = async (aid: string): Promise<void> => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: consumerAuth },
      body: JSON.stringify({ assistantId: aid, question: 'how long do refunds take?' }),
    });
    if (res.body) await readSse(res.body);
  };

  // 1. Grounded chat -> chat_request log with the required fields + metered tokens.
  await ask(assistantId);
  const chatLog = logs.find((l) => l.event === 'chat_request' && l.grounded === true);
  check(
    'grounded chat emits a chat_request log (tenant, latency, tokens, score, grounded)',
    !!chatLog &&
      chatLog.tenantId === tenantId &&
      typeof chatLog.latencyMs === 'number' &&
      typeof chatLog.outputTokens === 'number' &&
      (chatLog.outputTokens as number) > 0 &&
      'topScore' in chatLog,
    `outputTokens=${chatLog?.outputTokens}`,
  );
  check(
    'the grounded request is metered per tenant (requests + output tokens)',
    meter.forTenant(tenantId).requests === 1 && meter.forTenant(tenantId).outputTokens > 0,
    `requests=${meter.forTenant(tenantId).requests} outTok=${meter.forTenant(tenantId).outputTokens}`,
  );

  // 2. Empty-corpus assistant -> gate refuses -> unanswered_question + refused log.
  await ask(emptyAssistantId);
  const unanswered = logs.find((l) => l.event === 'unanswered_question');
  const refusedLog = logs.find((l) => l.event === 'chat_request' && l.refused === true);
  check(
    'a refusal emits an unanswered_question log (with reason + question)',
    !!unanswered &&
      unanswered.tenantId === tenantId &&
      typeof unanswered.question === 'string' &&
      unanswered.refusalReason === 'no_sources',
    `reason=${unanswered?.refusalReason}`,
  );
  check(
    'the refusal is logged as a refused chat_request and metered (embeddings)',
    !!refusedLog &&
      meter.forTenant(tenantId).requests === 2 &&
      meter.forTenant(tenantId).embeddings === 2,
    `requests=${meter.forTenant(tenantId).requests} emb=${meter.forTenant(tenantId).embeddings}`,
  );

  // 3. GET /usage returns THIS tenant's totals (admin), and 403s a non-admin.
  const usageRes = await fetch(`${base}/usage`, { headers: { authorization: adminAuth } });
  const usageBody = (await usageRes.json()) as { usage?: { requests: number } };
  check(
    'GET /usage returns the tenant usage totals for an admin',
    usageRes.status === 200 && usageBody.usage?.requests === 2,
    `status=${usageRes.status} requests=${usageBody.usage?.requests}`,
  );
  const denied = await fetch(`${base}/usage`, { headers: { authorization: consumerAuth } });
  check('GET /usage is admin-only (403 for a non-admin token)', denied.status === 403);

  server.close();
  console.log(
    failures === 0 ? 'Observability: ALL CHECKS PASSED' : `Observability: ${failures} FAILED`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    for (const t of tenants) {
      await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`.catch(() => {});
    }
    await owner.$disconnect();
    await disconnectDb();
    process.exit(failures === 0 ? 0 : 1);
  });
