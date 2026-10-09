import { createHash, createHmac } from 'node:crypto';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
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
      if (slug && (first === 'product' || first === 'category' || first === 'brand')) await bump(day, first, slug);
      if (first === 'checkout' && !ctx.ordersEnabled) await bump(day, 'checkout_closed');
      if (await isNewVisitorToday(day, ctx.ip, ctx.userAgent)) {
        await bump(day, 'visitor');
        await bump(day, 'device', deviceClass(event.w, ctx.userAgent));
        await bump(day, 'source', sourceOf(event.ref, ctx.host));
      }
      return;
    }
    case 'search': {
      const q = normalizeText(event.q).slice(0, 60);
      if (q.length < 2) return;
      await bump(day, event.n === 0 ? 'search_empty' : 'search', q);
      return;
    }
    case 'cart':
      return bump(day, 'cart', event.slug);
    case 'click':
      return bump(day, 'click', event.what);
  }
}

export const recordSignup = () => bump(athensDay(), 'signup');

// ─── Reading ─────────────────────────────────────────────────────────────────
export type DayPoint = { day: string; visitors: number; pageviews: number };

const since = (days: number) => athensDay(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));

export async function dailySeries(days: number): Promise<DayPoint[]> {
  const rows = await db
    .select({ day: statCounters.day, kind: statCounters.kind, n: sql<number>`sum(${statCounters.count})` })
    .from(statCounters)
    .where(and(gte(statCounters.day, since(days)), sql`${statCounters.kind} in ('visitor', 'pageview')`))
    .groupBy(statCounters.day, statCounters.kind);
  const byDay = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const day = athensDay(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
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
