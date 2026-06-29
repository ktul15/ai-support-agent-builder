import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(await verifyPassword(hash, 's3cret-passwor')).toBe(false);
  });

  it('never stores the plaintext and uses argon2id', async () => {
    const hash = await hashPassword('plaintext-here');
    expect(hash).not.toContain('plaintext-here');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('uses a random salt (same input -> different hashes)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-input'), hashPassword('same-input')]);
    expect(a).not.toBe(b);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});
