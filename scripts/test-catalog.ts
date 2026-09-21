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

  console.log('Approvals');
  const { parseApprovals, parseSpecLine } = await import('../src/lib/approvals');
  const keysOf = (line: string) => parseSpecLine(line).map((a) => a.key).join(' ');
  const same = (a: string, b: string) => keysOf(a) !== '' && keysOf(a) === keysOf(b);
  check('spellings of the same approval meet', same('BMW Longlife-04', 'BMW LL-04') && same('FIAT 955535-S2', 'Fiat 9.55535-S2') && same('RENAULT RN0700', 'Renault RN 0700') && same('JASO MA-2', 'JASO MA2') && same('MB-Approval 229.51', 'MB 229.51') && same('Porsche A40', 'PORSCHE A40') && same('GM dexos1 GEN3', 'dexos1 Gen 3'));
  const distinct = ['MB 229.5', 'MB 229.51', 'MB 229.52', 'VW 502 00', 'VW 504 00', 'API SN', 'API SN PLUS', 'API SP', 'ACEA C2', 'ACEA C3', 'ACEA A3/B4', 'ACEA A5/B5', 'BMW LL-01', 'BMW LL-04', 'dexos1', 'dexos1 Gen 2', 'dexos2', 'G12+', 'G12++', 'G13'].map(keysOf);
  check('approvals that differ stay apart (229.5 ≠ 229.51, SN ≠ SN PLUS, C2 ≠ C3, G12+ ≠ G12++)', new Set(distinct).size === distinct.length && distinct.every(Boolean), distinct);
  check('a line that names several approvals yields each of them', keysOf('VW 502 00 / 505 00 / 505 01') === 'vw-502-00 vw-505-00 vw-505-01' && keysOf('ACEA C2, C3') === 'acea-c2 acea-c3' && keysOf('API CI-4/SL') === 'api-ci-4 api-sl' && keysOf('MB 228.3 & 229.1') === 'mb-228.3 mb-229.1' && keysOf('FIAT 955535-GSY/CR1') === 'fiat-9.55535-gsy fiat-9.55535-cr1' && keysOf('Renault RN 0700 / 0710') === 'renault-rn0700 renault-rn0710');
  check('ACEA A3/B4 is one category, E7/B4/A3 is three', keysOf('ACEA A3/B4') === 'acea-a3-b4' && keysOf('ACEA E7/B4/A3') === 'acea-e7 acea-b4 acea-a3');
  check('Ford shorthand is spelled out', keysOf('FORD WSS-M2C947-A / -B1 / 962-A1') === 'ford-wss-m2c947-a ford-wss-m2c947-b1 ford-wss-m2c962-a1' && same('FORD WSS M2C913-D', 'Ford WSS-M2C913-D'));
  check('nothing is inferred and nothing is guessed', keysOf('API SP') === 'api-sp' && keysOf('Arvin Meritor Axles (LS)') === '' && keysOf('P-OAT') === '' && keysOf('Κατάλληλο για VW') === '');
  check('keys are safe in a URL list (no comma, space or plus)', ['BMW LL-17 FE+', 'G12++', 'JAGUAR LAND ROVER STJLR.03.5006', 'OPEL-VAUXHALL OV 040 1547-G40 / D40'].flatMap((l) => parseSpecLine(l)).every((a) => /^[a-z0-9.-]+$/.test(a.key)));

  const { readFileSync } = await import('node:fs');
  const source = JSON.parse(readFileSync('catalog/catalog.json', 'utf8')) as { products: Array<{ specs?: string[] }> };
  const lines = [...new Set(source.products.flatMap((p) => p.specs ?? []))];
  const unmapped = lines.filter((l) => parseSpecLine(l).length === 0).sort();
  // lines the parser is MEANT to leave alone: not approvals one would filter by, or too unclear to key
  const leftAlone = ['AG13', 'Arvin Meritor Axles (LS)', 'DIN 51524 Teil 2 HLP', 'HVLP', 'P-OAT'];
  check(`every other spec line of the catalogue is understood (${lines.length - unmapped.length} of ${lines.length})`, unmapped.join('|') === leftAlone.join('|'), unmapped);

  const c3 = await listProducts({ approvals: ['acea-c3'], perPage: 500 });
  const c3vw = await listProducts({ approvals: ['acea-c3', 'vw-504-00'], perPage: 500 });
  const specsById = new Map((await db.select({ id: products.id, specs: products.specs }).from(products)).map((p) => [p.id, p.specs]));
  const carries = (id: number, key: string) => parseApprovals(specsById.get(id) ?? []).some((a) => a.key === key);
  check('?spec= lists exactly the products whose label prints it', c3.total > 0 && c3.products.every((p) => carries(p.id, 'acea-c3')) && [...shown.keys()].filter((id) => carries(id, 'acea-c3')).length === c3.total, c3.total);
  check('two approvals narrow the list (both, not either)', c3vw.total > 0 && c3vw.total < c3.total && c3vw.products.every((p) => carries(p.id, 'acea-c3') && carries(p.id, 'vw-504-00')), { c3: c3.total, both: c3vw.total });
  const vwOption = c3.facets.approvals.oem.find((o) => o.value === 'vw-504-00');
  check('an option’s count is what ticking it leads to', vwOption?.count === c3vw.total, { option: vwOption?.count, listing: c3vw.total });
  check('the three groups hold what they should', everything.facets.approvals.standard.some((o) => o.label === 'ACEA C3') && everything.facets.approvals.oem.some((o) => o.label === 'MB 229.51') && everything.facets.approvals.other.some((o) => o.label === 'G12+') && !everything.facets.approvals.oem.some((o) => o.label.startsWith('ACEA')));
  check('standards come in the order ACEA, API, ILSAC, JASO', ((labels) => labels.findIndex((l) => l.startsWith('API')) > labels.findIndex((l) => l.startsWith('ACEA')) && labels.findIndex((l) => l.startsWith('JASO')) > labels.findIndex((l) => l.startsWith('API')))(everything.facets.approvals.standard.map((o) => o.label)));
  check('approvals never travel to the browser with the product cards', everything.products.every((p) => !('approvals' in p) && !('searchText' in p)));

  console.log('URL');
  check('?spec= is read as a list, lower-cased', parseListingParams({ spec: 'VW-504-00,mb-229.51' }).approvals?.join('|') === 'vw-504-00|mb-229.51');
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
