import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';
import { isProtectedPath } from '@/lib/auth';

/**
 * Route protection: unauthenticated requests to protected pages redirect to
 * /login (preserving the target as ?next=); authenticated requests to /login or
 * /signup redirect to /dashboard.
 *
 * The signal is PRESENCE of the httpOnly session cookie — not its validity. This
 * is UX gating, NOT the security boundary: the API re-verifies the JWT on every
 * data call and 401s a forged/expired token. INVARIANT for later issues: any
 * protected server component that reads tenant data MUST re-verify the JWT
 * server-side; never trust this presence check alone.
 */
export function middleware(req: NextRequest): NextResponse {
  const authed = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = req.nextUrl;

  if (isProtectedPath(pathname) && !authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if ((pathname === '/login' || pathname === '/signup') && authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
