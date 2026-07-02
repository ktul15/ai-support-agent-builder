import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proxy the API's SSE ingestion-status stream, attaching the session JWT. The
 * browser opens an EventSource here (cookie sent automatically); we pipe the
 * upstream event-stream body straight through. no-transform so nothing buffers
 * or re-compresses the stream.
 */
export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (!sessionToken()) return new Response('unauthorized', { status: 401 });
  // Guard the path param before interpolating — no path-traversal into other
  // API endpoints (the API also 404s a non-uuid; this makes it explicit).
  if (!UUID_RE.test(params.id)) return new Response('invalid id', { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/documents/${params.id}/events`, {
      headers: { ...bearer(), accept: 'text/event-stream' },
      cache: 'no-store',
      // Forward the client's disconnect so the upstream SSE is aborted instead
      // of lingering until the API's 5-min cap.
      signal: req.signal,
    });
  } catch {
    return new Response('upstream unavailable', { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response('stream error', { status: upstream.status || 502 });
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
