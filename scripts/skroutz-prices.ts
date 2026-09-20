import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { priceChanges, variants } from '../src/lib/db/schema';

/* catalog/skroutz-prices.json: the shop's own Skroutz prices, matched by hand to catalogue SKUs. Shared by the seed, the data patches and `npm run prices:skroutz`. */

export type SkroutzMatch = { sku: string; priceCents: number; confidence: 'exact' | 'probable' };

export function loadSkroutzPrices(): Map<string, SkroutzMatch> {
  const file = path.resolve('catalog/skroutz-prices.json');
  if (!existsSync(file)) return new Map();
  const { matches } = JSON.parse(readFileSync(file, 'utf8')) as { matches: SkroutzMatch[] };
  return new Map(matches.filter((m) => Number.isInteger(m.priceCents) && m.priceCents > 0).map((m) => [m.sku, m]));
}

const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

/**
 * Applies the file to an EXISTING database. "exact" matches are marked as confirmed; "probable" ones get the price but
 * stay flagged for the owner to check. A price the owner has already confirmed by hand is never overwritten unless
 * `force` is set. Safe to run twice: a price that is already in place is left alone.
 */
export async function applySkroutzPrices({ force = false, dry = false, verbose = true } = {}): Promise<string> {
  const prices = loadSkroutzPrices();
  const bySku = new Map((await db.select().from(variants)).map((v) => [v.sku, v]));

  let changed = 0, confirmed = 0, kept = 0, same = 0;
  const unknown: string[] = [];
  for (const [sku, match] of prices) {
    const v = bySku.get(sku);
    if (!v) {
      unknown.push(sku);
      continue;
    }
    const verified = match.confidence === 'exact';
    if (v.priceVerified && !force && v.priceCents !== match.priceCents) {
      kept++;
      if (verbose) console.log(`  kept ${sku}: ${eur(v.priceCents)} was confirmed by the owner (Skroutz says ${eur(match.priceCents)})`);
      continue;
    }
    if (v.priceCents === match.priceCents) {
      if (verified && !v.priceVerified) {
        if (!dry) await db.update(variants).set({ priceVerified: true }).where(eq(variants.id, v.id));
        confirmed++;
      } else same++;
      continue;
    }
    if (verbose) console.log(`  ${dry ? 'would set' : 'set'} ${sku}: ${eur(v.priceCents)} → ${eur(match.priceCents)}${verified ? '' : '  (probable match: stays flagged)'}`);
    if (!dry) {
      await db.transaction(async (tx) => {
        await tx.update(variants).set({ priceCents: match.priceCents, priceVerified: verified }).where(eq(variants.id, v.id));
        await tx.insert(priceChanges).values({ variantId: v.id, oldCents: v.priceCents, newCents: match.priceCents, source: 'skroutz' });
      });
    }
    changed++;
  }

  return (
    `${dry ? '[dry run] ' : ''}${changed} prices changed · ${confirmed} already right, now confirmed · ${same} already in place · ${kept} kept (confirmed by the owner)` +
    (unknown.length ? ` · ${unknown.length} SKUs of the file are not in this database (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''})` : '')
  );
}
