/** Name of the httpOnly cookie holding the API JWT. */
export const SESSION_COOKIE = 'asab_session';

/** JWT lifetime mirrors the API's 1h token expiry. */
const MAX_AGE_SECONDS = 60 * 60;

/**
 * Cookie options for the session JWT. httpOnly so browser JS can't read it
 * (XSS-safe); sameSite=lax to blunt CSRF; secure in production (HTTPS only).
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}
