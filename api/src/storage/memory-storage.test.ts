import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './memory-storage.js';

describe('MemoryStorage', () => {
  it('puts, reports existence, reads back, and deletes', async () => {
    const s = new MemoryStorage();
    const key = 'tenants/a/b/original';

    expect(await s.exists(key)).toBe(false);
    await s.put({ key, body: Buffer.from('hello world'), contentType: 'text/plain' });
    expect(await s.exists(key)).toBe(true);

    const got = s.peek(key)!;
    expect(Buffer.from(got.body).toString()).toBe('hello world');
    expect(got.contentType).toBe('text/plain');

    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
  });

  it('signedReadUrl includes the key and the expiry', async () => {
    const url = await new MemoryStorage().signedReadUrl('some-key', 60);
    expect(url).toContain('some-key');
    expect(url).toContain('60');
  });
});
