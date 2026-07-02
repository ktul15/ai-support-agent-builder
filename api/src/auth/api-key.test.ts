import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from './api-key.js';

describe('api key', () => {
  it('mints a prefixed key with a matching 64-hex sha256 hash', () => {
    const { key, hash } = generateApiKey();
    expect(key.startsWith('asab_sk_')).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hash); // the stored hash resolves the key
  });

  it('hashes deterministically and distinctly', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
    expect(hashApiKey(a.key)).toBe(hashApiKey(a.key));
  });
});
