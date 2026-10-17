import { NextResponse } from 'next/server';
import { getAdmin } from '@/lib/auth/session';
import { normalizeProductPhoto } from '@/lib/images';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { isUploadKind, readBodyLimited, stageUpload, UPLOAD_LIMITS } from '@/lib/uploads';

/*
 * Authenticated upload endpoint for large admin files (photos, SDS PDFs, CSV imports). It lives
 * outside the proxy's buffered body path and outside the ordinary server-action limit; the bytes are
 * read here with a hard cap, validated by kind, and staged behind a single-use token.
 *
 * Order matters: authentication first, then the rate limit, then the body. An unauthenticated request
 * never gets to stream a body into memory.
 */
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const admin = await getAdmin();
  if (!admin) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const limited = await rateLimit(`admin-upload:${await clientIp()}:${admin.id}`, 60, 10 * 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: 'too_many_uploads' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });

  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  if (!isUploadKind(kind)) return NextResponse.json({ error: 'unknown_kind' }, { status: 400 });

  const max = UPLOAD_LIMITS[kind];
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return NextResponse.json({ error: 'too_large' }, { status: 413 });

  const raw = await readBodyLimited(request.body, max);
  if (raw === null) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  if (raw.byteLength === 0) return NextResponse.json({ error: 'empty' }, { status: 400 });

  let data = raw;
  if (kind === 'photo') {
    try {
      // Re-encoding also proves the bytes really are a raster image (SVG is blocked in lib/images.ts).
      data = (await normalizeProductPhoto(raw)).data;
    } catch {
      return NextResponse.json({ error: 'not_an_image' }, { status: 415 });
    }
  } else if (kind === 'sds') {
    if (raw.subarray(0, 5).toString('latin1') !== '%PDF-') return NextResponse.json({ error: 'not_a_pdf' }, { status: 415 });
  }

  const name = (request.headers.get('x-filename') ?? 'file').slice(0, 160);
  const token = await stageUpload(admin.id, kind, name, data);
  return NextResponse.json({ token });
}
