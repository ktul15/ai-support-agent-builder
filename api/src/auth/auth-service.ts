import { prisma } from '../db.js';
import { getConfig } from '../config.js';
import { hashPassword, verifyPassword } from './password.js';
import { signTenantToken } from './tenant-token.js';

/** Expected auth failure (bad credentials, taken email). Maps to a 4xx. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SignupInput {
  tenantName: string;
  email: string;
  password: string;
}
export interface LoginInput {
  email: string;
  password: string;
}
export interface AuthResult {
  token: string;
  tenantId: string;
  userId: string;
}

// A valid argon2id hash used to equalize work when no user matches, so login
// timing doesn't reveal whether an email exists (user enumeration).
// COUPLING: its cost params (m=19456,t=2,p=1) must match @node-rs/argon2's
// current hash() defaults. If that default changes (or hashPassword starts
// passing options), re-derive this hash or the timing equalization breaks.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$1z9fmYLDxziaT+rU+ImbTg$abr8wd9HpjYd1lr/iq/NRUvOMXU30XkN61NL1M4ZpVg';

function isEmailTaken(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err);
  return (
    s.includes('email already registered') || s.includes('unique_violation') || s.includes('23505')
  );
}

async function issue(tenantId: string, userId: string): Promise<AuthResult> {
  const token = await signTenantToken({ tenantId, userId }, getConfig().JWT_SECRET);
  return { token, tenantId, userId };
}

/**
 * Create a tenant + its owner user and return a session token. Privileged DDL
 * runs inside the auth_create_tenant_and_owner SECURITY DEFINER function (the
 * pre-tenant-context bootstrap), so the app stays on the restricted role.
 */
export async function signup(input: SignupInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  let rows: { tenant_id: string; user_id: string }[];
  try {
    rows = await prisma.$queryRaw`
      SELECT tenant_id, user_id
      FROM auth_create_tenant_and_owner(${input.tenantName}, ${input.email}, ${passwordHash})`;
  } catch (err) {
    if (isEmailTaken(err)) throw new AuthError('email already registered', 409);
    throw err;
  }
  const row = rows[0]!;
  return issue(row.tenant_id, row.user_id);
}

/**
 * Verify credentials and return a session token. Always runs an argon2 verify
 * (against a dummy hash when the email is unknown) so the response time doesn't
 * leak whether the account exists. All failures collapse to one generic error.
 */
export async function login(input: LoginInput): Promise<AuthResult> {
  const rows: { user_id: string; tenant_id: string; password_hash: string; role: string }[] =
    await prisma.$queryRaw`
      SELECT user_id, tenant_id, password_hash, role
      FROM auth_find_user_by_email(${input.email})`;
  const user = rows[0];
  const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, input.password);
  if (!user || !ok) throw new AuthError('invalid credentials', 401);
  return issue(user.tenant_id, user.user_id);
}
