import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing via argon2id (the library default — memory-hard, the current
 * OWASP-recommended algorithm). The salt is generated per-hash and embedded in
 * the returned encoded string, so no separate salt column is needed.
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/**
 * Verify a plaintext password against an encoded argon2 hash. Returns false
 * (never throws) on a mismatch OR a malformed/foreign hash string, so callers
 * get a single boolean and an attacker learns nothing from error shape.
 */
export async function verifyPassword(encodedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(encodedHash, plain);
  } catch {
    return false;
  }
}
