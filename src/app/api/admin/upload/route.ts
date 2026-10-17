import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAdmin } from '@/lib/auth/session';
import { normalizeProductPhoto } from '@/lib/images';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { isSameOrigin, isUploadKind, readBodyLimited, stageUpload, uploadLimit } from '@/lib/uploads';

/*
 * Authenticated upload endpoint for large admin files (photos, SDS PDFs, CSV imports). It lives
 * outside the proxy's buffered body path and outside the ordinary server-action limit; the bytes are
 * read here with a hard cap, validated by kind, and staged behind a single-use token.
 *
 * The proxy's protections that still matter for an API are reproduced here: the pre-launch curtain,
 * same-origin/CSRF checks, authentication, rate limiting, and a bounded body read with a deadline.
 */
export const runtime = 'nodejs';

/** At most two uploads parsed at once: a phone photo can hold tens of MB in memory. */
const MAX_CONCURRENT = 2;
let active = 0;

function sameDigest(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Mirrors the SITE_PASSWORD curtain in src/proxy.ts (this route is outside the proxy matcher). */
function previewAuthorised(request: Request): boolean {
  const password = process.env.SITE_PASSWORD;
  if (!password) return true;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const user = process.env.SITE_USER || 'oilcenter';
  return sameDigest(decoded.slice(0, colon), user) && sameDigest(decoded.slice(colon + 1), password);
}

function decodeFileName(header: string | null): string {
  const raw = header ?? 'file';
  try {
    return decodeURIComponent(raw).slice(0, 160);
  } catch {
    return raw.slice(0, 160);
  }
}

export async function POST(request: Request) {
  if (!previewAuthorised(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'cross_origin' }, { status: 403 });

  const admin = await getAdmin();
  if (!admin) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const limited = await rateLimit(`admin-upload:${await clientIp()}:${admin.id}`, 60, 10 * 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: 'too_many_uploads' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });

  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  if (!isUploadKind(kind)) return NextResponse.json({ error: 'unknown_kind' }, { status: 400 });

  const max = uploadLimit(kind);
  if (max <= 0) return NextResponse.json({ error: 'unknown_kind' }, { status: 400 });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return NextResponse.json({ error: 'too_large' }, { status: 413 });

  if (active >= MAX_CONCURRENT) return NextResponse.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '10' } });
  active++;
  try {
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

    const token = await stageUpload(admin.id, kind, decodeFileName(request.headers.get('x-filename')), data);
    return NextResponse.json({ token });
  } finally {
    active--;
  }
}
