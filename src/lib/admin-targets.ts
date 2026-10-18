import { asc, eq, inArray } from 'drizzle-orm';
import type { TargetOption } from '@/components/admin/discount-targets';
import { db } from '@/lib/db';
import { brands, categories, products } from '@/lib/db/schema';
import { hasTargets, type Targets } from '@/lib/discounts';

/** What the «Ισχύει για» picker needs on a page: the brands, the category tree flattened with depth, and the names of the chosen products. */
export async function loadTargetOptions(chosenProductIds: number[]) {
  const [brandRows, categoryRows, productRows] = await Promise.all([
    db.select({ id: brands.id, name: brands.name }).from(brands).orderBy(asc(brands.name)),
    db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories).orderBy(asc(categories.sort), asc(categories.name)),
    chosenProductIds.length
      ? db.select({ id: products.id, name: products.name, brand: brands.name }).from(products).leftJoin(brands, eq(products.brandId, brands.id)).where(inArray(products.id, chosenProductIds))
      : Promise.resolve([]),
  ]);

  const children = new Map<number | null, typeof categoryRows>();
  for (const c of categoryRows) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  const flat: TargetOption[] = [];
  const walk = (parent: number | null, depth: number, seen: Set<number>) => {
    for (const c of children.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      flat.push({ id: c.id, name: c.name, depth });
      walk(c.id, depth + 1, new Set(seen).add(c.id));
    }
  };
  walk(null, 0, new Set());

  const names = new Map<number, TargetOption>(productRows.map((p) => [p.id, { id: p.id, name: [p.brand, p.name].filter(Boolean).join(' ') }]));
  const brandName = new Map(brandRows.map((b) => [b.id, b.name]));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  /** «3 προϊόντα · Motul · Λάδια κινητήρα» */
  const scope = (t: Targets, whenEmpty: string): string => {
    if (!hasTargets(t)) return whenEmpty;
    const parts: string[] = [];
    if (t.productIds.length) parts.push(t.productIds.length === 1 ? '1 προϊόν' : `${t.productIds.length} προϊόντα`);
    parts.push(...t.brandIds.map((id) => brandName.get(id)).filter((n): n is string => !!n));
    parts.push(...t.categoryIds.map((id) => categoryName.get(id)).filter((n): n is string => !!n));
    return parts.join(' · ');
  };
  return { brands: brandRows as TargetOption[], categories: flat, productName: (id: number) => names.get(id), scope };
}
