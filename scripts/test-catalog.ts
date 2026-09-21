/*
 * Storefront read-model regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:catalog
 * Covers what a visitor (or Google) would notice: a viscosity page that lists the wrong oils or the wrong count,
 * a facet whose numbers do not add up, a grade missing from the pages the sitemap advertises.
 */
import { rmSync } from 'node:fs';
import { cloneDatabase } from './test-db';

let dir = '';
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main() {
  dir = await cloneDatabase('oc-catalog-');
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  const { products, variants } = await import('../src/lib/db/schema');
  const { getViscosities, getViscosityBySlug, listProducts, viscosityLabel, viscositySlug } = await import('../src/lib/catalog');
  const { activeFilterCount, parseListingParams } = await import('../src/lib/listing-params');

  // what the shop window holds, counted without the read model: active products with at least one active size
  const rows = await db.select({ id: products.id, viscosity: products.viscosity, categoryId: products.categoryId }).from(products).innerJoin(variants, eq(variants.productId, products.id)).where(eq(products.isActive, true));
  const activeSizes = await db.select({ productId: variants.productId }).from(variants).where(eq(variants.isActive, true));
  const sellable = new Set(activeSizes.map((v) => v.productId));
  const shown = new Map(rows.filter((r) => sellable.has(r.id)).map((r) => [r.id, r]));
  const expected = new Map<string, number>();
  for (const p of shown.values()) if (p.viscosity) expected.set(p.viscosity, (expected.get(p.viscosity) ?? 0) + 1);

  console.log('Viscosity pages');
  const grades = await getViscosities();
  check('there is something to test with', grades.length > 5, grades.length);
  check('every grade in the shop has a page, and nothing else', grades.length === expected.size && grades.every((g) => expected.get(g.grade) === g.count), { pages: grades.length, grades: expected.size });
  check('slugs are lower-case and unique', grades.every((g) => g.slug === g.slug.toLowerCase()) && new Set(grades.map((g) => g.slug)).size === grades.length);
  check('"5W-30" and "5w-30" are the same page', viscositySlug('5W-30') === '5w-30' && (await getViscosityBySlug('5W-30'))?.grade === (await getViscosityBySlug('5w-30'))?.grade);
  check('an unknown grade has no page', (await getViscosityBySlug('nope')) === null);
  check('a bare number reads as "SAE 90", a multigrade stays as it is', viscosityLabel('90') === 'SAE 90' && viscosityLabel('5W-30') === '5W-30' && viscosityLabel('75W') === '75W');
  const kinds = new Map(grades.map((g) => [g.grade, g.kind]));
  check('5W-30 is engine oil, 75W-90 is gear oil', (!kinds.has('5W-30') || kinds.get('5W-30') === 'engine') && (!kinds.has('75W-90') || kinds.get('75W-90') === 'gear'), Object.fromEntries(kinds));
  check('grades are in numeric order (0W-20 before 5W-30 before 10W-40)', grades.every((g, i) => i === 0 || (grades[i - 1].grade.match(/\d+/g) ?? []).map(Number)[0] <= (g.grade.match(/\d+/g) ?? []).map(Number)[0]));

  let wrong: unknown = null;
  for (const g of grades) {
    const listing = await listProducts({ viscosity: g.grade, perPage: 500 });
    if (listing.total !== g.count || listing.products.some((p) => p.viscosity !== g.grade)) wrong ??= { grade: g.grade, page: g.count, listing: listing.total };
    const cheapest = listing.products.filter((p) => p.hasPrice).map((p) => p.minPriceCents);
    if ((cheapest.length ? Math.min(...cheapest) : null) !== g.minPriceCents) wrong ??= { grade: g.grade, minPrice: g.minPriceCents };
  }
  check('each page lists exactly the oils of its grade, and its "from" price is the cheapest of them', wrong === null, wrong);

  console.log('Category facet');
  const everything = await listProducts({ perPage: 500 });
  const withCategory = [...shown.values()].filter((p) => p.categoryId !== null).length;
  const facetSum = everything.facets.categories.reduce((n, c) => n + c.count, 0);
  check('all products are listed', everything.total === shown.size, { listing: everything.total, shown: shown.size });
  check('category counts add up to the products that have a category', facetSum === withCategory, { facetSum, withCategory });
  const pick = everything.facets.categories[0];
  const narrowed = await listProducts({ categories: [pick.value], perPage: 500 });
  check('ticking a category lists exactly its count', narrowed.total === pick.count, { total: narrowed.total, count: pick.count });
  check('ticking one category does not zero the others', narrowed.facets.categories.length === everything.facets.categories.length && narrowed.facets.categories.every((c, i) => c.count === everything.facets.categories[i].count));
  const busiest = [...grades].sort((a, b) => b.count - a.count)[0];
  const onPage = await listProducts({ viscosity: busiest.grade, perPage: 500 });
  check('on a viscosity page the category counts add up to that page', onPage.facets.categories.reduce((n, c) => n + c.count, 0) === onPage.products.filter((p) => p.categoryId !== null).length);

  console.log('URL');
  const parsed = parseListingParams({ cat: 'valvolines,atf-cvt-dct', visc: '5W-30' });
  check('?cat= is read as a list and counts as active filters', parsed.categories?.join('|') === 'valvolines|atf-cvt-dct' && activeFilterCount(parsed) === 3);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  });
