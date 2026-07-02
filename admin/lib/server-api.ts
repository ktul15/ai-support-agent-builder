import { cookies } from 'next/headers';
import { API_URL } from './config';
import { SESSION_COOKIE } from './session';

/** The API JWT from the httpOnly session cookie (server-side only). */
export function sessionToken(): string | undefined {
  return cookies().get(SESSION_COOKIE)?.value;
}

/** Bearer auth header for proxying to the Express API (empty when no session). */
export function bearer(): Record<string, string> {
  const token = sessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export { API_URL };
