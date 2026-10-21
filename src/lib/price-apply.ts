import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { priceChanges, variants } from '@/lib/db/schema';
import type { PriceCsvChange } from '@/lib/price-csv';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Writes the changes a price list import planned. An adjustment of stock (`stockDelta`) is applied by the database to the
 * stock as it is at that moment (never below zero): a unit sold between the moment the file was read and the moment it is
 * saved stays sold. Everything else is a plain write.
 */
export async function applyPriceChanges(exec: Executor, changes: PriceCsvChange[]): Promise<void> {
  for (const change of changes) {
    const { stockDelta, ...patch } = change.patch;
    await exec
      .update(variants)
      .set({ ...patch, ...(stockDelta !== undefined ? { stock: sql`MAX(${variants.stock} + ${stockDelta}, 0)` } : {}) })
      .where(eq(variants.id, change.id));
    if (patch.priceCents !== undefined) await exec.insert(priceChanges).values({ variantId: change.id, oldCents: change.oldCents, newCents: change.newCents, source: 'csv' });
  }
}
