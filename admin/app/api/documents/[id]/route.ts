import { NextResponse } from 'next/server';
import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Proxy a document delete (removes chunks via cascade + the stored object). */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    const upstream = await fetch(`${API_URL}/documents/${params.id}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    // The API returns 204 with no body on success.
    if (upstream.status === 204) return NextResponse.json({ ok: true });
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}
