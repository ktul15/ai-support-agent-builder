export interface RetryOptions {
  /** Total attempts including the first (so 4 = 1 try + 3 retries). */
  attempts: number;
  /** Delay before the first retry; doubles each subsequent retry. */
  baseDelayMs: number;
  /**
   * Whether an error is worth retrying. Default: retry everything. Provide this
   * to fail fast on permanent errors (e.g. a 4xx auth/validation) so they don't
   * burn the full attempt budget.
   */
  shouldRetry?: (err: unknown) => boolean;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying with exponential backoff. Throws the last error once
 * attempts are exhausted OR immediately if `shouldRetry` says the error is
 * permanent. `sleep` is injectable so tests don't wait real time.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  sleep: Sleep = realSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (attempt === opts.attempts) break;
      await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
