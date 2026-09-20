import type { NextRequest } from 'next/server';
import { getAdmin } from '@/lib/auth/session';
import { getSettings } from '@/lib/settings.server';
import { buildSkroutzFeed, recordFeedFetch } from '@/lib/skroutz-feed';

export const dynamic = 'force-dynamic';

/*
 * The file skroutz.gr downloads (see lib/skroutz-feed.ts). It is built on every request, so it always carries the
 * prices of this very moment; Skroutz asks for it about once an hour.
 *
 * Closed (404) until the owner switches it on in Admin → Skroutz. A logged-in admin can always open it, to check it
 * or to upload it to validator.skroutz.gr; ?download=1 saves it as a file. SkroutzBot cannot log in anywhere, so while
 * SITE_PASSWORD locks the site (proxy.ts) it cannot read this either — nor the product pages and photos it checks.
 */
export async function GET(request: NextRequest) {
  const settings = await getSettings();
  const admin = await getAdmin();
  if (!settings.skroutz.feedEnabled && !admin) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  const feed = await buildSkroutzFeed(settings);
  // the owner's own previews are not "Skroutz read the file"
  if (!admin) await recordFeedFetch(request.headers.get('user-agent') ?? '', feed.items.length).catch(() => undefined);

  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': admin ? 'no-store' : 'public, max-age=0, must-revalidate',
    'X-Robots-Tag': 'noindex',
  };
  if (request.nextUrl.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="skroutz-feed-${feed.createdAt.toISOString().slice(0, 10)}.xml"`;
  return new Response(feed.xml, { headers });
}
