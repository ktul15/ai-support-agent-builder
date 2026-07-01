import { z } from 'zod';

// Mirror the API's auth contracts so bad input is rejected at the BFF before a
// wasted round-trip. Password min 8 on signup matches the API.
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const signupSchema = z.object({
  tenantName: z.string().trim().min(1, 'Business name is required').max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;

const PUBLIC_PATHS = new Set(['/login', '/signup']);

/**
 * Whether a path requires an authenticated session. Public auth pages, Next
 * internals, and the BFF route handlers (which self-gate) are exempt; every
 * other app route is protected.
 */
export function isProtectedPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return false;
  if (pathname.startsWith('/api/')) return false; // route handlers gate themselves
  if (pathname.startsWith('/_next')) return false;
  if (pathname === '/favicon.ico') return false;
  return true;
}

/**
 * Sanitize a post-login redirect target (the `?next=` param). Only a local
 * absolute path (single leading `/`) is allowed — `//host`, `http://…`, and
 * anything else fall back to `/dashboard`, so `next` can't become an open
 * redirect to an attacker's site.
 */
export function safeInternalPath(next: string | null | undefined): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/dashboard';
}

/** Map an upstream API status to a user-facing message (never leak internals). */
export function mapAuthError(status: number): string {
  switch (status) {
    case 400:
      return 'Please check the form and try again.';
    case 401:
      return 'Incorrect email or password.';
    case 409:
      return 'An account with that email already exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
