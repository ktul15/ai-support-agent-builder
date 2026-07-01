/**
 * Server-side base URL of the Express API. The admin uses a BFF: browser forms
 * post to Next Route Handlers, which call this API server-side and set an
 * httpOnly cookie — so the JWT and this URL are never exposed to the browser.
 */
export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
