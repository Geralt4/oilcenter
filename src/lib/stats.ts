import { createHash, createHmac } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { catalogSlugs } from '@/lib/catalog';
import { db } from '@/lib/db';
import { statCounters, statVisitors } from '@/lib/db/schema';
import { normalizeText } from '@/lib/utils';

/*
 * Cookieless statistics. The browser sends tiny events (src/lib/track.ts); this module turns them into daily counters.
 * Nothing is stored on the visitor's device and no visitor-level row survives the day, so no consent banner is needed.
 *
 * kinds:  visitor · pageview(section) · product(slug) · category(slug) · brand(slug) · source(host) · device(class)
 *         search(query) · search_empty(query) · cart(slug) · checkout_closed · click(target) · signup
 */

export const StatEvent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('view'), path: z.string().startsWith('/').max(200), ref: z.string().max(300).optional(), w: z.number().int().min(0).max(10000).optional() }),
  z.object({ t: z.literal('search'), q: z.string().min(1).max(80), n: z.number().int().min(0).max(100000) }),
  z.object({ t: z.literal('cart'), slug: z.string().min(1).max(160) }),
  z.object({ t: z.literal('click'), what: z.enum(['call', 'directions', 'skroutz', 'instagram', 'email']) }),
]);
export type StatEvent = z.infer<typeof StatEvent>;

const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|pingdom|uptime|curl|wget|python|node-fetch|axios/i;
export const isBot = (userAgent: string) => !userAgent || BOT.test(userAgent);

export const athensDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(date);

async function bump(day: string, kind: string, key = ''): Promise<void> {
  await db
    .insert(statCounters)
    .values({ day, kind, key: key.slice(0, 160), count: 1 })
    .onConflictDoUpdate({ target: [statCounters.day, statCounters.kind, statCounters.key], set: { count: sql`${statCounters.count} + 1` } });
}

/*
 * Bounded growth. Every counter key that comes from the visitor (a slug in the address, a search, a referrer host) would
 * otherwise create a new row per distinct value, so anyone could grow the table at will. Slugs are counted only when the
 * page exists; free text gets at most `dailyNewKeys` distinct keys a day per group, and the rest one shared key.
 */
export const statLimits = {
  /** distinct new keys a day for searches (search + search_empty together) and, separately, for referrer hosts */
  dailyNewKeys: 300,
  /** how long the list of existing slugs is reused before it is read again */
  slugTtlMs: 5 * 60 * 1000,
};
export const OTHER_SEARCH = 'άλλη αναζήτηση';
export const OTHER_SOURCE = 'άλλη πηγή';

type KnownSlugs = Awaited<ReturnType<typeof catalogSlugs>>;
let knownSlugs: { at: number; slugs: KnownSlugs } | null = null;
let loadingSlugs: Promise<KnownSlugs> | null = null;

/** The shop's slugs, read once per `slugTtlMs` (one load at a time), not once per page view. */
async function existingSlugs(): Promise<KnownSlugs> {
  if (knownSlugs && Date.now() - knownSlugs.at < statLimits.slugTtlMs) return knownSlugs.slugs;
  loadingSlugs ??= catalogSlugs()
    .then((slugs) => {
      knownSlugs = { at: Date.now(), slugs };
      return slugs;
    })
    .finally(() => {
      loadingSlugs = null;
    });
  return loadingSlugs;
}

/** For tests and after catalogue changes that must show at once: the next view reads the slugs again. */
export function forgetStatSlugs(): void {
  knownSlugs = null;
}

/**
 * Bumps an existing key, or adds a new one while the day still has room in its group; once the group has
 * `dailyNewKeys` distinct keys, a new value is counted under `overflow` instead.
 */
async function bumpCapped(day: string, kind: string, key: string, group: string[], overflow: string): Promise<void> {
  const existing = await db
    .update(statCounters)
    .set({ count: sql`${statCounters.count} + 1` })
    .where(and(eq(statCounters.day, day), eq(statCounters.kind, kind), eq(statCounters.key, key)))
    .returning({ key: statCounters.key });
  if (existing.length) return;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(statCounters)
    .where(and(eq(statCounters.day, day), inArray(statCounters.kind, group), sql`${statCounters.key} <> ${overflow}`));
  await bump(day, kind, Number(n) < statLimits.dailyNewKeys ? key : overflow);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A search as it is counted: no control characters (dropped, not cleaned), lower case, accents and punctuation gone,
 * spaces collapsed, at most 60 characters; '' = not counted.
 */
export function statSearchKey(raw: string): string {
  if (CONTROL.test(raw)) return '';
  const q = normalizeText(raw).slice(0, 60).trim();
  return q.length < 2 ? '' : q;
}

const SECTIONS = ['products', 'product', 'category', 'brand', 'brands', 'cart', 'checkout', 'contact', 'about', 'wishlist', 'order-status', 'account', 'login', 'register'];
function section(path: string): string {
  if (path === '/') return '/';
  const first = path.split('/')[1] ?? '';
  return SECTIONS.includes(first) ? `/${first}` : 'άλλο';
}

function deviceClass(width: number | undefined, userAgent: string): string {
  if (width) return width < 768 ? 'κινητό' : width < 1100 ? 'tablet' : 'υπολογιστής';
  return /mobile|android|iphone/i.test(userAgent) ? 'κινητό' : 'υπολογιστής';
}

function sourceOf(ref: string | undefined, ownHost: string): string {
  if (!ref) return 'απευθείας';
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    if (!host || host === ownHost.replace(/^www\./, '')) return 'απευθείας';
    if (/(^|\.)google\./.test(host)) return 'Google';
    if (/(^|\.)(facebook|fb)\.com$|^l\.facebook\.com$/.test(host)) return 'Facebook';
    if (/(^|\.)instagram\.com$/.test(host)) return 'Instagram';
    if (/(^|\.)skroutz\.gr$/.test(host)) return 'Skroutz';
    return host;
  } catch {
    return 'απευθείας';
  }
}

