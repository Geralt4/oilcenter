/*
 * Pure discount maths shared by coupons and automatic sales. No server imports, so the browser can use it too.
 */
import type { SaleType } from '@/lib/db/schema';

export type Targets = { productIds: number[]; brandIds: number[]; categoryIds: number[] };

export type TargetItem = {
  productId: number;
  brandId: number | null;
  /** the product's category followed by all its ancestors, so a parent category covers its children */
  categoryPath: number[];
};

export type SaleRule = Targets & { id: number; type: SaleType; value: number };

export const hasTargets = (t: Targets): boolean => t.productIds.length + t.brandIds.length + t.categoryIds.length > 0;

/** No targets means everything. Otherwise matching any one of the three lists is enough. */
export function matchesTargets(t: Targets, item: TargetItem): boolean {
  if (!hasTargets(t)) return true;
  if (t.productIds.includes(item.productId)) return true;
  if (item.brandId !== null && t.brandIds.includes(item.brandId)) return true;
  return item.categoryPath.some((c) => t.categoryIds.includes(c));
}

/** The price after a sale, or null when the sale would leave less than one cent (it then does not apply). */
export function salePriceCents(priceCents: number, sale: Pick<SaleRule, 'type' | 'value'>): number | null {
  const out = sale.type === 'percent' ? Math.round((priceCents * (100 - sale.value)) / 100) : priceCents - sale.value;
  return out >= 1 && out < priceCents ? out : null;
}

/** Of all sales that match the item, the one giving the lowest price. */
export function bestSale(priceCents: number, item: TargetItem, sales: SaleRule[]): { priceCents: number; saleId: number } | null {
  let best: { priceCents: number; saleId: number } | null = null;
  for (const s of sales) {
    if (!hasTargets(s) || !matchesTargets(s, item)) continue; // a sale never applies to "everything"
    const price = salePriceCents(priceCents, s);
    if (price !== null && (!best || price < best.priceCents)) best = { priceCents: price, saleId: s.id };
  }
  return best;
}

/** Ids from a form field or a JSON column: positive integers, no duplicates. */
export function cleanIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** The id list of a JSON column read as raw text; null when it is not readable (so one bad row can be skipped, not crash a page). */
export function parseIdList(raw: string | null | undefined): number[] | null {
  try {
    return cleanIds(JSON.parse(raw ?? '[]'));
  } catch {
    return null;
  }
}
