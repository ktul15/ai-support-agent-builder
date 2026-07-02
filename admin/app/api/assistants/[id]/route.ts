import { NextResponse } from 'next/server';
import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Proxy an assistant tuning update (e.g. the refusal threshold). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const body = await req.text();
  try {
    const upstream = await fetch(`${API_URL}/assistants/${params.id}`, {
      method: 'PATCH',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body,
    });
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}
