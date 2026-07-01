import { Redis } from 'ioredis';
import type { RateLimiter, RateLimitResult } from './rate-limiter.js';

/**
 * Token bucket in a single atomic Redis call: read {tokens, ts}, refill by the
 * elapsed time (capped at capacity), then consume one if available — all in Lua
 * so concurrent requests for the same tenant can't race the read-modify-write.
 * KEYS[1]=bucket  ARGV=capacity, refillPerSec, nowMs, cost.
 * Returns {allowed(1/0), retryAfterSec}.
 */
const BUCKET_LUA = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = cap; ts = now end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(cap, tokens + elapsed * refill)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill)
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
-- Idle buckets expire once they'd be full again (+1s slack), so keys self-clean.
redis.call('PEXPIRE', key, math.ceil(cap / refill * 1000) + 1000)
return {allowed, retry}
`;

export class RedisTokenBucket implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    const [allowed, retry] = (await this.redis.eval(
      BUCKET_LUA,
      1,
      `ratelimit:${key}`,
      this.capacity,
      this.refillPerSec,
      Date.now(),
      1,
    )) as [number, number];
    return { allowed: allowed === 1, retryAfterSec: retry };
  }

  close(): Promise<void> {
    return this.redis.quit().then(() => undefined);
  }
}
