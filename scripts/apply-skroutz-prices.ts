import './env';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { priceChanges, variants } from '../src/lib/db/schema';
import { loadSkroutzPrices } from './skroutz-prices';

/*
 * Applies catalog/skroutz-prices.json (the prices the shop publishes on Skroutz, matched by hand to our SKUs) to an
 * EXISTING database. Fresh databases get the same prices from the seed.
 *   npm run prices:skroutz            only touches prices the owner has not confirmed yet (price_verified = 0)
 *   npm run prices:skroutz -- --force also overwrites confirmed prices
 *   npm run prices:skroutz -- --dry   prints what would change
 * "exact" matches are marked as confirmed; "probable" ones get the price but stay flagged for the owner to check.
 * Safe to run twice: a price that is already in place is left alone.
 */

const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

async function main() {
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry');
  const prices = loadSkroutzPrices();
  const rows = await db.select().from(variants);
  const bySku = new Map(rows.map((v) => [v.sku, v]));

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
      console.log(`  kept   ${sku}: ${eur(v.priceCents)} was confirmed by the owner (Skroutz says ${eur(match.priceCents)})`);
      continue;
    }
    if (v.priceCents === match.priceCents) {
      if (verified && !v.priceVerified) {
        if (!dry) await db.update(variants).set({ priceVerified: true }).where(eq(variants.id, v.id));
        confirmed++;
      } else same++;
      continue;
    }
    console.log(`  ${dry ? 'would set' : 'set'} ${sku}: ${eur(v.priceCents)} → ${eur(match.priceCents)}${verified ? '' : '  (probable match: stays flagged)'}`);
    if (!dry) {
      await db.transaction(async (tx) => {
        await tx.update(variants).set({ priceCents: match.priceCents, priceVerified: verified }).where(eq(variants.id, v.id));
        await tx.insert(priceChanges).values({ variantId: v.id, oldCents: v.priceCents, newCents: match.priceCents, source: 'skroutz' });
      });
    }
    changed++;
  }

  console.log(`\n${dry ? '[dry run] ' : ''}${changed} prices changed · ${confirmed} already right, now confirmed · ${same} already in place · ${kept} kept (confirmed by the owner)`);
  if (unknown.length) console.log(`${unknown.length} SKUs from the file are not in this database: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? '…' : ''}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
