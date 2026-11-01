import type { NextRequest } from 'next/server';
import { getAdmin } from '@/lib/auth/session';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { buildSkroutzFeed, recordFeedFetch } from '@/lib/skroutz-feed';
import { getCachedSkroutzFeed } from '@/lib/skroutz-feed-cache';

export const dynamic = 'force-dynamic';

/*
 * The file skroutz.gr downloads (see lib/skroutz-feed.ts). Skroutz asks for it about once an hour.
 *
 * Closed (404) until the owner switches it on in Admin → Skroutz. A logged-in admin can always open it, to check it
 * or to upload it to validator.skroutz.gr; ?download=1 saves it as a file. SkroutzBot cannot log in anywhere, so while
 * SITE_PASSWORD locks the site (proxy.ts) it cannot read this either — nor the product pages and photos it checks.
 *
 * Anonymous readers get the finished file from memory (lib/skroutz-feed-cache.ts: 15 minutes, rebuilt at once when the
 * owner changes something it shows), at most RATE_LIMIT requests per RATE_WINDOW_MS per address, and a 304 when their copy is
 * current. An admin is not limited and always gets a file built from the data as it is this very moment.
 */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60_000;

/** If-None-Match is a list of validators, any of them may carry W/ */
const etagMatches = (header: string | null, etag: string) => !!header && header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*');

export async function GET(request: NextRequest) {
  const settings = await getSettings();
  const admin = await getAdmin();
  if (!settings.skroutz.feedEnabled && !admin) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  if (!admin) {
    const limit = await rateLimit(`skroutz-feed:${await clientIp()}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!limit.ok) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec), 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // the owner's own previews are never cached and are not "Skroutz read the file"
  const cached = admin ? null : await getCachedSkroutzFeed(settings);
  const feed = cached?.feed ?? (await buildSkroutzFeed(settings));
  if (!admin) await recordFeedFetch(request.headers.get('user-agent') ?? '', feed.items.length).catch(() => undefined);

  const download = request.nextUrl.searchParams.has('download');
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': admin ? 'no-store' : 'public, max-age=0, must-revalidate',
    'X-Robots-Tag': 'noindex',
  };
  if (cached) headers.ETag = cached.etag;
  if (cached && !download && etagMatches(request.headers.get('if-none-match'), cached.etag)) return new Response(null, { status: 304, headers });
  if (download) headers['Content-Disposition'] = `attachment; filename="skroutz-feed-${feed.createdAt.toISOString().slice(0, 10)}.xml"`;
  return new Response(feed.xml, { headers });
}
