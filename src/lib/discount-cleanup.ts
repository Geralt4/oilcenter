import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { brands, categories, coupons, products, sales } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { hasTargets, parseIdList, type Targets } from '@/lib/discounts';

type Kind = 'product' | 'brand' | 'category';
const LIST = { product: 'productIds', brand: 'brandIds', category: 'categoryIds' } as const;
type TargetRow = { id: number } & Targets;

/**
 * The coupons / sales with their target lists, read as raw text so that one unreadable list skips that row (logged) instead of
 * throwing: Drizzle parses JSON columns while mapping, and a throw here would abort a delete AFTER it had committed.
 */
async function targetRows(table: 'coupons' | 'sales'): Promise<TargetRow[]> {
  type Raw = { id: number; product_ids: string | null; brand_ids: string | null; category_ids: string | null };
  const rows = await db.all<Raw>(table === 'coupons' ? sql`SELECT id, product_ids, brand_ids, category_ids FROM coupons` : sql`SELECT id, product_ids, brand_ids, category_ids FROM sales`);
  const out: TargetRow[] = [];
  for (const r of rows) {
    const productIds = parseIdList(r.product_ids);
    const brandIds = parseIdList(r.brand_ids);
    const categoryIds = parseIdList(r.category_ids);
    if (productIds === null || brandIds === null || categoryIds === null) {
      console.error(`[discounts] ${table} ${r.id} has an unreadable target list and is skipped`);
      continue;
    }
    out.push({ id: r.id, productIds, brandIds, categoryIds });
  }
  return out;
}

/** Saves new target lists; a row that LOST its last target is switched off so it cannot become a whole-shop discount. */
async function saveTargets(table: 'coupons' | 'sales', row: TargetRow, next: Targets): Promise<void> {
  const emptied = hasTargets(row) && !hasTargets(next);
  const set = { ...next, ...(emptied ? { isActive: false } : {}) };
  if (table === 'coupons') await db.update(coupons).set(set).where(eq(coupons.id, row.id));
  else await db.update(sales).set(set).where(eq(sales.id, row.id));
}

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
  for (const table of ['coupons', 'sales'] as const) {
    for (const row of await targetRows(table)) {
      if (!row[key].includes(id)) continue;
      await saveTargets(table, row, { ...row, [key]: row[key].filter((x) => x !== id) });
    }
  }
}

/**
 * One-off repair (scripts/patches.ts): coupons and sales that kept ids of products, brands or categories deleted BEFORE
 * forgetTarget existed. Strips every id that no longer exists and switches off a row that ends up with none. Safe to run twice.
 */
export async function pruneDeadTargets(): Promise<{ cleaned: number; switchedOff: number }> {
  const [p, b, c] = await Promise.all([
    db.select({ id: products.id }).from(products),
    db.select({ id: brands.id }).from(brands),
    db.select({ id: categories.id }).from(categories),
  ]);
  const alive = { productIds: new Set(p.map((x) => x.id)), brandIds: new Set(b.map((x) => x.id)), categoryIds: new Set(c.map((x) => x.id)) };
  let cleaned = 0;
  let switchedOff = 0;
  for (const table of ['coupons', 'sales'] as const) {
    for (const row of await targetRows(table)) {
      const next: Targets = {
        productIds: row.productIds.filter((x) => alive.productIds.has(x)),
        brandIds: row.brandIds.filter((x) => alive.brandIds.has(x)),
        categoryIds: row.categoryIds.filter((x) => alive.categoryIds.has(x)),
      };
      const changed = next.productIds.length !== row.productIds.length || next.brandIds.length !== row.brandIds.length || next.categoryIds.length !== row.categoryIds.length;
      if (!changed) continue;
      cleaned++;
      if (hasTargets(row) && !hasTargets(next)) switchedOff++;
      await saveTargets(table, row, next);
    }
  }
  return { cleaned, switchedOff };
}