/** One visitor counts once per day. The salt is derived from the day, and yesterday's hashes are deleted. */
async function isNewVisitorToday(day: string, ip: string, userAgent: string): Promise<boolean> {
  const salt = createHmac('sha256', process.env.AUTH_SECRET || 'dev-only-stats-salt').update(`stats:${day}`).digest('hex');
  const hash = createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 32);
  const inserted = await db.insert(statVisitors).values({ day, hash }).onConflictDoNothing().returning({ day: statVisitors.day });
  if (!inserted.length) return false;
  await db.delete(statVisitors).where(lt(statVisitors.day, day));
  return true;
}

export async function recordEvent(event: StatEvent, ctx: { ip: string; userAgent: string; host: string; ordersEnabled: boolean }): Promise<void> {
  const day = athensDay();
  switch (event.t) {
    case 'view': {
      const path = event.path.split('?')[0].replace(/\/+$/, '') || '/';
      if (path.startsWith('/admin') || path.startsWith('/api')) return;
      await bump(day, 'pageview', section(path));
      const [, first, slug] = path.split('/');
      if (slug && (first === 'product' || first === 'category' || first === 'brand') && (await existingSlugs())[first].has(slug)) await bump(day, first, slug);
      if (first === 'checkout' && !ctx.ordersEnabled) await bump(day, 'checkout_closed');
      if (await isNewVisitorToday(day, ctx.ip, ctx.userAgent)) {
        await bump(day, 'visitor');
        await bump(day, 'device', deviceClass(event.w, ctx.userAgent));
        await bumpCapped(day, 'source', sourceOf(event.ref, ctx.host), ['source'], OTHER_SOURCE);
      }
      return;
    }
    case 'search': {
      const q = statSearchKey(event.q);
      if (!q) return;
      await bumpCapped(day, event.n === 0 ? 'search_empty' : 'search', q, ['search', 'search_empty'], OTHER_SEARCH);
      return;
    }
    case 'cart':
      // the slug of the product added to the cart: counted only for a product the shop lists
      if (!(await existingSlugs()).product.has(event.slug)) return;
      return bump(day, 'cart', event.slug);
    case 'click':
      return bump(day, 'click', event.what);
  }
}

export const recordSignup = () => bump(athensDay(), 'signup');

// ─── Reading ─────────────────────────────────────────────────────────────────
export type DayPoint = { day: string; visitors: number; pageviews: number };

/** The Athens calendar day `n` days before today. Stepped on the calendar, not by 24 h: a clock-change day is 23 or 25 hours long. */
function athensDaysAgo(n: number): string {
  const [y, m, d] = athensDay().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

const since = (days: number) => athensDaysAgo(days - 1);

export async function dailySeries(days: number): Promise<DayPoint[]> {
  const rows = await db
    .select({ day: statCounters.day, kind: statCounters.kind, n: sql<number>`sum(${statCounters.count})` })
    .from(statCounters)
    .where(and(gte(statCounters.day, since(days)), sql`${statCounters.kind} in ('visitor', 'pageview')`))
    .groupBy(statCounters.day, statCounters.kind);
  const byDay = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const day = athensDaysAgo(i);
    byDay.set(day, { day, visitors: 0, pageviews: 0 });
  }
  for (const r of rows) {
    const point = byDay.get(r.day);
    if (point) point[r.kind === 'visitor' ? 'visitors' : 'pageviews'] = Number(r.n);
  }
  return [...byDay.values()];
}

export async function topKeys(kind: string, days: number, limit = 12): Promise<Array<{ key: string; n: number }>> {
  const n = sql<number>`sum(${statCounters.count})`;
  const rows = await db
    .select({ key: statCounters.key, n })
    .from(statCounters)
    .where(and(eq(statCounters.kind, kind), gte(statCounters.day, since(days))))
    .groupBy(statCounters.key)
    .orderBy(desc(n))
    .limit(limit);
  return rows.map((r) => ({ key: r.key, n: Number(r.n) }));
}

export async function total(kind: string, days: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${statCounters.count}), 0)` })
    .from(statCounters)
    .where(and(eq(statCounters.kind, kind), gte(statCounters.day, since(days))));
  return Number(row?.n ?? 0);
}
