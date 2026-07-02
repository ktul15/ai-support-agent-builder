import { NextResponse } from 'next/server';
import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function proxy(id: string, method: 'GET' | 'POST'): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  try {
    const upstream = await fetch(`${API_URL}/assistants/${id}/api-keys`, {
      method,
      headers: bearer(),
      cache: 'no-store',
    });
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}

/** List the assistant's API keys (metadata only). */
export function GET(_req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  return proxy(params.id, 'GET');
}

/** Mint a new API key (plaintext returned once in the response). */
export function POST(_req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  return proxy(params.id, 'POST');
}
