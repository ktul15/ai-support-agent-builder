import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { RedisTokenBucket } from './redis-rate-limiter.js';

export type { RateLimiter, RateLimitResult } from './rate-limiter.js';
export { RedisTokenBucket } from './redis-rate-limiter.js';

/** Build the per-tenant chat rate limiter from config (owns its Redis client). */
export function createRateLimiter(config: Config): RedisTokenBucket {
  // maxRetriesPerRequest null so a Redis blip surfaces as a rejected command the
  // middleware can fail-open on, rather than the client retrying forever.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return new RedisTokenBucket(redis, config.CHAT_RATE_CAPACITY, config.CHAT_RATE_REFILL_PER_SEC);
}
