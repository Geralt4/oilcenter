import { headers } from 'next/headers';

/*
 * Small in-memory sliding-window limiter for login, checkout and the contact form.
 * Good enough for a single Node process; behind several instances move this to the database.
 */
const buckets = new Map<string, { hits: number[]; windowMs: number }>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (buckets.get(key)?.hits ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, { hits, windowMs });
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, { hits, windowMs });
  // Housekeeping, at most once a minute. Each bucket is judged by ITS OWN window: a 5-minute limiter passing by must
  // not throw away the still-running hour of a login limiter.
  if (buckets.size > 5000 && now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (!b.hits.some((t) => now - t < b.windowMs)) buckets.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // TRUSTED_PROXY_HOPS = how many proxies append to X-Forwarded-For between the client and this app.
    // Each of them adds the address it was called from, so the real client is that many entries from the right:
    // with one proxy it is the LAST entry (whatever stands to its left came from the client and can be forged).
    // Default 0 → leftmost, which is correct on hosts whose edge overwrites the header (e.g. Railway).
    const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS) || 0));
    const ip = hops > 0 ? (chain[chain.length - hops] ?? chain[0]) : chain[0];
    if (ip) return ip;
  }
  return h.get('x-real-ip') || 'local';
}
