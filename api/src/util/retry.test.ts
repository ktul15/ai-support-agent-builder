import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    await expect(withRetry(fn, { attempts: 4, baseDelayMs: 10 }, noSleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(() => {
      n++;
      return n < 3 ? Promise.reject(new Error('transient')) : Promise.resolve('ok');
    });
    await expect(withRetry(fn, { attempts: 4, baseDelayMs: 10 }, noSleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('always fails')));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 10 }, noSleep)).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast (no retries) when shouldRetry returns false', async () => {
    const fn = vi.fn(() => Promise.reject(Object.assign(new Error('401'), { status: 401 })));
    await expect(
      withRetry(
        fn,
        {
          attempts: 4,
          baseDelayMs: 10,
          shouldRetry: (e) => (e as { status?: number }).status !== 401,
        },
        noSleep,
      ),
    ).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn(() => Promise.reject(new Error('x')));
    await expect(withRetry(fn, { attempts: 4, baseDelayMs: 100 }, sleep)).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);
  });
});
