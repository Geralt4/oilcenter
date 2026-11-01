import { createHash } from 'node:crypto';
import type { ShopSettings } from '@/lib/settings';
import { buildSkroutzFeed, type SkroutzFeed } from '@/lib/skroutz-feed';

/*
 * The finished feed, kept in memory for the anonymous readers of /feeds/skroutz.xml.
 *
 * Building it reloads the whole catalogue, so it must not happen once per request. The app runs as one process, so a
 * module-level variable is enough (a second instance would just hold its own copy).
 *
 *  - Lives for `ttlMs`. Sales start and end by the clock, and orders change counted stock, without anyone saving anything
 *    in the admin: the TTL is what keeps those close enough.
 *  - Requests that arrive while a build is running wait for it instead of starting their own.
 *  - Admin actions that change what the feed shows call invalidateSkroutzFeed() (src/app/admin/actions.ts).
 *  - An entry is only used for the settings it was built with: the Skroutz group and the VAT rate are the only settings the
 *    feed reads, so a change to them never serves an old availability phrase, quantity or VAT, even if a hook were missed.
 *
 * The admin Skroutz page and an admin opening the XML do not come through here: they always build fresh.
 */

/** Mutable on purpose, read at call time, so a test can shorten the TTL to milliseconds. */
export const feedCacheLimits = { ttlMs: 15 * 60_000 };

export type CachedFeed = { feed: SkroutzFeed; etag: string };

type Entry = CachedFeed & { builtAt: number; key: string };

let entry: Entry | null = null;
let inflight: { key: string; promise: Promise<Entry> } | null = null;
/** bumped by every invalidation: a build that started before one is answered to its waiters but never stored */
let generation = 0;

const settingsKey = (settings: ShopSettings) => JSON.stringify([settings.skroutz, settings.tax.vatRate]);

/** Drops the cached file and forgets any build in progress, so the next request builds from the data as it is now. */
export function invalidateSkroutzFeed(): void {
  generation++;
  entry = null;
  inflight = null;
}

export async function getCachedSkroutzFeed(settings: ShopSettings, build: typeof buildSkroutzFeed = buildSkroutzFeed): Promise<CachedFeed> {
  const key = settingsKey(settings);
  if (entry && entry.key === key && Date.now() - entry.builtAt < feedCacheLimits.ttlMs) return entry;
  if (inflight && inflight.key === key) return inflight.promise;

  const startedIn = generation;
  const promise = (async (): Promise<Entry> => {
    const feed = await build(settings);
    const built: Entry = { feed, etag: `"${createHash('sha1').update(feed.xml).digest('base64url')}"`, builtAt: Date.now(), key };
    if (generation === startedIn) entry = built;
    return built;
  })();
  const mine = { key, promise };
  inflight = mine;
  try {
    return await promise;
  } finally {
    // a failed build is not remembered; a newer build (after an invalidation or a settings change) must not be forgotten
    if (inflight === mine) inflight = null;
  }
}
