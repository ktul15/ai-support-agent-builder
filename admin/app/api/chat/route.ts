import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/**
 * Proxy the chat SSE stream. The browser POSTs {assistantId, question} here
 * (EventSource can't POST, so the client reads this with fetch streaming); we
 * forward with the session JWT and pipe the event-stream body straight back.
 */
export async function POST(req: Request): Promise<Response> {
  if (!sessionToken()) return new Response('unauthorized', { status: 401 });
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
      signal: req.signal, // client disconnect aborts the upstream generation
      cache: 'no-store',
    });
  } catch {
    return new Response('upstream unavailable', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response('chat error', { status: upstream.status || 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
