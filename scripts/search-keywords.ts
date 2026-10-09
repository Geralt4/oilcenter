import { readFileSync } from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { brands, categories, products, variants } from '../src/lib/db/schema';
import { buildSearchText, extraKeywords } from '../src/lib/search-keywords';

type SeedProduct = { slug: string; name: string; brand: string; category: string; viscosity: string | null; specs: string[]; searchText: string; variants: Array<{ label: string }> };
type SeedFile = { brands: Array<{ slug: string; name: string }>; categories: Array<{ slug: string; name: string }>; products: SeedProduct[] };

/**
 * Gives every product its search synonyms back and rebuilds its haystack.
 *
 * Until October 2026 the synonyms the catalogue builder adds per kind of product («λαδι», «παραφλου», «σασμαν»…) lived
 * only inside search_text, and the product editor rebuilt search_text without them: one save and the product no
 * longer answered to those words. They now have their own column (products.keywords). This fills it for products that
 * came from catalog.json and have none, then recomputes search_text for all — which also repairs what was already saved.
 * Keywords the owner typed himself are never touched.
 */
export async function applySearchKeywords(): Promise<string> {
  const seed = JSON.parse(readFileSync(path.resolve('catalog/catalog.json'), 'utf8')) as SeedFile;
  const seedBrand = new Map(seed.brands.map((b) => [b.slug, b.name]));
  const seedCategory = new Map(seed.categories.map((c) => [c.slug, c.name]));
  const seeded = new Map(seed.products.map((p) => [p.slug, p]));

  const rows = await db
    .select({ id: products.id, slug: products.slug, name: products.name, viscosity: products.viscosity, specs: products.specs, keywords: products.keywords, searchText: products.searchText, brand: brands.name, category: categories.name })
    .from(products)
    .leftJoin(brands, eq(products.brandId, brands.id))
    .leftJoin(categories, eq(products.categoryId, categories.id));
  const labels = new Map<number, string[]>();
  for (const v of await db.select({ productId: variants.productId, label: variants.label }).from(variants).orderBy(asc(variants.sort))) labels.set(v.productId, [...(labels.get(v.productId) ?? []), v.label]);

  let filled = 0;
  let rebuilt = 0;
  for (const p of rows) {
    let keywords = p.keywords;
    const origin = seeded.get(p.slug);
    if (!keywords && origin) {
      keywords = extraKeywords(origin.searchText, { brand: seedBrand.get(origin.brand), name: origin.name, viscosity: origin.viscosity, specs: origin.specs, category: seedCategory.get(origin.category), labels: origin.variants.map((v) => v.label) });
      if (keywords) filled++;
    }
    const searchText = buildSearchText({ brand: p.brand, name: p.name, viscosity: p.viscosity, specs: p.specs, category: p.category, keywords, labels: labels.get(p.id) ?? [] });
    if (keywords === p.keywords && searchText === p.searchText) continue;
    await db.update(products).set({ keywords, searchText }).where(eq(products.id, p.id));
    if (searchText !== p.searchText) rebuilt++;
  }
  return `${filled} products got their search keywords back · ${rebuilt} search texts rebuilt`;
}
