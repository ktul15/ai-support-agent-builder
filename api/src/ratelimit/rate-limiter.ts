export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next token is available (0 when allowed). */
  retryAfterSec: number;
}

/**
 * A rate limiter keyed by an opaque string (here: `chat:<tenantId>`). Injected
 * as a port so the middleware can be unit-tested with a fake and the real Redis
 * token bucket is only exercised in a verify script.
 */
export interface RateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}
