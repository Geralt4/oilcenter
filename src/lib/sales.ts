import { cache } from 'react';
import { db } from '@/lib/db';
import { categories, sales } from '@/lib/db/schema';
import { bestSale, cleanIds, type SaleRule } from '@/lib/discounts';

/*
 * Automatic sales. Every place that turns a stored variant price into a shop price goes through withSale(), so the
 * catalogue, the product page, the cart, the order and the Skroutz feed all agree. The stored price is never changed:
 * the owner keeps editing the regular price and the sale sits on top of it.
 * Reads `categories` itself instead of catalog.ts, which imports this file.
 */

export type SaleContext = { sales: SaleRule[]; paths: Map<number, number[]> };

export const saleActiveAt = (s: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }, now = Date.now()): boolean =>
  s.isActive && (!s.startsAt || s.startsAt.getTime() <= now) && (!s.endsAt || s.endsAt.getTime() >= now);

/** category id → itself followed by its ancestors */
export async function loadCategoryPaths(): Promise<Map<number, number[]>> {
  const rows = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
  const parent = new Map(rows.map((r) => [r.id, r.parentId]));
  const paths = new Map<number, number[]>();
  for (const { id } of rows) {
    const path = [id];
    for (let p = parent.get(id) ?? null; p !== null && !path.includes(p); p = parent.get(p) ?? null) path.push(p);
    paths.set(id, path);
  }
  return paths;
}

export const getSaleContext = cache(async (): Promise<SaleContext> => {
  const [rows, paths] = await Promise.all([db.select().from(sales), loadCategoryPaths()]);
  const live = rows
    .filter((s) => saleActiveAt(s))
    .map((s) => ({ id: s.id, type: s.type, value: s.value, productIds: cleanIds(s.productIds), brandIds: cleanIds(s.brandIds), categoryIds: cleanIds(s.categoryIds) }));
  return { sales: live, paths };
});

type Priced = { priceCents: number; compareAtCents: number | null };

/**
 * The variant as the shop shows and sells it. On sale: priceCents is the sale price and compareAtCents the regular one
 * (or a higher hand-set "was" price). Sizes without a confirmed price are never touched.
 */
export function withSale<V extends Priced>(
  ctx: SaleContext,
  product: { id: number; brandId: number | null; categoryId: number | null },
  variant: V,
  priceVerified: boolean,
): V & { saleId: number | null } {
  if (!priceVerified || ctx.sales.length === 0) return { ...variant, saleId: null };
  const categoryPath = product.categoryId !== null ? (ctx.paths.get(product.categoryId) ?? [product.categoryId]) : [];
  const hit = bestSale(variant.priceCents, { productId: product.id, brandId: product.brandId, categoryPath }, ctx.sales);
  if (!hit) return { ...variant, saleId: null };
  const was = variant.compareAtCents && variant.compareAtCents > variant.priceCents ? variant.compareAtCents : variant.priceCents;
  return { ...variant, priceCents: hit.priceCents, compareAtCents: was, saleId: hit.saleId };
}
