/**
 * End-to-end proof of the Redis per-tenant token bucket (issue #28).
 *
 * Exercises the real RedisTokenBucket against Redis: a burst up to capacity is
 * allowed then denied with a Retry-After, concurrent consumes never over-grant
 * (Lua atomicity), and tokens refill over time. Exits non-zero on any failure.
 *
 *   tsx scripts/verify-ratelimit.ts   (needs `npm run db:up`)
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisTokenBucket } from '../src/ratelimit/redis-rate-limiter.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL required');

const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

let failures = 0;
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main() {
  // capacity 5, refill 2/s (a token every 500ms).
  const CAP = 5;
  const limiter = new RedisTokenBucket(redis, CAP, 2);

  // 1. A burst up to capacity is allowed, then denied with a positive retry.
  const key1 = `verify:${randomUUID()}`;
  const burst = [];
  for (let i = 0; i < CAP + 1; i++) burst.push(await limiter.consume(key1));
  const allowedCount = burst.filter((r) => r.allowed).length;
  const last = burst[burst.length - 1]!;
  check(
    'burst allows up to capacity, then denies with Retry-After',
    allowedCount === CAP && !last.allowed && last.retryAfterSec >= 1,
    `allowed=${allowedCount}/${CAP} retry=${last.retryAfterSec}s`,
  );

  // 2. Atomicity: fire 3x capacity concurrently on a fresh key -> exactly
  //    capacity allowed (the Lua read-modify-write can't be raced).
  const key2 = `verify:${randomUUID()}`;
  const concurrent = await Promise.all(
    Array.from({ length: CAP * 3 }, () => limiter.consume(key2)),
  );
  const grants = concurrent.filter((r) => r.allowed).length;
  check(
    'concurrent consumes never over-grant (atomic)',
    grants === CAP,
    `granted=${grants} of ${CAP * 3} requests`,
  );

  // 3. Refill: after a denial, waiting long enough frees a token.
  const key3 = `verify:${randomUUID()}`;
  for (let i = 0; i < CAP; i++) await limiter.consume(key3);
  const denied = await limiter.consume(key3);
  await sleep(700); // > 500ms -> at least one token refilled
  const afterWait = await limiter.consume(key3);
  check(
    'tokens refill over time',
    !denied.allowed && afterWait.allowed,
    `denied_then_allowed=${!denied.allowed && afterWait.allowed}`,
  );

  await redis.del(`ratelimit:${key1}`, `ratelimit:${key2}`, `ratelimit:${key3}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    void redis.quit().finally(() => {
      console.log(
        failures === 0 ? 'RateLimit: ALL CHECKS PASSED' : `RateLimit: ${failures} FAILED`,
      );
      process.exit(failures === 0 ? 0 : 1);
    });
  });
