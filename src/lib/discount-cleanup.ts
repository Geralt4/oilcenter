import { db } from '@/lib/db';
import { coupons, sales } from '@/lib/db/schema';
import { cleanIds, hasTargets, type Targets } from '@/lib/discounts';
import { eq } from 'drizzle-orm';

type Kind = 'product' | 'brand' | 'category';
const LIST = { product: 'productIds', brand: 'brandIds', category: 'categoryIds' } as const;

/**
 * Takes a deleted product / brand / category out of every coupon and sale that was limited to it.
 *
 * Without this a coupon whose only target is deleted keeps a dead id: it matches nothing (customers are told it does not
 * apply), but the edit form can no longer show that id, so saving the coupon for any other reason posts no targets and
 * silently turns it into a whole-shop discount. So a coupon or sale that LOSES its last target is also switched off:
 * widening it again is then a deliberate act of the owner, not a side effect.
 */
export async function forgetTarget(kind: Kind, id: number): Promise<void> {
  const key = LIST[kind];
  const strip = (row: Targets) => {
    const had = hasTargets(row);
    const next: Targets = { productIds: cleanIds(row.productIds), brandIds: cleanIds(row.brandIds), categoryIds: cleanIds(row.categoryIds) };
    const before = next[key].length;
    next[key] = next[key].filter((x) => x !== id);
    return { next, changed: next[key].length !== before, emptied: had && !hasTargets(next) };
  };

  for (const row of await db.select().from(coupons)) {
    const { next, changed, emptied } = strip(row);
    if (changed) await db.update(coupons).set({ ...next, ...(emptied ? { isActive: false } : {}) }).where(eq(coupons.id, row.id));
  }
  for (const row of await db.select().from(sales)) {
    const { next, changed, emptied } = strip(row);
    if (changed) await db.update(sales).set({ ...next, ...(emptied ? { isActive: false } : {}) }).where(eq(sales.id, row.id));
  }
}
