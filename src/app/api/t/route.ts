import { getAdmin } from '@/lib/auth/session';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { isBot, recordEvent, StatEvent } from '@/lib/stats';

/** Receives the storefront's statistics beacons (src/lib/track.ts). Always answers 204: the page never waits on it. */
export async function POST(request: Request) {
  const done = new Response(null, { status: 204 });
  try {
    const userAgent = request.headers.get('user-agent') ?? '';
    // robots, browsers that asked not to be tracked, and the owner's own visits are not counted
    if (isBot(userAgent) || request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') return done;
    const ip = await clientIp();
    if (!rateLimit(`stats:${ip}`, 180, 5 * 60 * 1000).ok) return done;

    const event = StatEvent.safeParse(await request.json().catch(() => null));
    if (!event.success) return done;
    if (await getAdmin()) return done;

    const { storefront } = await getSettings();
    await recordEvent(event.data, { ip, userAgent, host: new URL(request.url).hostname, ordersEnabled: storefront.ordersEnabled });
  } catch (err) {
    console.error('[stats] could not record event', err);
  }
  return done;
}
