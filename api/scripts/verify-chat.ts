/**
 * End-to-end proof of the SSE chat endpoint (issue #23).
 *
 * Seeds a tenant + assistant + embedded chunks (deterministic FakeEmbedder),
 * mounts the chat router with a deterministic FakeChat (no Claude call), then
 * POSTs a question over HTTP and parses the event stream. Asserts: token events
 * stream, the final `done` event carries citations + grounded + latency_ms, and
 * a client disconnect aborts cleanly. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-chat.ts   (needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { chatRouter } from '../src/routes/chat.js';
import { makeTenantContext } from '../src/middleware/tenant-context.js';
import { signTenantToken } from '../src/auth/tenant-token.js';
import { createRetrievalService } from '../src/retrieval/retrieval-service.js';
import { createGenerationService } from '../src/chat/generation-service.js';
import { FakeEmbedder } from '../src/providers/fake-embedder.js';
import { FakeChat } from '../src/providers/fake-chat.js';
import { REFUSAL_MESSAGE } from '../src/chat/refusal.js';
import { disconnectDb } from '../src/db.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to seed');

const SECRET = 'verify-chat-secret-at-least-32-characters-long';
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const embedder = new FakeEmbedder();

let failures = 0;
const tenants: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

/** Parse an SSE body stream into { event, data } records. */
async function readSse(
  body: ReadableStream<Uint8Array>,
): Promise<{ event: string; data: string }[]> {
  const decoder = new TextDecoder();
  let buffer = '';
  const events: { event: string; data: string }[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (frame.startsWith(':')) continue; // heartbeat comment
      const event = /event: (.*)/.exec(frame)?.[1] ?? 'message';
      const data = /data: (.*)/.exec(frame)?.[1] ?? '';
      events.push({ event, data });
    }
  }
  return events;
}

async function main() {
  const tenantId = randomUUID();
  const assistantId = randomUUID();
  const emptyAssistantId = randomUUID(); // no chunks -> threshold gate refuses
  const documentId = randomUUID();
  tenants.push(tenantId);

  await owner.$executeRaw`INSERT INTO tenant (id,name) VALUES (${tenantId}::uuid, 'T')`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${assistantId}::uuid, ${tenantId}::uuid, 'A', now())`;
  await owner.$executeRaw`INSERT INTO assistant (id,tenant_id,name,updated_at) VALUES (${emptyAssistantId}::uuid, ${tenantId}::uuid, 'Empty', now())`;
  await owner.$executeRaw`INSERT INTO document (id,tenant_id,assistant_id,title,source_type,storage_key,status,updated_at)
    VALUES (${documentId}::uuid, ${tenantId}::uuid, ${assistantId}::uuid, 'Refund Policy', 'TXT', 'k', 'READY', now())`;

  const texts = [
    'refunds are processed within 30 days of request',
    'shipping takes 5 business days',
  ];
  const embs = (await embedder.embed(texts)).map(vecLiteral);
  await owner.$executeRaw`
    INSERT INTO chunk (id, tenant_id, document_id, assistant_id, content, token_count, page, section, content_hash, embedding)
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${documentId}::uuid, ${assistantId}::uuid, u.c, 10, 1, 'Refunds', md5(u.c), u.e::vector
    FROM unnest(${texts}::text[], ${embs}::text[]) AS u(c, e)`;

  const app = express();
  app.use(express.json());
  app.use(
    chatRouter(
      {
        retrieval: createRetrievalService(embedder),
        generation: createGenerationService(
          new FakeChat({ reply: 'Refunds are processed within 30 days [1].' }),
        ),
      },
      makeTenantContext(SECRET),
    ),
  );
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/chat`;
  const auth = `Bearer ${await signTenantToken({ tenantId }, SECRET)}`;

  try {
    // 1. Happy path: tokens stream, final `done` carries citations + grounded + latency.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ assistantId, question: 'how long do refunds take?' }),
    });
    check(
      'response is an SSE stream with compression disabled',
      res.headers.get('content-type') === 'text/event-stream' &&
        (res.headers.get('cache-control') ?? '').includes('no-transform'),
      res.headers.get('content-type') ?? 'none',
    );

    const events = await readSse(res.body!);
    const tokens = events.filter((e) => e.event === 'token');
    const answer = tokens.map((t) => JSON.parse(t.data).text).join('');
    check(
      'streams token events per chunk of the answer',
      tokens.length > 0 && answer.includes('[1]'),
      answer,
    );

    const doneEvent = events.find((e) => e.event === 'done');
    const done = doneEvent ? JSON.parse(doneEvent.data) : undefined;
    check(
      'final done event carries citations + grounded + latency_ms',
      !!done &&
        done.grounded === true &&
        Array.isArray(done.citations) &&
        done.citations.length > 0 &&
        done.citations[0].title === 'Refund Policy' &&
        typeof done.latency_ms === 'number',
      done ? `citations=${done.citations.length} latency=${done.latency_ms}ms` : 'no done event',
    );

    // 2. Mid-stream disconnect is handled cleanly: read the first frame, then
    //    abort. This proves the stream starts and the client can drop without
    //    error; that the server survives the drop is proven by check #3 (a fresh
    //    request succeeds afterwards). (Upstream-cancel propagation is unit-level
    //    on ClaudeChat#22 — FakeChat here has no real upstream to cancel.)
    const ac = new AbortController();
    const cancelRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ assistantId, question: 'refunds?' }),
      signal: ac.signal,
    });
    const reader = cancelRes.body!.getReader();
    const first = await reader.read(); // first SSE frame (waits for the real pipeline)
    const gotFirstChunk = !first.done && (first.value?.length ?? 0) > 0;
    ac.abort();
    void reader.cancel().catch(() => undefined);
    check(
      'stream starts and a client disconnect is handled',
      gotFirstChunk,
      'first frame received',
    );

    // 3. Threshold gate (#25): an empty-corpus assistant returns no hits, so the
    //    pre-LLM gate refuses — the answer is the canonical refusal string (NOT
    //    the FakeChat reply, proving the LLM was skipped) and grounded is false.
    const refuseRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({
        assistantId: emptyAssistantId,
        question: 'how long do refunds take?',
      }),
    });
    const refuseEvents = await readSse(refuseRes.body!);
    const refuseAnswer = refuseEvents
      .filter((e) => e.event === 'token')
      .map((t) => JSON.parse(t.data).text)
      .join('');
    const refuseDone = refuseEvents.find((e) => e.event === 'done');
    const rdone = refuseDone ? JSON.parse(refuseDone.data) : undefined;
    check(
      'off-corpus question refuses pre-LLM (refusal string, grounded=false, no citations)',
      refuseAnswer === REFUSAL_MESSAGE &&
        rdone?.grounded === false &&
        Array.isArray(rdone.citations) &&
        rdone.citations.length === 0,
      `answer="${refuseAnswer.slice(0, 30)}…" grounded=${rdone?.grounded}`,
    );

    // 4. 404 for an unknown assistant (pre-stream HTTP error, not an SSE frame).
    const notFound = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ assistantId: randomUUID(), question: 'hi' }),
    });
    check('unknown assistant returns 404', notFound.status === 404, `status=${notFound.status}`);
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
      console.log(failures === 0 ? 'Chat: ALL CHECKS PASSED' : `Chat: ${failures} FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    })();
  });
