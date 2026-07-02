/**
 * End-to-end proof of admin auth (issue #10).
 *
 * Drives the real Express app (createApp) over HTTP: signup mints a token via
 * the auth_create_tenant_and_owner SECURITY DEFINER bootstrap, login verifies
 * argon2 credentials, and the issued JWT is shown to drive RLS through the #9
 * tenantContext + withTenant path. Asserts the security-relevant negatives too
 * (wrong password, unknown email, duplicate signup). Exits non-zero on failure.
 *
 *   DATABASE_URL=<asab_app>  DIRECT_DATABASE_URL=<owner>  tsx scripts/verify-auth.ts
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { disconnectDb, withTenant } from '../src/db.js';
import { verifyTenantToken } from '../src/auth/tenant-token.js';
import { makeTenantContext, requireTenant } from '../src/middleware/tenant-context.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env') });

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL (owner) required to inspect/cleanup');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET required');

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } }); // bypasses RLS

// Unique email per run so reruns don't collide on the global-uniqueness check.
const EMAIL = `owner-${randomUUID()}@acme.test`;
const PASSWORD = 'correct horse battery staple';

let failures = 0;
const created: string[] = [];
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

async function main() {
  // Real app for signup/login; a separately-mounted protected route proves the
  // issued token drives RLS end-to-end.
  const app = createApp();
  app.get('/me/users', makeTenantContext(SECRET!), (req, res) => {
    withTenant(requireTenant(req).tenantId, async (tx) => {
      const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM app_user`;
      return Number(r[0]!.n);
    })
      .then((count) => res.json({ count }))
      .catch((e) => res.status(500).json({ error: String(e) }));
  });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // 1. Signup creates tenant + owner and returns a usable token.
  const signupRes = await post('/auth/signup', {
    tenantName: 'Acme Inc',
    email: EMAIL,
    password: PASSWORD,
  });
  const signupBody = (await signupRes.json()) as { token?: string };
  check(
    'signup returns 201 + token',
    signupRes.status === 201 && !!signupBody.token,
    `status ${signupRes.status}`,
  );

  let tenantId = '';
  if (signupBody.token) {
    const claims = await verifyTenantToken(signupBody.token, SECRET!);
    tenantId = claims.tenantId;
    created.push(tenantId);
    check('issued token carries tenantId + userId', !!claims.tenantId && !!claims.userId);
  }

  // 2. The owner row really exists (inspected as the RLS-bypassing owner).
  const ownerRows = await owner.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM app_user WHERE tenant_id = ${tenantId}::uuid AND role = 'OWNER'`;
  check(
    'tenant has exactly one OWNER user',
    Number(ownerRows[0]!.n) === 1,
    `saw ${ownerRows[0]!.n}`,
  );

  // 3. The issued token drives RLS: it sees only its own tenant's users.
  const meRes = await fetch(`${base}/me/users`, {
    headers: { authorization: `Bearer ${signupBody.token}` },
  });
  const meBody = (await meRes.json()) as { count?: number };
  check(
    'token scopes RLS to its own tenant (1 user)',
    meRes.status === 200 && meBody.count === 1,
    `count ${meBody.count}`,
  );

  // 3b. Signup provisioned exactly one default assistant, and GET /assistants
  //     (token-scoped) returns it — the admin's upload/publish target.
  const asstRows = await owner.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM assistant WHERE tenant_id = ${tenantId}::uuid`;
  const asstRes = await fetch(`${base}/assistants`, {
    headers: { authorization: `Bearer ${signupBody.token}` },
  });
  const asstBody = (await asstRes.json()) as {
    assistants?: { id: string; name: string; status: string }[];
  };
  check(
    'signup provisions a default assistant, listed by GET /assistants',
    Number(asstRows[0]!.n) === 1 &&
      asstRes.status === 200 &&
      asstBody.assistants?.length === 1 &&
      asstBody.assistants[0]!.name === 'Default assistant' &&
      typeof asstBody.assistants[0]!.id === 'string',
    `db=${asstRows[0]!.n} listed=${asstBody.assistants?.length}`,
  );

  // 3c. The threshold tuner: PATCH /assistants/:id persists the refusal threshold.
  const asstId = asstBody.assistants![0]!.id;
  const patchRes = await fetch(`${base}/assistants/${asstId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ refusalThreshold: 0.6 }),
  });
  const thrRows = await owner.$queryRaw<{ t: number }[]>`
    SELECT refusal_threshold::float8 AS t FROM assistant WHERE id = ${asstId}::uuid`;
  check(
    'PATCH /assistants updates the refusal threshold',
    patchRes.status === 200 && thrRows[0]!.t === 0.6,
    `status=${patchRes.status} threshold=${thrRows[0]?.t}`,
  );

  // 4. Login with correct credentials succeeds.
  const loginRes = await post('/auth/login', { email: EMAIL, password: PASSWORD });
  check('login with correct credentials returns a token', loginRes.status === 200);

  // 5. Wrong password is rejected.
  const badPw = await post('/auth/login', { email: EMAIL, password: 'wrong-password' });
  check('login with wrong password is 401', badPw.status === 401, `status ${badPw.status}`);

  // 6. Unknown email is rejected (and indistinguishable from wrong password).
  const unknown = await post('/auth/login', {
    email: `nobody-${randomUUID()}@x.test`,
    password: PASSWORD,
  });
  check('login with unknown email is 401', unknown.status === 401, `status ${unknown.status}`);

  // 7. Duplicate signup (same email) is rejected.
  const dup = await post('/auth/signup', {
    tenantName: 'Acme 2',
    email: EMAIL,
    password: PASSWORD,
  });
  check('duplicate-email signup is 409', dup.status === 409, `status ${dup.status}`);

  // 8. Concurrent same-email signups: the DB unique index must let exactly one
  //    win (201) and reject the other (409) — proves the TOCTOU race is closed.
  const raceEmail = `race-${randomUUID()}@acme.test`;
  const [r1, r2] = await Promise.all([
    post('/auth/signup', { tenantName: 'R1', email: raceEmail, password: PASSWORD }),
    post('/auth/signup', { tenantName: 'R2', email: raceEmail, password: PASSWORD }),
  ]);
  for (const r of [r1, r2]) {
    if (r.status === 201) {
      const b = (await r.json()) as { token?: string };
      if (b.token) created.push((await verifyTenantToken(b.token, SECRET!)).tenantId);
    }
  }
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  check(
    'concurrent same-email signups: exactly one 201, one 409',
    statuses[0] === 201 && statuses[1] === 409,
    `statuses ${statuses.join(',')}`,
  );

  await new Promise<void>((r) => server.close(() => r()));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    try {
      for (const t of created) {
        await owner.$executeRaw`DELETE FROM tenant WHERE id = ${t}::uuid`;
      }
    } catch (e) {
      console.warn('cleanup failed (non-fatal):', e);
    }
    await disconnectDb();
    await owner.$disconnect();
    console.log(failures === 0 ? '\nAuth: ALL CHECKS PASSED' : `\nAuth: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
