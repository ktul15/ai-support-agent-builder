import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { signTenantToken, verifyTenantToken, TokenError } from './tenant-token.js';

const SECRET = 'test-secret-at-least-32-characters-long-xx';
const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const ASSISTANT = '33333333-3333-3333-3333-333333333333';

const key = new TextEncoder().encode(SECRET);

describe('tenant-token', () => {
  it('round-trips full claims', async () => {
    const token = await signTenantToken(
      { tenantId: TENANT, userId: USER, assistantId: ASSISTANT },
      SECRET,
    );
    await expect(verifyTenantToken(token, SECRET)).resolves.toEqual({
      tenantId: TENANT,
      userId: USER,
      assistantId: ASSISTANT,
    });
  });

  it('round-trips a minimal (tenant-only) token', async () => {
    const token = await signTenantToken({ tenantId: TENANT }, SECRET);
    await expect(verifyTenantToken(token, SECRET)).resolves.toEqual({
      tenantId: TENANT,
      userId: undefined,
      assistantId: undefined,
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signTenantToken(
      { tenantId: TENANT },
      'a-completely-different-secret-value-xx',
    );
    await expect(verifyTenantToken(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signTenantToken({ tenantId: TENANT }, SECRET, past);
    await expect(verifyTenantToken(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects a tampered signature', async () => {
    const token = await signTenantToken({ tenantId: TENANT }, SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    await expect(verifyTenantToken(tampered, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects a token with no tenant claim', async () => {
    const token = await new SignJWT({ sub: USER })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await expect(verifyTenantToken(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects a token whose tenant claim is not a uuid', async () => {
    const token = await new SignJWT({ tid: 'not-a-uuid' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await expect(verifyTenantToken(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  // The whole security value of verifyTenantToken is pinning HS256 and refusing
  // an attacker-chosen algorithm. These guard against a regression that drops
  // the `algorithms` option and reopens the classic forgery hole.
  it('rejects an unsigned alg:none token', async () => {
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const forged = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ tid: TENANT, exp })}.`;
    await expect(verifyTenantToken(forged, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects a token signed with a non-pinned algorithm (HS512)', async () => {
    const token = await new SignJWT({ tid: TENANT })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await expect(verifyTenantToken(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });
});
