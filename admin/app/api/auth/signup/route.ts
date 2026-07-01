import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/config';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { signupSchema, mapAuthError } from '@/lib/auth';

/** BFF signup: validate -> call the API -> set the JWT httpOnly cookie. */
export async function POST(req: Request): Promise<NextResponse> {
  const parsed = signupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Please check the form and try again.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/auth/signup`, {
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
