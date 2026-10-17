import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

/*
 * Persistent fixed-window limiter.
 *
 * Counters live in SQLite (rate_limits), so a deploy or crash does NOT hand an attacker a fresh set
 * of attempts. The consume-and-read is one UPSERT ... RETURNING: two concurrent try-alls cannot both
 * take the last slot, and SQLite serialises the writes.
 *
 * Fixed windows allow a burst of up to 2× the limit around a window boundary; that is the deliberate
 * trade for a single atomic statement. Every caller here uses windows of 30 minutes or less, and the
 * attempt budget is low enough that the boundary burst is not meaningful.
 *
 * Keys are hashed before storage: the table never contains an IP address or an e-mail address.
 */

const SWEEP_AGE_MS = 2 * 60 * 60 * 1000; // every caller uses windows <= 30 min
let lastSweep = 0;

export type LimitResult = { ok: boolean; retryAfterSec: number };

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
  const hashed = createHash('sha256').update(key).digest('hex');
  const now = Date.now();
  const cutoff = now - windowMs;

  const rows = await db.all<{ hits: number; window_start: number }>(sql`
    INSERT INTO rate_limits ("key", window_start, hits) VALUES (${hashed}, ${now}, 1)
    ON CONFLICT("key") DO UPDATE SET
      hits = CASE WHEN rate_limits.window_start <= ${cutoff} THEN 1 ELSE rate_limits.hits + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ${cutoff} THEN ${now} ELSE rate_limits.window_start END
    RETURNING hits, window_start
  `);

  const row = rows[0];
  if (!row) return { ok: true, retryAfterSec: 0 };
  const hits = Number(row.hits);
  const windowStart = Number(row.window_start);

  if (now - lastSweep > 60_000) {
    lastSweep = now;
    // Housekeeping is best-effort; it must never turn a denied login into an allowed one.
    await db.run(sql`DELETE FROM rate_limits WHERE window_start < ${now - SWEEP_AGE_MS}`).catch(() => undefined);
  }

  if (hits <= limit) return { ok: true, retryAfterSec: 0 };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
}

export async function clientIp(): Promise<string> {
  const { headers } = await import('next/headers');
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // TRUSTED_PROXY_HOPS = how many proxies append to X-Forwarded-For between the client and this app.
    // Each of them adds the address it was passed from, so the real client is that many entries from the right:
    // with one proxy it is the LAST entry (whatever stands to its left came from the client and can be forged).
    // Default 0 → leftmost, which is correct on hosts whose edge overwrites the header (e.g. Railway).
    const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS) || 0));
    const ip = hops > 0 ? (chain[chain.length - hops] ?? chain[0]) : chain[0];
    if (ip) return ip;
  }
  return h.get('x-real-ip') || 'local';
}

/**
 * Budgets on top of the per-IP+account keys above. A per-IP+email key stops one attacker hammering ONE account,
 * but password spraying — few tries against MANY e-mails from one machine — would never trip it. Every login
 * attempt also spends from a per-IP pool, so an attacker runs out after `ipLimit` tries across ALL accounts.
 * Checked BEFORE the credential is verified; a failed attempt is what a budget is for, and a successful one
 * spending a hit costs a real user nothing in practice.
 */
export async function loginBudgets(name: string, ipLimit: number, windowMs: number): Promise<LimitResult> {
  const ip = await clientIp();
  return rateLimit(`${name}:ip:${ip}`, ipLimit, windowMs);
}
