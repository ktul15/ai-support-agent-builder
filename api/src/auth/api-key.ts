import { randomBytes, createHash } from 'node:crypto';

const PREFIX = 'asab_sk_';

/**
 * Mint a consumer API key: a high-entropy random secret and its hash. Only the
 * hash is stored (`api_key.key_hash`); the plaintext is shown to the admin ONCE.
 *
 * API keys are hashed with plain SHA-256, NOT argon2 (as passwords are): the key
 * is 256 bits of randomness, so there's nothing to brute-force, and a
 * deterministic hash is required for the O(1) unique lookup in
 * `auth_resolve_api_key(key_hash)`. A salted/slow hash would make that lookup
 * impossible.
 */
export function generateApiKey(): { key: string; hash: string } {
  const key = PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key) };
}

/** Hash a presented key for storage / lookup. Deterministic (SHA-256 hex). */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
