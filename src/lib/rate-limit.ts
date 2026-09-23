import { headers } from 'next/headers';

/*
 * Small in-memory sliding-window limiter for login, checkout and the contact form.
 * Good enough for a single Node process; behind several instances move this to the database.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  return { ok: true, retryAfterSec: 0 };
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // TRUSTED_PROXY_HOPS = how many proxies append to X-Forwarded-For between the client and this app.
    // The real client is that many entries from the right. Default 0 → leftmost, which is correct on hosts
    // whose edge overwrites the header (e.g. Railway). Behind an appending reverse proxy (nginx/Caddy) set it
    // to the hop count, so a client-supplied (spoofed) leftmost entry can't be used to dodge the rate limit.
    const hops = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS) || 0);
    const ip = hops > 0 ? chain[chain.length - 1 - hops] : chain[0];
    if (ip) return ip;
  }
  return h.get('x-real-ip') || 'local';
}
