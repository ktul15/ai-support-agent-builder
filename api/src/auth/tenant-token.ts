import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * The tenant identity carried by an access token. `tenantId` is the ONLY source
 * of truth for tenant scoping — it is read from the cryptographically verified
 * token, never from a header, query, or body the client controls. This is the
 * value the tenant-context middleware feeds into `SET LOCAL app.tenant_id`, so
 * Postgres RLS gates every query (issue #8).
 */
export interface TenantClaims {
  tenantId: string;
  userId?: string;
  /** Present on assistant-scoped (mobile/consumer) tokens. */
  assistantId?: string;
}

/** Thrown for any invalid/expired/malformed token. Carries no detail to clients. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

const HS256 = 'HS256';

// Validate the decoded payload shape. tid/aid/sub are compact registered-style
// claim names; uuids are required so a malformed value can never reach SET LOCAL.
const payloadSchema = z.object({
  tid: z.string().uuid(),
  sub: z.string().uuid().optional(),
  aid: z.string().uuid().optional(),
});

function keyFrom(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Mint a signed access token. Issuance proper (login/api-key exchange) is issue
 * #10; this is the shared signer so tokens always match what verify expects.
 */
export async function signTenantToken(
  claims: TenantClaims,
  secret: string,
  expiresIn: string | number = '1h',
): Promise<string> {
  return new SignJWT({ tid: claims.tenantId, sub: claims.userId, aid: claims.assistantId })
    .setProtectedHeader({ alg: HS256 })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(keyFrom(secret));
}

/**
 * Verify a token's signature + expiry and return typed claims. Pins the
 * algorithm to HS256 (never trusts the token header's `alg`, defeating the
 * classic alg-confusion / `none` attacks). Throws `TokenError` on anything
 * invalid — the caller maps that to 401 without leaking why.
 */
export async function verifyTenantToken(token: string, secret: string): Promise<TenantClaims> {
  let raw: unknown;
  try {
    // requiredClaims: ['exp'] rejects a validly-signed but non-expiring token —
    // a safety net if a future issuance path (issue #10) forgets to set expiry.
    const { payload } = await jwtVerify(token, keyFrom(secret), {
      algorithms: [HS256],
      requiredClaims: ['exp'],
    });
    raw = payload;
  } catch (err) {
    throw new TokenError(`invalid token: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TokenError('token payload missing/invalid tenant claim');
  }
  return { tenantId: parsed.data.tid, userId: parsed.data.sub, assistantId: parsed.data.aid };
}
