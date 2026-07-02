import { NextResponse } from 'next/server';
import { API_URL, bearer, sessionToken } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Proxy the tenant's document list for an assistant (status + chunk count). */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const assistantId = new URL(req.url).searchParams.get('assistantId') ?? '';
  try {
    const upstream = await fetch(
      `${API_URL}/documents?assistantId=${encodeURIComponent(assistantId)}`,
      { headers: bearer(), cache: 'no-store' },
    );
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}

// Reject grossly-oversized bodies BEFORE buffering them (req.formData() would
// materialize the whole upload in memory). Slightly above the API's 20 MiB cap
// so the API still owns the precise limit; this only stops a memory-DoS.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Proxy a document upload: forward the browser's multipart form (file +
 * assistantId) to the API with the session JWT. The token never reaches the
 * browser; the API enforces tenant scope + type/size limits.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionToken()) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File too large.' }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload.' }, { status: 400 });
  }
  try {
    // Pass the FormData straight through — fetch sets the multipart boundary.
    const upstream = await fetch(`${API_URL}/documents`, {
      method: 'POST',
      headers: bearer(),
      body: form,
    });
    const data = (await upstream.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Cannot reach the server.' }, { status: 502 });
  }
}
