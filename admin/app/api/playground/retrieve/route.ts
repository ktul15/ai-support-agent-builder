import { NextResponse } from 'next/server';
import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Proxy the retrieval-debug endpoint (chosen chunks + scores + gate decision). */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.text();
  try {
    const upstream = await fetch(`${API_URL}/playground/retrieve`, {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body,
      cache: 'no-store',
    });
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}
