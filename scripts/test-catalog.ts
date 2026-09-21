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
  const { getViscosities, getViscosityBySlug, listProducts, matchCode, suggestProducts, viscosityLabel, viscositySlug } = await import('../src/lib/catalog');
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

  console.log('Search by code');
  // give one size a manufacturer code and a barcode the way the owner would (Admin → Skroutz never touches products.search_text)
  const target = everything.products.find((p) => p.variants.length > 1) ?? everything.products[0];
  const size = target.variants[target.variants.length - 1];
  await db.update(variants).set({ mpn: 'ZQ-7501/4', barcode: '4006381333931' }).where(eq(variants.id, size.id));
  const find = async (q: string) => (await suggestProducts(q, 10)).map((p) => p.id);
  check('a manufacturer code finds its product', (await find('ZQ-7501/4')).includes(target.id));
  check('…also typed without the dash and the slash', (await find('zq75014')).includes(target.id));
  check('a barcode finds its product', (await find('4006381333931')).join() === String(target.id));
  check('our own SKU finds its product', (await find(size.sku)).includes(target.id));
  const hit = (await suggestProducts('ZQ-7501', 10)).find((p) => p.id === target.id);
  check('the suggestion names the code and the size it belongs to', hit !== undefined && matchCode(hit, 'ZQ-7501')?.code === 'ZQ-7501/4' && matchCode(hit, 'ZQ-7501')?.label === size.label);
  check('a name search is not reported as a code match', hit !== undefined && matchCode(hit, target.name) === null && matchCode(hit, 'zq') === null);
  check('the full listing search finds it too', (await listProducts({ q: '4006381333931', perPage: 10 })).total === 1);
  check('a code that does not exist finds nothing', (await find('ZQ-9999')).length === 0);

  console.log('Forms and badges');
  const { isValidAfm } = await import('../src/lib/quote');
  const { looksLikePhone } = await import('../src/lib/enquiries');
  const { trustItems } = await import('../src/components/store/trust-badges');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
  check('a VAT number with the right check digit passes, with or without EL', isValidAfm('123456783') && isValidAfm('EL 123456783'));
  check('one wrong digit, a short number and all zeros are refused', !isValidAfm('123456784') && !isValidAfm('12345678') && !isValidAfm('000000000') && !isValidAfm(''));
  check('phones: 10 digits, +30 and spaces are fine; too short or with letters is not', looksLikePhone('2310 850778') && looksLikePhone('+30 697 744 0388') && !looksLikePhone('123') && !looksLikePhone('call me 2310850778'));
  check('no rating and no founding year entered → no badge at all', trustItems(DEFAULT_SETTINGS.shop, DEFAULT_SETTINGS.reviews).length === 0);
  const badges = trustItems({ ...DEFAULT_SETTINGS.shop, foundedYear: 1992 }, { googleUrl: 'https://maps.app.goo.gl/x', googleRating: 4.8, googleCount: 132, skroutzRating: 0, skroutzCount: 57 });
  check('only what was entered is shown, each rating linked to its own platform', badges.map((b) => b.key).join() === 'google,since' && badges[0].href === 'https://maps.app.goo.gl/x' && badges[0].text.includes('132 κριτικές') && badges[1].text === 'Από το 1992', badges);

  console.log('Hazard labelling');
  const { buildHazard, hazardPriorityCategoryIds, needsHazardCheck, parseStatement, publicHazard, unknownCodes } = await import('../src/lib/ghs');
  const form = { none: false, confirmed: false, signalWord: 'warning', pictograms: ['GHS07', 'GHS99', 'GHS08'], statements: 'H302 Επιβλαβές σε περίπτωση κατάποσης.\n\n  H373  \nEUH208 Περιέχει X. Μπορεί να προκαλέσει αλλεργική αντίδραση.', precautions: 'P102 Μακριά από παιδιά.\nP301+P312', sdsUrl: ' https://example.com/sds.pdf ' };
  const built = buildHazard(form);
  check('the form is stored as typed: known pictograms only, empty lines dropped', built?.pictograms?.join() === 'GHS07,GHS08' && built?.statements?.length === 3 && built?.precautions?.length === 2 && built?.sdsUrl === 'https://example.com/sds.pdf' && built?.signalWord === 'warning');
  check('an empty card stores nothing', buildHazard({ ...form, signalWord: '', pictograms: [], statements: ' ', precautions: '', sdsUrl: '' }) === null);
  check('unchecked data is never public', publicHazard(built) === null && publicHazard(null) === null);
  check('checked data is public', publicHazard({ ...built!, confirmed: true })?.statements?.length === 3);
  check('«no hazard labelling» publishes nothing but a data sheet link', publicHazard({ none: true, confirmed: true }) === null && publicHazard(buildHazard({ ...form, none: true, confirmed: true }))?.sdsUrl === 'https://example.com/sds.pdf' && publicHazard(buildHazard({ ...form, none: true, confirmed: true }))?.statements === undefined);
  const s1 = parseStatement('H302 Επιβλαβές σε περίπτωση κατάποσης.');
  const s2 = parseStatement('p301 + p312', { 'P301+P312': 'ΕΠΙΣΗΜΟ ΚΕΙΜΕΝΟ' });
  const s3 = parseStatement('Περιέχει ισοθειαζολινόνη.');
  check('a code with its wording keeps the wording as typed', s1.code === 'H302' && s1.text === 'Επιβλαβές σε περίπτωση κατάποσης.');
  check('a bare code is completed from the table, combined codes included', s2.code === 'P301+P312' && s2.text === 'ΕΠΙΣΗΜΟ ΚΕΙΜΕΝΟ');
  check('free text stays free text', s3.code === null && s3.text === 'Περιέχει ισοθειαζολινόνη.');
  check('a bare code the table does not know is reported, not guessed', unknownCodes(built!, {}).join() === 'H373,P301+P312' && parseStatement('H373', {}).text === null);
  const cats = [{ id: 1, slug: 'chimika-prostheta', parentId: null }, { id: 2, slug: 'prostheta-kafsimou', parentId: 1 }, { id: 3, slug: 'lipantika-kinitira', parentId: null }, { id: 4, slug: 'lipantika-2t', parentId: 3 }, { id: 5, slug: 'lipantika-epivatikon', parentId: 3 }];
  const ids = hazardPriorityCategoryIds(cats);
  check('the worklist covers chemicals with their sub-categories and 2-stroke oils, not car engine oils', [...ids].sort().join() === '1,2,4');
  check('a product leaves the worklist once confirmed — with labelling or as «none»', needsHazardCheck({ isActive: true, categoryId: 2, hazard: null }, ids) && needsHazardCheck({ isActive: true, categoryId: 2, hazard: built }, ids) && !needsHazardCheck({ isActive: true, categoryId: 2, hazard: { none: true, confirmed: true } }, ids) && !needsHazardCheck({ isActive: true, categoryId: 5, hazard: null }, ids) && !needsHazardCheck({ isActive: false, categoryId: 2, hazard: null }, ids));

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
