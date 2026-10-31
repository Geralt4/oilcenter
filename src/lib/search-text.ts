import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { brands, categories, products, variants } from '@/lib/db/schema';
import { buildSearchText } from '@/lib/search-keywords';

/**
 * products.search_text carries the brand's and the category's NAME, and is otherwise rebuilt only when the product itself is
 * saved. Renaming or deleting a brand or category therefore has to rebuild the haystack of every product that belongs to it,
 * or the shop keeps answering to the old name and misses the new one. Same formula as the product editor
 * (buildSearchText), with the product's own keywords, specs and pack sizes. Returns how many products changed.
 */
export async function rebuildSearchTexts(scope: { brandId?: number; categoryId?: number; productIds?: number[] }): Promise<number> {
  const rows = await db
    .select({ id: products.id, name: products.name, viscosity: products.viscosity, specs: products.specs, keywords: products.keywords, searchText: products.searchText, brand: brands.name, category: categories.name })
    .from(products)
    .leftJoin(brands, eq(products.brandId, brands.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(scope.productIds ? inArray(products.id, scope.productIds) : scope.brandId !== undefined ? eq(products.brandId, scope.brandId) : scope.categoryId !== undefined ? eq(products.categoryId, scope.categoryId) : undefined);
  if (rows.length === 0) return 0;
  const labels = new Map<number, string[]>();
  for (const v of await db.select({ productId: variants.productId, label: variants.label }).from(variants).where(and(inArray(variants.productId, rows.map((r) => r.id)), isNull(variants.archivedAt))).orderBy(asc(variants.sort))) {
    labels.set(v.productId, [...(labels.get(v.productId) ?? []), v.label]);
  }
  let changed = 0;
  for (const p of rows) {
    const searchText = buildSearchText({ brand: p.brand, name: p.name, viscosity: p.viscosity, specs: p.specs, category: p.category, keywords: p.keywords, labels: labels.get(p.id) ?? [] });
    if (searchText === p.searchText) continue;
    await db.update(products).set({ searchText }).where(eq(products.id, p.id));
    changed++;
  }
  return changed;
}
