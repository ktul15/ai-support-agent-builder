import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/config';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { loginSchema, mapAuthError } from '@/lib/auth';

/**
 * BFF: validate, call the Express API server-side, and on success stash the JWT
 * in an httpOnly cookie. The token never touches browser JS.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please enter a valid email and password.' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server. Try again shortly.' }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: mapAuthError(upstream.status) }, { status: upstream.status });
  }

  const data = (await upstream.json().catch(() => null)) as { token?: string } | null;
  if (!data?.token) {
    return NextResponse.json({ error: 'Unexpected server response.' }, { status: 502 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, data.token, sessionCookieOptions());
  return res;
}
