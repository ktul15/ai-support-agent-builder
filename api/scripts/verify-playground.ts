/**
 * End-to-end proof of the retrieval playground endpoint (issue #27).
 *
 * Seeds a tenant + assistant + embedded chunks (deterministic FakeEmbedder),
 * mounts the playground router, and asserts (over real HTTP + DB): an admin
 * query returns the chosen chunks + scores + threshold decision + assembled
 * preview; an empty-corpus assistant reports a no_sources refusal decision; and
 * a consumer (assistant-scoped) token is rejected 403. Exits non-zero on failure.
 *
 *   tsx scripts/verify-playground.ts   (needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { playgroundRouter } from '../src/routes/playground.js';
import { makeTenantContext } from '../src/middleware/tenant-context.js';
import { signTenantToken } from '../src/auth/tenant-token.js';
import { createRetrievalService } from '../src/retrieval/retrieval-service.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';
import { disconnectDb } from '../src/db.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');

const SECRET = 'verify-playground-secret-at-least-32-characters';
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const embedder = new FakeEmbedder();

let failures = 0;
const tenants: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

async function main() {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID(); // a different tenant, for the isolation check
  const assistantId = randomUUID();
  const emptyAssistantId = randomUUID();
  const otherAssistantId = randomUUID(); // belongs to otherTenantId
  const documentId = randomUUID();
  tenants.push(tenantId, otherTenantId);

  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantId}::uuid, 'T')`;
  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${otherTenantId}::uuid, 'Other')`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${emptyAssistantId}::uuid, ${tenantId}::uuid, 'Empty', now())`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${otherAssistantId}::uuid, ${otherTenantId}::uuid, 'Other', now())`;
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${documentId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'Refund Policy', 'TXT', 'k', 'READY', now())`;

  const texts = ['refunds are processed within 30 days', 'shipping takes 5 business days'];
  const embs = (await embedder.embed(texts)).map(vecLiteral);
  await owner.$executeRaw`
    INSERT INTO chunk (id, tenant_id, document_id, assistant_id, content, token_count, page, section, content_hash, embedding)
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${documentId}::uuid, ${assistantId}::uuid, u.c, 10, 1, 'Refunds', md5(u.c), u.e::vector
    FROM unnest(${texts}::text[], ${embs}::text[]) AS u(c, e)`;

  const app = express();
  app.use(express.json());
  app.use(
    playgroundRouter(
      {
        retrieval: createRetrievalService(embedder),
        limits: { contextTokenBudget: 2000, maxOutputTokens: 2048 },
      },
      makeTenantContext(SECRET),
    ),
  );
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/playground/retrieve`;
  const adminAuth = `Bearer ${await signTenantToken({ tenantId, userId: randomUUID() }, SECRET)}`;
  const consumerAuth = `Bearer ${await signTenantToken({ tenantId, assistantId }, SECRET)}`;

  const query = (auth: string, body: unknown): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body),
    });

  try {
    // 1. Admin query returns chosen chunks + scores + a (non-refusing) decision.
    const res = await query(adminAuth, { assistantId, question: 'how long do refunds take?' });
    const body = await res.json();
    check(
      'admin query returns chosen chunks + scores + threshold decision',
      res.status === 200 &&
        Array.isArray(body.retrieved) &&
        body.retrieved.length === 2 &&
        typeof body.retrieved[0].score === 'number' &&
        typeof body.retrieved[0].document_id === 'string' &&
        body.decision.refuse === false &&
        body.threshold === 0.35,
      `chunks=${body.retrieved?.length} topScore=${body.decision?.top_score?.toFixed(3)}`,
    );

    // 2. Mirrors prod: the assembled preview is present when not refusing.
    check(
      'returns the assembled preview (sources + token count) for a non-refusal',
      body.assembled &&
        Array.isArray(body.assembled.sources) &&
        body.assembled.sources.length === 2 &&
        body.assembled.sources[0].marker === 1 &&
        typeof body.assembled.sources[0].chunk_id === 'string' &&
        typeof body.assembled.sources[0].score === 'number' &&
        typeof body.assembled.total_tokens === 'number',
      `sources=${body.assembled?.sources?.length} tokens=${body.assembled?.total_tokens}`,
    );

    // 3. Empty-corpus assistant -> the gate's no_sources refusal decision, no assembly.
    const empty = await (
      await query(adminAuth, { assistantId: emptyAssistantId, question: 'anything' })
    ).json();
    check(
      'empty corpus reports a no_sources refusal decision + no assembly',
      empty.retrieved.length === 0 &&
        empty.decision.refuse === true &&
        empty.decision.reason === 'no_sources' &&
        empty.assembled === null,
      `refuse=${empty.decision?.refuse} reason=${empty.decision?.reason}`,
    );

    // 4. Admin-only: a consumer (assistant-scoped) token is rejected.
    const forbidden = await query(consumerAuth, { assistantId, question: 'hi' });
    check(
      'consumer token is rejected 403 (admin only)',
      forbidden.status === 403,
      `status=${forbidden.status}`,
    );

    // 5. Tenant isolation: another tenant's assistantId is invisible under this
    //    tenant's context (RLS) -> 404, never a cross-tenant leak.
    const crossTenant = await query(adminAuth, { assistantId: otherAssistantId, question: 'hi' });
    check(
      "another tenant's assistant returns 404 (isolation)",
      crossTenant.status === 404,
      `status=${crossTenant.status}`,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    void (async () => {
      for (const t of tenants) {
        await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`;
      }
      await owner.$disconnect();
      await disconnectDb();
      console.log(
        failures === 0 ? 'Playground: ALL CHECKS PASSED' : `Playground: ${failures} FAILED`,
      );
      process.exit(failures === 0 ? 0 : 1);
    })();
  });
