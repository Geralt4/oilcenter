/*
 * What the owner does in the admin, without a browser. Runs against a throwaway COPY of the local database:
 *   npm run test:admin
 * Covers the mistakes that would change what the public sees: a price list that comes back different from how it
 * left, a price read ten times too small, a product that stops answering to «λαδι» after it is saved.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cloneDatabase } from './test-db';

let dir = '';
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main() {
  dir = await cloneDatabase('oc-admin-');
  // Admin sessions without a request: next/headers' cookies() is replaced by an in-memory jar before anything imports it.
  const cookieJar = new Map<string, string>();
  let currentIp = '203.0.113.1'; // the address clientIp() sees; the login tests change it per attempt
  const headersPath = require.resolve('next/headers');
  require.cache[headersPath] = {
    id: headersPath, filename: headersPath, loaded: true,
    exports: {
      headers: async () => new Headers({ 'x-forwarded-for': currentIp }),
      cookies: async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (name: string, value: string) => void cookieJar.set(name, value),
        delete: (name: string) => void cookieJar.delete(name),
      }),
    },
  } as unknown as NodeJS.Module;
  // revalidatePath needs a request's cache store; outside a request there is nothing to revalidate.
  const cachePath = require.resolve('next/cache');
  require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: { revalidatePath: () => undefined, revalidateTag: () => undefined } } as unknown as NodeJS.Module;
  const { asc, eq, inArray } = await import('drizzle-orm');
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { db } = await import('../src/lib/db');
  const { brands, products, variants } = await import('../src/lib/db/schema');
  const { parsePriceToCents, normalizeText } = await import('../src/lib/utils');
  const { buildPriceCsv, describePriceImport, parseCsv, planPriceImport } = await import('../src/lib/price-csv');
  const { buildSearchText, extraKeywords } = await import('../src/lib/search-keywords');
  const { applySearchKeywords } = await import('./search-keywords');
  const { listProducts } = await import('../src/lib/catalog');
  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('Typed prices');
  const cents = (s: string) => parsePriceToCents(s);
  check('"12,90", "12.90", "12" and "12,9 €"', cents('12,90') === 1290 && cents('12.90') === 1290 && cents('12') === 1200 && cents('12,9 €') === 1290);
  check('"1.250", "12.500" and "12,500" could be thousands or decimals: refused, not guessed', cents('1.250') === null && cents('12.500') === null && cents('12,500') === null, [cents('1.250'), cents('12.500'), cents('12,500')]);
  check('unmistakable thousands are read: "1.250,00", "1,250.00", "1.250.000"', cents('1.250,00') === 125000 && cents('1,250.00') === 125000 && cents('1.250.000') === 125000000 && cents('1.234,56') === 123456, [cents('1.250,00'), cents('1,250.00'), cents('1.250.000')]);
  check('"12.5" is twelve fifty; three decimals are refused', cents('12.5') === 1250 && cents('0.125') === null && cents('12,905') === null);
  check('a stray mark is refused, not folded into the amount: "12,90." "12." "12,90.5" ",5"', cents('12,90.') === null && cents('12.') === null && cents('12,90.5') === null && cents(',5') === null, [cents('12,90.'), cents('12.'), cents('12,90.5')]);
  check('nonsense is refused, not guessed', cents('abc') === null && cents('') === null && cents('-5') === null && cents('1e3') === null && cents('12,90,1') === null);

  console.log('Reading a CSV file');
  const semi = parseCsv(String.fromCharCode(0xfeff) + 'sku;Price;stock\r\nA-1;"12,90";\r\n\r\nB-2;"He said ""hi""; twice";3\r\n');
  check('semicolon file with a BOM, quotes and a blank line', semi.sep === ';' && semi.header.join('|') === 'sku|price|stock' && semi.rows.length === 2 && semi.rows[0].cells[1] === '12,90' && semi.rows[1].cells[1] === 'He said "hi"; twice', semi);
  check('rows remember their line in the file', semi.rows[0].line === 2 && semi.rows[1].line === 4, semi.rows.map((r) => r.line));
  const comma = parseCsv('sku,price,stock\nA-1,"12,90",\n');
  check('comma file: a quoted "12,90" stays one cell', comma.sep === ',' && comma.rows[0].cells.join('|') === 'A-1|12,90|', comma.rows[0]);

  console.log('Price list: what an upload would change');
  const shop = () => new Map([
    ['A-1', { id: 1, priceCents: 1290, priceVerified: false, stock: 0, trackStock: false, availability: 'in_stock' as const }],
    ['B-2', { id: 2, priceCents: 4500, priceVerified: true, stock: 7, trackStock: true, availability: 'days_1_3' as const }],
  ]);
  const plan = (text: string) => {
    const p = planPriceImport(text, shop());
    if (p.error !== undefined) throw new Error(p.error);
    return p;
  };
  const same = plan('sku;price;stock;verified;availability\nA-1;12,90;;no;in_stock\nB-2;45,00;7;yes;days_1_3\n');
  check('the same file back changes nothing', same.changes.length === 0 && same.unchanged === 2 && same.skipped.length === 0, same);
  const blankStock = plan('sku;price;stock\nA-1;13,50;\n');
  check('an empty stock cell does not start counting stock at zero', blankStock.changes.length === 1 && blankStock.changes[0].patch.stock === undefined && blankStock.changes[0].patch.trackStock === undefined, blankStock.changes);
  check('a new price is saved and counts as confirmed', blankStock.changes[0].patch.priceCents === 1350 && blankStock.changes[0].patch.priceVerified === true && blankStock.changes[0].oldCents === 1290);
  check('an unchanged price is NOT confirmed by being in the file', plan('sku;price\nA-1;12,90\n').changes.length === 0);
  const confirm = plan('sku;price;verified\nA-1;12,90;yes\n');
  check('"verified = yes" confirms a price', confirm.changes.length === 1 && confirm.changes[0].patch.priceVerified === true && confirm.changes[0].patch.priceCents === undefined, confirm.changes);
  check('"verified = no" never un-confirms one', plan('sku;price;verified\nB-2;45,00;no\n').changes.length === 0);
  const stock = plan('sku;price;stock\nA-1;12,90;4\nB-2;45,00;7\n');
  check('a typed stock number starts counting; the same number changes nothing', stock.changes.length === 1 && stock.changes[0].patch.stock === 4 && stock.changes[0].patch.trackStock === true && stock.unchanged === 1, stock);
  const quoted = plan('sku,price,stock\nA-1,"13,90",\n');
  check('comma file from Sheets/Numbers keeps the cents and leaves stock alone', quoted.changes.length === 1 && quoted.changes[0].patch.priceCents === 1390 && quoted.changes[0].patch.stock === undefined, quoted);
  const unquoted = plan('sku,price,stock\nA-1,13,90,\n');
  check('comma file with an unquoted decimal comma is refused, not misread', unquoted.changes.length === 0 && unquoted.skipped.length === 1, unquoted);
  const mixed = plan('sku;price;stock\nA-1;abc;\nZZ-9;10,00;\nB-2;45,00;x\n;5,00;\n');
  check('bad price, unknown code, bad stock and a missing code are each reported', mixed.changes.length === 0 && mixed.unknown.join() === 'ZZ-9' && mixed.skipped.map((s) => s.line).join() === '2,4,5', mixed);
  check('…and the message says so', /γραμμή 2/.test(describePriceImport(mixed)) && /ZZ-9/.test(describePriceImport(mixed)), describePriceImport(mixed));
  const twice = plan('sku;price\nA-1;13,00\nA-1;14,00\n');
  check('a code listed twice: one change, the last line wins, measured from the original price', twice.changes.length === 1 && twice.changes[0].newCents === 1400 && twice.changes[0].oldCents === 1290, twice.changes);
  check('a file without sku/price columns is refused', planPriceImport('code;amount\nA-1;5\n', shop()).error !== undefined);
  // B-2 was exported at 7 (exported_stock); by the upload orders have taken 3, so the shop holds 4
  const later = () => new Map([...shop()].map(([sku, v]) => [sku, sku === 'B-2' ? { ...v, stock: 4 } : v]));
  const planLater = (text: string) => {
    const p = planPriceImport(text, later());
    if (p.error !== undefined) throw new Error(p.error);
    return p;
  };
  check('an exported file uploaded later leaves the stock alone when its cell was not edited', planLater('sku;price;stock;exported_stock\nB-2;45,00;7;7\n').changes.length === 0);
  const editedStock = planLater('sku;price;stock;exported_stock\nB-2;45,00;9;7\n');
  check('…and an edited cell (+2) is kept as an ADJUSTMENT of +2, applied to the stock as it is when saved', editedStock.changes.length === 1 && editedStock.changes[0].patch.stockDelta === 2 && editedStock.changes[0].patch.stock === undefined && editedStock.changes[0].patch.trackStock === true, editedStock.changes);
  // the same row twice: the adjustment is worked out once, from the stock the shop held before the upload (10 → 12, not 14)
  const tenShop = () => new Map([['B-2', { id: 2, priceCents: 4500, priceVerified: true, stock: 10, trackStock: true, availability: 'in_stock' as const }]]);
  const doubled = planPriceImport('sku;price;stock;exported_stock\nB-2;45,00;12;10\nB-2;45,00;12;10\n', tenShop());
  if (doubled.error !== undefined) throw new Error(doubled.error);
  check('the same row twice applies its adjustment once (+2, not +4)', doubled.changes.length === 1 && doubled.changes[0].patch.stockDelta === 2, doubled.changes);
  const replaced = planPriceImport('sku;price;stock;exported_stock\nB-2;45,00;12;10\nB-2;45,00;11;10\n', tenShop());
  if (replaced.error !== undefined) throw new Error(replaced.error);
  check('two different rows for one code: the later one wins (+1)', replaced.changes.length === 1 && replaced.changes[0].patch.stockDelta === 1, replaced.changes);
  const mixedKinds = planPriceImport('sku;price;stock\nB-2;45,00;20\n', tenShop());
  if (mixedKinds.error !== undefined) throw new Error(mixedKinds.error);
  check('a hand-made row (no exported_stock) still sets the absolute number', mixedKinds.changes[0].patch.stock === 20 && mixedKinds.changes[0].patch.stockDelta === undefined, mixedKinds.changes);
  const handMade = planLater('sku;price;stock\nB-2;45,00;9\n');
  check('a file without exported_stock still sets the number typed', handMade.changes.length === 1 && handMade.changes[0].patch.stock === 9, handMade.changes);

  console.log('Price list: the real catalogue, exported and uploaded back');
  const rows = await db.select({ v: variants, productName: products.name, brandName: brands.name }).from(variants).innerJoin(products, eq(variants.productId, products.id)).leftJoin(brands, eq(products.brandId, brands.id)).orderBy(asc(variants.id));
  const csv = buildPriceCsv(rows.map(({ v, productName, brandName }) => ({ sku: v.sku, brand: brandName, product: productName, pack: v.label, priceCents: v.priceCents, stock: v.stock, trackStock: v.trackStock, priceVerified: v.priceVerified, availability: v.availability })));
  const current = new Map(rows.map(({ v }) => [v.sku, { id: v.id, priceCents: v.priceCents, priceVerified: v.priceVerified, stock: v.stock, trackStock: v.trackStock, availability: v.availability }]));
  const round = planPriceImport(csv, current);
  check('there is a catalogue to test with', rows.length > 50, rows.length);
  check('unchanged file → no size changes', round.error === undefined && round.changes.length === 0 && round.unchanged === rows.length && round.skipped.length === 0 && round.unknown.length === 0, round.error ?? { changes: round.changes.length, unchanged: round.unchanged, skipped: round.skipped.slice(0, 3), unknown: round.unknown.slice(0, 3) });

  console.log('Search words survive a save');
  check('synonyms are part of the haystack', buildSearchText({ brand: 'AISIN', name: 'Coolant', category: 'Αντιψυκτικά', keywords: 'παραφλου ψυκτικο', labels: ['5L'] }) === 'aisin coolant αντιψυκτικα παραφλου ψυκτικο 5l');
  check('extraKeywords finds only the words nothing else explains', extraKeywords('aisin aisin coolant αντιψυκτικα παραφλου παραφλου μηχανησ 5l', { brand: 'AISIN', name: 'Coolant', category: 'Αντιψυκτικά', labels: ['5L'] }) === 'παραφλου μηχανης');

  const seed = JSON.parse(readFileSync('catalog/catalog.json', 'utf8')) as { products: Array<{ slug: string; searchText: string }> };
  const coolant = seed.products.find((p) => p.searchText.includes('παραφλου'))!;
  const [victim] = await db.select().from(products).where(eq(products.slug, coolant.slug));
  const [mine] = await db.select().from(products).where(eq(products.slug, seed.products.find((p) => p.slug !== coolant.slug)!.slug));
  // what the product editor used to leave behind: a haystack without the synonyms, and nowhere to get them from
  await db.update(products).set({ keywords: '', searchText: buildSearchText({ name: victim.name }) }).where(eq(products.id, victim.id));
  await db.update(products).set({ keywords: 'λεξητουιδιοκτητη' }).where(eq(products.id, mine.id));
  const found = async (q: string, slug: string) => (await listProducts({ q, perPage: 500 })).products.some((p) => p.slug === slug);
  check('(a stripped product really is unfindable by its synonym)', !(await found('παραφλου', coolant.slug)));
  await applySearchKeywords();
  const [repaired] = await db.select().from(products).where(eq(products.id, victim.id));
  check('the repair gives it its keywords back', repaired.keywords.includes('παραφλου'), repaired.keywords);
  check('…and it answers to them again', await found('παραφλου', coolant.slug));
  const [kept] = await db.select().from(products).where(eq(products.id, mine.id));
  check('keywords the owner typed are kept and searchable', kept.keywords === 'λεξητουιδιοκτητη' && (await found('λεξητουιδιοκτητη', mine.slug)), kept.keywords);

  const all = new Map((await db.select({ slug: products.slug, searchText: products.searchText }).from(products)).map((p) => [p.slug, new Set(p.searchText.split(' '))]));
  const lost = seed.products.filter((p) => p.slug !== mine.slug && all.has(p.slug)).flatMap((p) => normalizeText(p.searchText).split(' ').filter((w) => w && !all.get(p.slug)!.has(w)).map((w) => `${p.slug}: ${w}`));
  check('no seeded product lost a single search word', lost.length === 0, lost.slice(0, 8));
  const snapshot = async () => (await db.select({ id: products.id, keywords: products.keywords, searchText: products.searchText }).from(products).orderBy(asc(products.id))).map((p) => `${p.id}|${p.keywords}|${p.searchText}`).join('\n');
  const before = await snapshot();
  await applySearchKeywords();
  check('running the repair twice changes nothing', before === (await snapshot()));

  console.log('Sales and coupons (admin actions)');
  const { adminUsers, coupons, sales } = await import('../src/lib/db/schema');
  const { createSession } = await import('../src/lib/auth/session');
  const { saveSale, deleteSale, searchAdminProducts, saveCoupon } = await import('../src/app/admin/actions');
  const { formatAthensDate, parseAthensDate } = await import('../src/lib/utils');
  const form = (fields: Record<string, string | string[]>) => {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) fd.append(key, v);
    return fd;
  };
  const [admin] = await db.select().from(adminUsers);
  await createSession('admin', admin.id, admin.tokenVersion);
  const [anyBrand] = await db.select().from(brands).limit(1);
  const brandId = String(anyBrand.id);

  // the actions answer null only before the first submit; every call here is a submit
  const runSale = async (fd: FormData) => (await saveSale(null, fd))!;
  const runCoupon = async (fd: FormData) => (await saveCoupon(null, fd))!;
  const badSale = async (fields: Record<string, string | string[]>) => runSale(form({ name: 'Δοκιμή έκπτωσης', type: 'percent', value: '20', brandIds: brandId, ...fields }));
  const missingName = await runSale(form({ type: 'percent', value: '20', brandIds: brandId }));
  check('a sale without a name is refused', missingName.ok === false, missingName);
  const tooBig = await badSale({ value: '91' });
  check('a percent sale above 90 is refused', tooBig.ok === false && tooBig.message === 'Μέγιστο 90%.', tooBig);
  const zero = await badSale({ value: '0' });
  check('a zero value is refused', zero.ok === false, zero);
  const noTargets = await badSale({ brandIds: [] });
  check('a sale with no targets is refused', noTargets.ok === false && noTargets.message === 'Επιλέξτε τουλάχιστον ένα προϊόν, μάρκα ή κατηγορία.', noTargets);
  const reversed = await badSale({ startsAt: '2026-10-20', endsAt: '2026-10-10' });
  check('an end date before the start date is refused', reversed.ok === false, reversed);
  const notADate = await badSale({ startsAt: 'x' });
  check('an invalid date is refused', notADate.ok === false && notADate.message === 'Μη έγκυρη ημερομηνία.', notADate);

  const salesBefore = (await db.select().from(sales)).length;
  const valid = await badSale({});
  check('a valid percent sale for a real brand is saved', valid.ok === true, valid);
  const [saved] = await db.select().from(sales).where(eq(sales.name, 'Δοκιμή έκπτωσης'));
  check('…and its row targets that brand', saved !== undefined && JSON.stringify(saved.brandIds) === JSON.stringify([anyBrand.id]) && saved.value === 20, saved);
  const droppedIds = await badSale({ name: 'Δοκιμή με άκυρα', brandIds: ['999999', brandId] });
  const [withDropped] = await db.select().from(sales).where(eq(sales.name, 'Δοκιμή με άκυρα'));
  check('nonexistent ids are dropped while a valid one stays', droppedIds.ok === true && JSON.stringify(withDropped?.brandIds) === JSON.stringify([anyBrand.id]), withDropped);
  const allMissing = await badSale({ name: 'Δοκιμή χωρίς στόχους', brandIds: ['999999'] });
  check('a target list of only nonexistent ids counts as no targets', allMissing.ok === false && allMissing.message === 'Επιλέξτε τουλάχιστον ένα προϊόν, μάρκα ή κατηγορία.', allMissing);

  const fixed = await badSale({ name: 'Δοκιμή σταθερή', type: 'fixed', value: '2,50' });
  const [fixedRow] = await db.select().from(sales).where(eq(sales.name, 'Δοκιμή σταθερή'));
  check('a fixed amount "2,50" is stored as 250 cents', fixed.ok === true && fixedRow?.value === 250, fixedRow);

  const countBeforeEdit = (await db.select().from(sales)).length;
  const edited = await badSale({ id: String(saved.id), value: '25' });
  const [editedRow] = await db.select().from(sales).where(eq(sales.id, saved.id));
  check('saving with an id updates that row, not a new one', edited.ok === true && (await db.select().from(sales)).length === countBeforeEdit && editedRow?.value === 25, editedRow);
  check('the sale count grew only by the new rows', countBeforeEdit === salesBefore + 3, { salesBefore, countBeforeEdit });

  await deleteSale(form({ id: String(saved.id) }));
  check('deleteSale removes the row', (await db.select().from(sales).where(eq(sales.id, saved.id))).length === 0);

  console.log('Coupons: targets, exclusions and Athens dates');
  const targeted = await runCoupon(form({ code: 'TESTBRAND', type: 'percent', value: '10', brandIds: brandId, excludeSaleItems: 'on', isActive: 'on' }));
  const [brandCoupon] = await db.select().from(coupons).where(eq(coupons.code, 'TESTBRAND'));
  check('a targeted coupon saves with its brand and the exclusion flag', targeted.ok === true && JSON.stringify(brandCoupon?.brandIds) === JSON.stringify([anyBrand.id]) && brandCoupon?.excludeSaleItems === true, brandCoupon);
  const untargeted = await runCoupon(form({ code: 'TESTFREE', type: 'free_shipping' }));
  const [freeCoupon] = await db.select().from(coupons).where(eq(coupons.code, 'TESTFREE'));
  check('an untargeted coupon saves with empty arrays', untargeted.ok === true && freeCoupon?.productIds.length === 0 && freeCoupon?.brandIds.length === 0 && freeCoupon?.categoryIds.length === 0, freeCoupon);
  const dated = await runCoupon(form({ code: 'TESTDATES', type: 'percent', value: '5', startsAt: '2026-10-31', endsAt: '2026-10-31' }));
  const [datedCoupon] = await db.select().from(coupons).where(eq(coupons.code, 'TESTDATES'));
  check('a coupon starting on Athens day 2026-10-31 starts at its local midnight', dated.ok === true && datedCoupon?.startsAt?.toISOString() === '2026-10-30T22:00:00.000Z', datedCoupon?.startsAt?.toISOString());
  check('…and ends at the last millisecond of that Athens day', datedCoupon?.endsAt?.toISOString() === '2026-10-31T21:59:59.999Z', datedCoupon?.endsAt?.toISOString());
  const duplicate = await runCoupon(form({ code: 'TESTBRAND', type: 'percent', value: '10' }));
  check('a duplicate code is refused', duplicate.ok === false && duplicate.message === 'Υπάρχει ήδη κουπόνι με αυτόν τον κωδικό.', duplicate);

  console.log('Athens dates survive a round trip');
  const days = ['2026-01-15', '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26', '2026-07-01'];
  const trips = days.flatMap((d) => [
    [d, 'start', formatAthensDate(parseAthensDate(d, 'start'))] as const,
    [d, 'end', formatAthensDate(parseAthensDate(d, 'end'))] as const,
  ]).filter(([d, , out]) => out !== d);
  check('every listed day comes back unchanged from both edges', trips.length === 0, trips);
  check('a day that does not exist is refused', parseAthensDate('2026-02-30', 'start') === null);
  check('text that is not a date is refused', parseAthensDate('x', 'end') === null);

  console.log('Admin product search');
  const [sample] = await db.select({ name: products.name, brand: brands.name }).from(products).innerJoin(brands, eq(products.brandId, brands.id)).limit(1);
  const oneLetter = await searchAdminProducts('a');
  check('a single letter finds nothing', oneLetter.length === 0, oneLetter.length);
  const fragment = `${sample.brand} ${sample.name.split(' ')[0]}`;
  const hits = await searchAdminProducts(fragment);
  check('a brand plus a name fragment finds the product', hits.some((h) => h.name === `${sample.brand} ${sample.name}`), { fragment, hits: hits.slice(0, 3) });
  const broad = await searchAdminProducts('λαδι');
  check('a broad query never returns more than 50', broad.length <= 50, broad.length);

  console.log('Payment status rules (updateOrder)');
  const { orders, orderEvents, unmatchedPayments } = await import('../src/lib/db/schema');
  const { updateOrder, resolvePaymentReview, resolveUnmatchedPayment } = await import('../src/app/admin/actions');
  let madeOrders = 0;
  const createdOrderIds: number[] = [];
  const makeOrder = async (over: Partial<typeof orders.$inferInsert> = {}) => {
    madeOrders++;
    const [row] = await db
      .insert(orders)
      .values({
        number: `OC-ADMIN-T${madeOrders}`,
        accessToken: `at-admin-t${madeOrders}`,
        paymentMethod: 'card',
        shippingMethod: 'courier',
        email: 'buyer@example.com',
        phone: '6900000000',
        firstName: 'Τεστ',
        lastName: 'Αγοραστής',
        subtotalCents: 1999,
        totalCents: 1999,
        ...over,
      })
      .returning();
    createdOrderIds.push(row.id);
    return row;
  };
  const orderNow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
  const eventsNow = async (id: number) => (await db.select().from(orderEvents).where(eq(orderEvents.orderId, id))).map((e) => e.message);
  // the form the admin page sends: id and status (kept as it is unless the test changes it) and paymentStatus
  const statusForm = (order: { id: number; status: string }, paymentStatus: string) => form({ id: String(order.id), status: order.status, paymentStatus });

  const cardPaid = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-1', paymentProvider: 'viva' });
  const cardPaidBefore = await orderNow(cardPaid.id);
  const r1 = await updateOrder(null, statusForm(cardPaid, 'pending'));
  check('a card payment with a Viva reference cannot be set back to pending', r1?.ok === false && (r1?.message ?? '').includes('TX-ADM-1'), r1);
  const cardPaidAfterPending = await orderNow(cardPaid.id);
  check('…and the order is unchanged', cardPaidAfterPending.paymentStatus === 'paid' && cardPaidAfterPending.paymentTransactionId === 'TX-ADM-1' && cardPaidAfterPending.paidAt?.getTime() === cardPaidBefore.paidAt?.getTime(), cardPaidAfterPending);

  await db.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, cardPaid.id));
  const r2 = await updateOrder(null, statusForm(cardPaid, 'refunded'));
  check('paid → refunded is accepted', r2?.ok === true, r2);
  const cardRefunded = await orderNow(cardPaid.id);
  check('…the payment is refunded and the review flag is cleared', cardRefunded.paymentStatus === 'refunded' && cardRefunded.paymentFlag === null, cardRefunded);
  check('…with one «επιστραφείσα» event', (await eventsNow(cardPaid.id)).filter((m) => m.includes('επιστραφείσα')).length === 1, await eventsNow(cardPaid.id));
  const r3 = await updateOrder(null, statusForm(cardRefunded, 'paid'));
  const r4 = await updateOrder(null, statusForm(cardRefunded, 'pending'));
  check('after refunded, any further change is refused', r3?.ok === false && r4?.ok === false, [r3, r4]);
  check('…and the refunded order stays refunded', (await orderNow(cardPaid.id)).paymentStatus === 'refunded');

  const pendingCard = await makeOrder({ status: 'pending' });
  const r5 = await updateOrder(null, statusForm(pendingCard, 'refunded'));
  check('refunded from pending is refused', r5?.ok === false && (await orderNow(pendingCard.id)).paymentStatus === 'pending', r5);

  const paidFail = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-2', paymentProvider: 'viva' });
  const r6 = await updateOrder(null, statusForm(paidFail, 'failed'));
  check('paid → failed is refused', r6?.ok === false && (await orderNow(paidFail.id)).paymentStatus === 'paid', r6);

  const cod = await makeOrder({ paymentMethod: 'cod', status: 'confirmed', paymentStatus: 'paid', paidAt: new Date() });
  const r7 = await updateOrder(null, statusForm(cod, 'pending'));
  check('a cash-on-delivery payment can be set back to pending', r7?.ok === true && (await orderNow(cod.id)).paymentStatus === 'pending', r7);

  const pendingBank = await makeOrder({ paymentMethod: 'bank_transfer', status: 'pending' });
  const r8 = await updateOrder(null, statusForm(pendingBank, 'paid'));
  const pendingBankAfter = await orderNow(pendingBank.id);
  check('pending → paid is accepted, with paidAt set', r8?.ok === true && pendingBankAfter.paymentStatus === 'paid' && pendingBankAfter.paidAt !== null, [r8, pendingBankAfter.paymentStatus, pendingBankAfter.paidAt]);
  check('…and the timeline says so', (await eventsNow(pendingBank.id)).some((m) => m.includes('Σημειώθηκε ως εξοφλημένη.')));

  const cancelPaid = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-3', paymentProvider: 'viva' });
  const r9 = await updateOrder(null, form({ id: String(cancelPaid.id), status: 'cancelled', paymentStatus: 'paid' }));
  const cancelPaidAfter = await orderNow(cancelPaid.id);
  check('cancelling a paid order is accepted and flagged for review', r9?.ok === true && cancelPaidAfter.status === 'cancelled' && cancelPaidAfter.paymentFlag === 'review', [r9, cancelPaidAfter.status, cancelPaidAfter.paymentFlag]);
  check('…with a «ΠΡΟΣΟΧΗ» event', (await eventsNow(cancelPaid.id)).some((m) => m.includes('ΠΡΟΣΟΧΗ')));

  const cancelRefund = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-4', paymentProvider: 'viva' });
  const r10 = await updateOrder(null, form({ id: String(cancelRefund.id), status: 'cancelled', paymentStatus: 'refunded' }));
  const cancelRefundAfter = await orderNow(cancelRefund.id);
  check('cancelling together with refunded is accepted', r10?.ok === true && cancelRefundAfter.status === 'cancelled' && cancelRefundAfter.paymentStatus === 'refunded', [r10, cancelRefundAfter.status, cancelRefundAfter.paymentStatus]);
  check('…and leaves no review flag', cancelRefundAfter.paymentFlag === null, cancelRefundAfter.paymentFlag);

  console.log('Order editor: stale tabs and one transaction');
  {
    // the form the order page sends, with the «loaded…» copies of what it showed
    const pageForm = (order: { id: number; status: string; paymentStatus: string; trackingCarrier?: string | null; trackingNumber?: string | null; adminNotes?: string | null }, asked: Record<string, string> = {}) =>
      form({
        id: String(order.id),
        status: order.status,
        paymentStatus: order.paymentStatus,
        loadedStatus: order.status,
        loadedPayment: order.paymentStatus,
        loadedTrackingCarrier: order.trackingCarrier ?? '',
        loadedTrackingNumber: order.trackingNumber ?? '',
        loadedAdminNotes: order.adminNotes ?? '',
        trackingCarrier: order.trackingCarrier ?? '',
        trackingNumber: order.trackingNumber ?? '',
        adminNotes: order.adminNotes ?? '',
        ...asked,
      });
    const o = await makeOrder({ paymentMethod: 'cod', status: 'confirmed', paymentStatus: 'pending' });
    const tabA = pageForm(await orderNow(o.id), { trackingNumber: 'AAA-111' });
    const tabB = pageForm(await orderNow(o.id), { trackingNumber: 'BBB-222', trackingCarrier: 'ACS' });
    const rB = await updateOrder(null, tabB);
    check('tab B saves a tracking number', rB?.ok === true && (await orderNow(o.id)).trackingNumber === 'BBB-222' && (await orderNow(o.id)).trackingCarrier === 'ACS', rB);
    const rA = await updateOrder(null, tabA);
    check('tab A, opened before B saved, is refused as stale', rA?.ok === false && String(rA.message).includes('άλλαξε στο μεταξύ'), rA);
    check('…and does not overwrite B', (await orderNow(o.id)).trackingNumber === 'BBB-222', (await orderNow(o.id)).trackingNumber);

    const tabC = pageForm(await orderNow(o.id), { adminNotes: 'σημείωση C' });
    const tabD = pageForm(await orderNow(o.id), { adminNotes: 'σημείωση D' });
    await updateOrder(null, tabD);
    const rC = await updateOrder(null, tabC);
    check('the same for notes: the stale tab is refused and D stays', rC?.ok === false && (await orderNow(o.id)).adminNotes === 'σημείωση D', [rC, (await orderNow(o.id)).adminNotes]);

    // a stale tab that does not touch tracking or notes still works: it only applies what it changed
    const tabE = pageForm({ ...(await orderNow(o.id)), trackingNumber: '', trackingCarrier: '', adminNotes: '' }, { status: 'shipped' });
    const rE = await updateOrder(null, tabE);
    const afterE = await orderNow(o.id);
    check('a stale tab that only changes the status succeeds', rE?.ok === true && afterE.status === 'shipped', rE);
    check('…and leaves the tracking and notes saved meanwhile alone', afterE.trackingNumber === 'BBB-222' && afterE.adminNotes === 'σημείωση D', [afterE.trackingNumber, afterE.adminNotes]);

    // nothing is half-saved: a payment change in the same save is undone when the tracking step finds the row has moved
    const o2 = await makeOrder({ paymentMethod: 'cod', status: 'confirmed', paymentStatus: 'pending', trackingNumber: 'NEW-1' });
    const staleTab = pageForm({ ...(await orderNow(o2.id)), trackingNumber: 'OLD-0' }, { paymentStatus: 'paid', trackingNumber: 'MINE-9' });
    const events2Before = (await eventsNow(o2.id)).length;
    const rRoll = await updateOrder(null, staleTab);
    const o2After = await orderNow(o2.id);
    check('a save whose tracking step is stale is refused', rRoll?.ok === false, rRoll);
    check('…and its payment change is rolled back with it', o2After.paymentStatus === 'pending' && o2After.paidAt === null && o2After.trackingNumber === 'NEW-1', [o2After.paymentStatus, o2After.trackingNumber]);
    check('…and leaves no event behind', (await eventsNow(o2.id)).length === events2Before, await eventsNow(o2.id));

    // browsers send line breaks as CRLF: an unchanged note must not look stale, and a changed one saves
    const o3 = await makeOrder({ paymentMethod: 'cod', status: 'confirmed', paymentStatus: 'pending', adminNotes: 'γραμμή 1\nγραμμή 2' });
    const crlf = pageForm({ ...(await orderNow(o3.id)) }, { loadedAdminNotes: 'γραμμή 1\r\nγραμμή 2', adminNotes: 'γραμμή 1\r\nγραμμή 2\r\nγραμμή 3' });
    const rCr = await updateOrder(null, crlf);
    check('a note with line breaks saves from a CRLF form', rCr?.ok === true && (await orderNow(o3.id)).adminNotes?.includes('γραμμή 3') === true, rCr);

    // cancelling through the editor still restocks and flags, in the same transaction
    const o4 = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-TXN', paymentProvider: 'viva' });
    const rCancel = await updateOrder(null, pageForm(await orderNow(o4.id), { status: 'cancelled' }));
    const o4After = await orderNow(o4.id);
    check('cancelling a paid order from the editor still works as one save', rCancel?.ok === true && o4After.status === 'cancelled' && o4After.paymentFlag === 'review', [rCancel, o4After.status, o4After.paymentFlag]);
  }

  console.log('Payment review and unmatched payments (admin actions)');
  const flagged = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-5', paymentProvider: 'viva', paymentFlag: 'review' });
  const eventsFlaggedBefore = (await eventsNow(flagged.id)).length;
  await resolvePaymentReview(form({ id: String(flagged.id) }));
  const flaggedAfter = await orderNow(flagged.id);
  check('resolvePaymentReview clears the flag', flaggedAfter.paymentFlag === null, flaggedAfter.paymentFlag);
  const eventsFlaggedAfter = await eventsNow(flagged.id);
  check('…and adds exactly one «ολοκληρώθηκε» event', eventsFlaggedAfter.length === eventsFlaggedBefore + 1 && eventsFlaggedAfter.filter((m) => m.includes('Έλεγχος πληρωμής: ολοκληρώθηκε.')).length === 1, eventsFlaggedAfter);
  await resolvePaymentReview(form({ id: String(flagged.id) }));
  check('calling it again adds nothing', (await eventsNow(flagged.id)).length === eventsFlaggedAfter.length, await eventsNow(flagged.id));

  const [um] = await db.insert(unmatchedPayments).values({ provider: 'viva', orderCode: '9515982136486001', transactionId: 'TX-ADM-UM-1', amountCents: 1999, currency: 'EUR' }).returning();
  const umRow = async () => (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.id, um.id)))[0];
  await resolveUnmatchedPayment(form({ id: String(um.id), note: 'επιστράφηκε' }));
  const um1 = await umRow();
  check('resolveUnmatchedPayment sets resolvedAt and the note', um1.resolvedAt !== null && um1.note === 'επιστράφηκε', um1);
  await resolveUnmatchedPayment(form({ id: String(um.id), note: 'άλλη σημείωση' }));
  const um2 = await umRow();
  check('a second call does not overwrite the note or resolvedAt', um2.note === 'επιστράφηκε' && um2.resolvedAt?.getTime() === um1.resolvedAt?.getTime(), um2);

  console.log('Sales and coupons refuse without an administrator');
  cookieJar.clear();
  const refusedWithoutSession = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return false;
    } catch (err) {
      return String((err as { digest?: string }).digest ?? '').startsWith('NEXT_REDIRECT');
    }
  };
  check('saveSale redirects to login without a session', await refusedWithoutSession(() => saveSale(null, form({ name: 'Χωρίς σύνδεση', type: 'percent', value: '20', brandIds: brandId }))));
  check('deleteSale redirects to login without a session', await refusedWithoutSession(() => deleteSale(form({ id: '1' }))));
  check('searchAdminProducts redirects to login without a session', await refusedWithoutSession(() => searchAdminProducts('λαδι')));

  console.log('Payment actions refuse without an administrator');
  cookieJar.clear();
  const flagForNoSession = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-ADM-6', paymentProvider: 'viva', paymentFlag: 'review' });
  check('resolvePaymentReview redirects to login without a session', await refusedWithoutSession(() => resolvePaymentReview(form({ id: String(flagForNoSession.id) }))));
  check('resolveUnmatchedPayment redirects to login without a session', await refusedWithoutSession(() => resolveUnmatchedPayment(form({ id: String(um.id), note: 'χωρίς σύνδεση' }))));
  check('updateOrder redirects to login without a session', await refusedWithoutSession(() => updateOrder(null, statusForm(flagForNoSession, 'failed'))));
  check('…and the refused calls changed nothing', (await orderNow(flagForNoSession.id)).paymentFlag === 'review' && (await umRow()).note === 'επιστράφηκε');

  console.log('Fixes from the bug hunt');
  // the section above emptied the cookie jar to test refusals, so this section signs in again
  await createSession('admin', admin.id, admin.tokenVersion);
  const { deleteProduct, deleteTaxon } = await import('../src/app/admin/actions');
  const { categories } = await import('../src/lib/db/schema');
  // every coupon and sale this section writes, by its unique code or name, so the cleanup can remove them
  const fixCodes = ['FIXSOLO', 'FIXPAIR', 'FIXFREE', 'FIXCAT', 'FIXPROD', 'FIXP12', 'FIXP100', 'FIXREFUSE'];
  const fixSaleNames = ['Δοκιμή μόνο Β2', 'Δοκιμή 90', 'Δοκιμή ποσοστού'];
  // deleteProduct ends in redirect(), which throws NEXT_REDIRECT: that throw is the expected outcome here
  const redirected = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return false;
    } catch (err) {
      return String((err as { digest?: string }).digest ?? '').startsWith('NEXT_REDIRECT');
    }
  };
  const addCoupon = async (code: string, over: Partial<typeof coupons.$inferInsert> = {}) => {
    const [row] = await db
      .insert(coupons)
      .values({ code, type: 'percent', value: 10, productIds: [], brandIds: [], categoryIds: [], isActive: true, ...over })
      .returning();
    return row;
  };
  const addSale = async (name: string, over: Partial<typeof sales.$inferInsert> = {}) => {
    const [row] = await db
      .insert(sales)
      .values({ name, type: 'percent', value: 10, productIds: [], brandIds: [], categoryIds: [], isActive: true, ...over })
      .returning();
    return row;
  };
  const couponNow = async (id: number) => (await db.select().from(coupons).where(eq(coupons.id, id)))[0];
  const saleNow = async (id: number) => (await db.select().from(sales).where(eq(sales.id, id)))[0];
  const isEmptyTargets = (row: { productIds: number[]; brandIds: number[]; categoryIds: number[] }) => row.productIds.length === 0 && row.brandIds.length === 0 && row.categoryIds.length === 0;

  const [b2] = await db.insert(brands).values({ slug: 'e2e-fix-b2', name: 'Τεστ Β2' }).returning();
  const soloB = await addCoupon('FIXSOLO', { brandIds: [b2.id] });
  const pairB = await addCoupon('FIXPAIR', { brandIds: [b2.id, anyBrand.id] });
  const freeC = await addCoupon('FIXFREE');
  const soloSale = await addSale('Δοκιμή μόνο Β2', { brandIds: [b2.id] });
  await deleteTaxon(form({ id: String(b2.id), kind: 'brand' }));
  const soloBAfter = await couponNow(soloB.id);
  check('a coupon limited only to the deleted brand is switched off, not widened to the whole shop', soloBAfter.brandIds.length === 0 && soloBAfter.isActive === false, soloBAfter);
  const pairBAfter = await couponNow(pairB.id);
  check('a coupon limited to the deleted brand and another loses only the deleted one and stays on', JSON.stringify(pairBAfter.brandIds) === JSON.stringify([anyBrand.id]) && pairBAfter.isActive === true, pairBAfter);
  const soloSaleAfter = await saleNow(soloSale.id);
  check('a sale limited only to the deleted brand is switched off with empty lists', isEmptyTargets(soloSaleAfter) && soloSaleAfter.isActive === false, soloSaleAfter);
  const freeAfter = await couponNow(freeC.id);
  check('a coupon with no targets at all is untouched', freeAfter.isActive === true && isEmptyTargets(freeAfter), freeAfter);

  const [cat] = await db.insert(categories).values({ slug: 'e2e-fix-cat', name: 'Τεστ κατηγορία' }).returning();
  const catCoupon = await addCoupon('FIXCAT', { categoryIds: [cat.id] });
  await deleteTaxon(form({ id: String(cat.id), kind: 'category' }));
  const catAfter = await couponNow(catCoupon.id);
  check('the same holds for a deleted category', catAfter.categoryIds.length === 0 && catAfter.isActive === false, catAfter);

  const [fixProduct] = await db.insert(products).values({ slug: 'e2e-fix-product', name: 'Τεστ προϊόν διαγραφής' }).returning();
  await db.insert(variants).values({ productId: fixProduct.id, sku: 'E2E-FIX-DEL', label: '1L', volumeMl: 1000, priceCents: 1000 });
  const prodCoupon = await addCoupon('FIXPROD', { productIds: [fixProduct.id] });
  const productRedirected = await redirected(() => deleteProduct(form({ id: String(fixProduct.id) })));
  check('deleteProduct redirects back to the product list', productRedirected);
  const prodAfter = await couponNow(prodCoupon.id);
  check('the same holds for a deleted product', prodAfter.productIds.length === 0 && prodAfter.isActive === false, prodAfter);
  const [gone] = await db.select().from(products).where(eq(products.id, fixProduct.id));
  check('the deleted product row is gone', gone === undefined);

  // The owner's deliberate choice: re-saving a switched-off coupon with no targets widens it to the whole shop and turns it on again.
  const widened = await runCoupon(form({ id: String(soloB.id), code: 'FIXSOLO', type: 'percent', value: '10', isActive: 'on' }));
  const widenedRow = await couponNow(soloB.id);
  check('re-saving the switched-off coupon with no targets is allowed (the owner widens it on purpose)', widened.ok === true && isEmptyTargets(widenedRow) && widenedRow.isActive === true, { widened, row: widenedRow });

  const couponPercentRefusals: Array<[string, string]> = [
    ['12,5', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['12.5', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['abc', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['0', 'Συμπληρώστε αξία έκπτωσης.'],
    ['1000', 'Μέγιστο 100%.'],
    ['', 'Συμπληρώστε αξία έκπτωσης.'],
  ];
  for (const [value, message] of couponPercentRefusals) {
    const refused = await runCoupon(form({ code: 'FIXREFUSE', type: 'percent', value }));
    check(`a coupon with value "${value}" is refused`, refused.ok === false && refused.message === message, refused);
  }
  const salePercentRefusals: Array<[string, string]> = [
    ['12,5', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['12.5', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['abc', 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.'],
    ['0', 'Συμπληρώστε αξία έκπτωσης.'],
    ['91', 'Μέγιστο 90%.'],
    ['', 'Συμπληρώστε αξία έκπτωσης.'],
  ];
  for (const [value, message] of salePercentRefusals) {
    const refused = await runSale(form({ name: 'Δοκιμή ποσοστού', type: 'percent', value, brandIds: brandId }));
    check(`a sale with value "${value}" is refused`, refused.ok === false && refused.message === message, refused);
  }
  const refusedRows = (await db.select().from(coupons).where(eq(coupons.code, 'FIXREFUSE'))).length + (await db.select().from(sales).where(eq(sales.name, 'Δοκιμή ποσοστού'))).length;
  check('the refused percentages wrote no row', refusedRows === 0, refusedRows);
  const accepted12 = await runCoupon(form({ code: 'FIXP12', type: 'percent', value: '12' }));
  const accepted100 = await runCoupon(form({ code: 'FIXP100', type: 'percent', value: '100' }));
  const accepted90 = await runSale(form({ name: 'Δοκιμή 90', type: 'percent', value: '90', brandIds: brandId }));
  check('valid 12 and 100 (coupon) and 90 (sale) are accepted', accepted12.ok === true && accepted100.ok === true && accepted90.ok === true, [accepted12, accepted100, accepted90]);

  console.log('Cancelling a hand-marked paid order while un-paying it');
  // The owner marked a card order paid by hand (no gateway reference), then un-pays and cancels it in one save: no money was
  // taken, so there is no refund alarm. (A payment landing between the two reads inside updateOrder cannot be driven from
  // outside; the case "cancel while it stays paid" is covered above and does flag.)
  const handPaid = await makeOrder({ status: 'pending', paymentStatus: 'pending' });
  await db.update(orders).set({ paymentStatus: 'paid', paidAt: new Date() }).where(eq(orders.id, handPaid.id));
  const rHand = await updateOrder(null, form({ id: String(handPaid.id), status: 'cancelled', paymentStatus: 'pending' }));
  const handAfter = await orderNow(handPaid.id);
  check('the cancel together with un-paying a hand-marked order is accepted', rHand?.ok === true && handAfter.status === 'cancelled', [rHand, handAfter.status]);
  check('…it ends unpaid, with no review flag', handAfter.paymentStatus === 'pending' && handAfter.paymentFlag === null, [handAfter.paymentStatus, handAfter.paymentFlag]);
  check('…and no refund alarm in its history', !(await eventsNow(handPaid.id)).some((m) => m.includes('ΠΡΟΣΟΧΗ')));

  console.log('Round 3 fixes');
  {
    // the sections above may have emptied the cookie jar: sign in again
    await createSession('admin', admin.id, admin.tokenVersion);
    const { sql } = await import('drizzle-orm');
    const { pruneDeadTargets } = await import('../src/lib/discount-cleanup');
    const { deleteTaxon } = await import('../src/app/admin/actions');
    const r3Codes = ['R3BAD', 'R3GOOD', 'R3MAX5', 'R3MAXE', 'R3MIN1', 'R3MINE', 'R3PRUNE', 'R3FREE', 'SUMMER-10'];
    const couponRow = async (id: number) => (await db.select().from(coupons).where(eq(coupons.id, id)))[0];
    const saleRow = async (id: number) => (await db.select().from(sales).where(eq(sales.id, id)))[0];
    const emptyTargets = (row: { productIds: number[]; brandIds: number[]; categoryIds: number[] }) => row.productIds.length === 0 && row.brandIds.length === 0 && row.categoryIds.length === 0;
    const rowsWithCode = async (code: string) => (await db.select().from(coupons).where(eq(coupons.code, code))).length;

    console.log('  Stale order forms');
    // a) a stale tab that only saves a tracking number must not un-pay an order paid meanwhile
    const staleCod = await makeOrder({ paymentMethod: 'cod', status: 'pending', paymentStatus: 'pending' });
    await db.update(orders).set({ paymentStatus: 'paid', paidAt: new Date() }).where(eq(orders.id, staleCod.id));
    const rCod = await updateOrder(null, form({ id: String(staleCod.id), status: 'pending', paymentStatus: 'pending', loadedStatus: 'pending', loadedPayment: 'pending', trackingNumber: 'T1' }));
    const staleCodAfter = await orderNow(staleCod.id);
    check('a stale form that only adds a tracking number is accepted', rCod?.ok === true, rCod);
    check('…the order stays paid (nothing is un-paid)', staleCodAfter.paymentStatus === 'paid' && staleCodAfter.paidAt !== null, [staleCodAfter.paymentStatus, staleCodAfter.paidAt]);
    check('…and the tracking number is saved', staleCodAfter.trackingNumber === 'T1', staleCodAfter.trackingNumber);

    // b) the owner picks «paid» on a card order that moved on (confirmed + paid by the gateway) since the page was opened
    const staleCard = await makeOrder({ status: 'pending', paymentStatus: 'pending' });
    await db.update(orders).set({ status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(), paymentTransactionId: 'TX-1', paymentProvider: 'viva' }).where(eq(orders.id, staleCard.id));
    const rStaleCard = await updateOrder(null, form({ id: String(staleCard.id), status: 'pending', paymentStatus: 'paid', loadedStatus: 'pending', loadedPayment: 'pending' }));
    check('a payment edit from a form that is out of date is refused', rStaleCard?.ok === false && (rStaleCard?.message ?? '').includes('άλλαξε στο μεταξύ'), rStaleCard);
    check('…and the order stays confirmed', (await orderNow(staleCard.id)).status === 'confirmed', (await orderNow(staleCard.id)).status);

    // c) the owner changes the status of a row that moved on since the page was opened
    const staleStatus = await makeOrder({ status: 'pending', paymentStatus: 'pending' });
    await db.update(orders).set({ status: 'processing' }).where(eq(orders.id, staleStatus.id));
    const rStaleStatus = await updateOrder(null, form({ id: String(staleStatus.id), status: 'shipped', paymentStatus: 'pending', loadedStatus: 'pending', loadedPayment: 'pending' }));
    check('a status change from a form that is out of date is refused', rStaleStatus?.ok === false && (rStaleStatus?.message ?? '').includes('άλλαξε στο μεταξύ'), rStaleStatus);
    check('…and the row keeps its newer status', (await orderNow(staleStatus.id)).status === 'processing', (await orderNow(staleStatus.id)).status);

    // d) an old caller without the loaded fields: the form is compared with the row as it is now
    const plainOld = await makeOrder({ status: 'pending', paymentStatus: 'pending' });
    const rPlainOld = await updateOrder(null, form({ id: String(plainOld.id), status: 'processing', paymentStatus: 'pending' }));
    check('without the loaded fields an ordinary status change is still applied', rPlainOld?.ok === true && (await orderNow(plainOld.id)).status === 'processing', rPlainOld);

    console.log('  Coupon code, maximum uses and minimum');
    const greekCode = await runCoupon(form({ code: 'ΦΘΙΝΟΠΩΡΟ2026', type: 'percent', value: '10' }));
    check('a code with Greek letters is refused', greekCode.ok === false && (greekCode.message ?? '').includes('λατινικά'), greekCode);
    check('…and no row is written for it', (await rowsWithCode('ΦΘΙΝΟΠΩΡΟ2026')) === 0);
    const lowerCode = await runCoupon(form({ code: 'summer-10', type: 'percent', value: '10' }));
    const [summer] = await db.select().from(coupons).where(eq(coupons.code, 'SUMMER-10'));
    check("'summer-10' is accepted and stored as 'SUMMER-10'", lowerCode.ok === true && summer !== undefined, [lowerCode, summer?.code]);
    for (const maxUses of ['abc', '0', '-3', '1.5']) {
      const refused = await runCoupon(form({ code: 'R3MAX', type: 'percent', value: '10', maxUses }));
      check(`maxUses "${maxUses}" is refused`, refused.ok === false && (refused.message ?? '').includes('μέγιστες χρήσεις'), refused);
    }
    check('…and no row is written for those', (await rowsWithCode('R3MAX')) === 0);
    const maxFive = await runCoupon(form({ code: 'R3MAX5', type: 'percent', value: '10', maxUses: '5' }));
    const [m5] = await db.select().from(coupons).where(eq(coupons.code, 'R3MAX5'));
    check("maxUses '5' is stored as 5", maxFive.ok === true && m5?.maxUses === 5, m5);
    const maxEmpty = await runCoupon(form({ code: 'R3MAXE', type: 'percent', value: '10', maxUses: '' }));
    const [mE] = await db.select().from(coupons).where(eq(coupons.code, 'R3MAXE'));
    check("maxUses '' is stored as null (unlimited)", maxEmpty.ok === true && mE?.maxUses === null, mE);
    const minRefused = await runCoupon(form({ code: 'R3MIN', type: 'percent', value: '10', minSubtotal: '1.250' }));
    check("minSubtotal '1.250' is refused", minRefused.ok === false && (minRefused.message ?? '').includes('ελάχιστη αγορά'), minRefused);
    check('…and no row is written for it', (await rowsWithCode('R3MIN')) === 0);
    const minFifty = await runCoupon(form({ code: 'R3MIN1', type: 'percent', value: '10', minSubtotal: '30,50' }));
    const [min1] = await db.select().from(coupons).where(eq(coupons.code, 'R3MIN1'));
    check("minSubtotal '30,50' is stored as 3050 cents", minFifty.ok === true && min1?.minSubtotalCents === 3050, min1);
    const minEmpty = await runCoupon(form({ code: 'R3MINE', type: 'percent', value: '10', minSubtotal: '' }));
    const [minE] = await db.select().from(coupons).where(eq(coupons.code, 'R3MINE'));
    check("minSubtotal '' is stored as 0", minEmpty.ok === true && minE?.minSubtotalCents === 0, minE);

    console.log('  Deleting a brand with an unreadable coupon');
    const [b3] = await db.insert(brands).values({ slug: 'e2e-r3-b3', name: 'Τεστ Β3' }).returning();
    const [goodR3] = await db.insert(coupons).values({ code: 'R3GOOD', type: 'percent', value: 10, productIds: [], brandIds: [b3.id], categoryIds: [], isActive: true }).returning();
    const [badR3] = await db.insert(coupons).values({ code: 'R3BAD', type: 'percent', value: 10, productIds: [], brandIds: [b3.id], categoryIds: [], isActive: true }).returning();
    await db.run(sql`UPDATE coupons SET brand_ids = 'not json' WHERE id = ${badR3.id}`);
    let deleteThrew = false;
    try {
      await deleteTaxon(form({ id: String(b3.id), kind: 'brand' }));
    } catch {
      deleteThrew = true;
    }
    check('deleting the brand completes without throwing', !deleteThrew);
    const goodR3After = await couponRow(goodR3.id);
    check('…the valid coupon is switched off with empty brand targets', goodR3After.isActive === false && goodR3After.brandIds.length === 0, goodR3After);
    const rawBad = await db.all<{ brand_ids: string | null }>(sql`SELECT brand_ids FROM coupons WHERE id = ${badR3.id}`);
    check('…the unreadable coupon is left as it was', rawBad[0]?.brand_ids === 'not json', rawBad);

    console.log('  Pruning dead targets');
    const [pruneCoupon] = await db.insert(coupons).values({ code: 'R3PRUNE', type: 'percent', value: 10, productIds: [], brandIds: [anyBrand.id, 999991], categoryIds: [], isActive: true }).returning();
    const [pruneSale] = await db.insert(sales).values({ name: 'Δοκιμή κλάδεμα', type: 'percent', value: 10, productIds: [999992], brandIds: [], categoryIds: [], isActive: true }).returning();
    const [freeR3] = await db.insert(coupons).values({ code: 'R3FREE', type: 'percent', value: 10, productIds: [], brandIds: [], categoryIds: [], isActive: true }).returning();
    const firstPrune = await pruneDeadTargets();
    check('the first run cleans at least the two dead rows and switches one off', firstPrune.cleaned >= 2 && firstPrune.switchedOff >= 1, firstPrune);
    const prunedCoupon = await couponRow(pruneCoupon.id);
    check('the coupon keeps its live brand and stays on', JSON.stringify(prunedCoupon.brandIds) === JSON.stringify([anyBrand.id]) && prunedCoupon.isActive === true, prunedCoupon);
    const prunedSale = await saleRow(pruneSale.id);
    check('the sale with only dead targets is emptied and switched off', emptyTargets(prunedSale) && prunedSale.isActive === false, prunedSale);
    const freeAfterPrune = await couponRow(freeR3.id);
    check('a coupon with no targets stays active and untouched', freeAfterPrune.isActive === true && emptyTargets(freeAfterPrune), freeAfterPrune);
    const secondPrune = await pruneDeadTargets();
    check('running it again changes nothing (cleaned 0, switchedOff 0)', secondPrune.cleaned === 0 && secondPrune.switchedOff === 0, secondPrune);

    console.log('  Refund keeps the payment date');
    const pastPaid = new Date('2026-01-10T09:00:00Z');
    const refundOrder = await makeOrder({ status: 'confirmed', paymentStatus: 'paid', paidAt: pastPaid, paymentTransactionId: 'TX-R3-REF', paymentProvider: 'viva', paymentFlag: 'review' });
    const rRefund = await updateOrder(null, form({ id: String(refundOrder.id), status: 'confirmed', paymentStatus: 'refunded', loadedStatus: 'confirmed', loadedPayment: 'paid' }));
    const refundAfter = await orderNow(refundOrder.id);
    check('paid → refunded is accepted', rRefund?.ok === true, rRefund);
    check('…paidAt keeps its original timestamp', refundAfter.paidAt?.getTime() === pastPaid.getTime(), refundAfter.paidAt);
    check('…and the review flag is cleared', refundAfter.paymentFlag === null, refundAfter.paymentFlag);

    const rRefusedFailed = await updateOrder(null, form({ id: String(refundOrder.id), status: 'confirmed', paymentStatus: 'failed', loadedStatus: 'confirmed', loadedPayment: 'refunded' }));
    const rRefusedPaid = await updateOrder(null, form({ id: String(refundOrder.id), status: 'confirmed', paymentStatus: 'paid', loadedStatus: 'confirmed', loadedPayment: 'refunded' }));
    check('a refunded order refuses any other payment status', rRefusedFailed?.ok === false && rRefusedPaid?.ok === false, [rRefusedFailed, rRefusedPaid]);
    const refusedAfter = await orderNow(refundOrder.id);
    check('…and the refused calls changed nothing in the database', refusedAfter.paymentStatus === 'refunded' && refusedAfter.paidAt?.getTime() === pastPaid.getTime() && refusedAfter.paymentTransactionId === 'TX-R3-REF' && refusedAfter.status === 'confirmed' && refusedAfter.paymentFlag === null, refusedAfter);

    for (const code of r3Codes) await db.delete(coupons).where(eq(coupons.code, code));
    await db.delete(sales).where(eq(sales.name, 'Δοκιμή κλάδεμα'));
  }

  console.log('Concurrent changes');
  {
    const { customers } = await import('../src/lib/db/schema');
    const { hashPassword, randomToken, sha256 } = await import('../src/lib/auth/password');
    const { resetPassword } = await import('../src/app/(store)/account/actions');
    const { recordPayment } = await import('../src/lib/orders');

    // a reset link used twice at the same moment: only one of the two may set a password and sign in
    const token = randomToken();
    const [customer] = await db
      .insert(customers)
      .values({ email: 'reset-race@example.com', passwordHash: await hashPassword('old-password-1'), firstName: 'Τεστ', lastName: 'Reset', resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 60 * 60 * 1000) })
      .returning();
    const reset = (password: string) =>
      resetPassword(null, form({ token, password })).then(
        (r) => r?.ok === true,
        (err: unknown) => (String((err as { digest?: string })?.digest ?? err).startsWith('NEXT_REDIRECT') ? true : Promise.reject(err)),
      );
    const outcomes = await Promise.all([reset('first-password-1'), reset('second-password-2')]);
    check('one reset link used twice at once works exactly once', outcomes.filter(Boolean).length === 1, outcomes);
    const [afterReset] = await db.select().from(customers).where(eq(customers.id, customer.id));
    check('…and the sessions were invalidated once (token version +1)', afterReset.tokenVersion === customer.tokenVersion + 1, afterReset.tokenVersion);
    check('…and the link is spent', afterReset.resetTokenHash === null);
    await db.delete(customers).where(eq(customers.id, customer.id));

    // a stock adjustment from an exported file, read at 10, saved after a sale took one unit: 9 + 2 = 11 (not the stale 12)
    const { applyPriceChanges } = await import('../src/lib/price-apply');
    const [stockVariant] = await db.select().from(variants).limit(1);
    await db.update(variants).set({ trackStock: true, stock: 10 }).where(eq(variants.id, stockVariant.id));
    const stalePlan = planPriceImport(
      `sku;price;stock;exported_stock\n${stockVariant.sku};${(stockVariant.priceCents / 100).toFixed(2).replace('.', ',')};12;10\n`,
      new Map([[stockVariant.sku, { id: stockVariant.id, priceCents: stockVariant.priceCents, priceVerified: stockVariant.priceVerified, stock: 10, trackStock: true, availability: stockVariant.availability }]]),
    );
    if (stalePlan.error !== undefined) throw new Error(stalePlan.error);
    await db.update(variants).set({ stock: 9 }).where(eq(variants.id, stockVariant.id));
    await db.transaction((tx) => applyPriceChanges(tx, stalePlan.changes));
    const stockAfterImport = (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, stockVariant.id)))[0].s;
    check('an import adjustment is applied to the stock as it is when saved: 9 + 2 = 11', stockAfterImport === 11, stockAfterImport);
    await db.update(variants).set({ stock: 1 }).where(eq(variants.id, stockVariant.id));
    const down = planPriceImport(`sku;price;stock;exported_stock\n${stockVariant.sku};${(stockVariant.priceCents / 100).toFixed(2).replace('.', ',')};5;10\n`, new Map([[stockVariant.sku, { id: stockVariant.id, priceCents: stockVariant.priceCents, priceVerified: stockVariant.priceVerified, stock: 10, trackStock: true, availability: stockVariant.availability }]]));
    if (down.error !== undefined) throw new Error(down.error);
    await db.transaction((tx) => applyPriceChanges(tx, down.changes));
    check('…and a downward adjustment never takes the stock below zero', (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, stockVariant.id)))[0].s === 0);

    // the owner saves «Απέτυχε» and the card payment lands right after the order was read: the payment must survive.
    // The race is forced: the first read of the order inside updateOrder is delayed until the payment has been recorded.
    const raced = await makeOrder({ paymentMethod: 'card' });
    const realSelect = db.select.bind(db);
    let armed = true;
    const delayed = (builder: unknown, after: () => Promise<unknown>): unknown =>
      new Proxy(builder as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value.call(target)).then(async (rows) => { await after(); return rows; }).then(resolve, reject);
          return typeof value === 'function' ? (...args: unknown[]) => delayed(value.apply(target, args), after) : value;
        },
      });
    (db as unknown as { select: unknown }).select = (...args: unknown[]) => {
      const builder = (realSelect as (...a: unknown[]) => unknown)(...args) as { from: (t: unknown) => unknown };
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop !== 'from') return Reflect.get(target, prop, receiver);
          return (table: unknown) => {
            const next = target.from(table);
            if (!armed || table !== orders) return next;
            armed = false;
            return delayed(next, () => recordPayment(raced.id, { provider: 'test', ref: 'race-tx', amountCents: raced.totalCents }));
          };
        },
      });
    };
    let result;
    try {
      result = await updateOrder(null, form({ id: String(raced.id), status: raced.status, paymentStatus: 'failed', loadedStatus: raced.status, loadedPayment: 'pending' }));
    } finally {
      (db as unknown as { select: unknown }).select = realSelect;
    }
    const afterRace = await orderNow(raced.id);
    check('a payment that lands while the owner saves «Απέτυχε» is not overwritten', afterRace.paymentStatus === 'paid' && afterRace.paidAt !== null, [afterRace.paymentStatus, afterRace.paidAt]);
    check('…and the owner is told to reload instead of seeing «saved»', result?.ok === false, result);

    // reviving a cancelled order is refused as a whole: the payment change in the same save must not be written either
    const dead = await makeOrder({ paymentMethod: 'card', status: 'cancelled' });
    const revive = await updateOrder(null, form({ id: String(dead.id), status: 'processing', paymentStatus: 'paid', loadedStatus: 'cancelled', loadedPayment: 'pending' }));
    const deadAfter = await orderNow(dead.id);
    check('a save that tries to revive a cancelled order is refused…', revive?.ok === false, revive);
    check('…and its payment change is not written either', deadAfter.paymentStatus === 'pending' && deadAfter.status === 'cancelled', [deadAfter.paymentStatus, deadAfter.status]);
  }

  console.log('Renamed brands and categories in the product search');
  {
    const { brands: brandTable, categories: categoryTable, products: productTable } = await import('../src/lib/db/schema');
    const { saveBrand, saveCategory, deleteTaxon } = await import('../src/app/admin/actions');
    const { listProducts } = await import('../src/lib/catalog');
    const [probe] = await db
      .select({ id: productTable.id, brandId: productTable.brandId, categoryId: productTable.categoryId })
      .from(productTable)
      .innerJoin(variants, eq(variants.productId, productTable.id))
      .where(eq(productTable.isActive, true))
      .limit(1);
    const [brand] = await db.select().from(brandTable).where(eq(brandTable.id, probe.brandId!));
    const [category] = await db.select().from(categoryTable).where(eq(categoryTable.id, probe.categoryId!));
    const finds = async (q: string) => (await listProducts({ q, perPage: 1000 })).products.some((p) => p.id === probe.id);
    const brandForm = (name: string) => form({ id: String(brand.id), name, slug: '', country: brand.country ?? '', description: brand.description ?? '', sort: String(brand.sort) });
    await saveBrand(null, brandForm('Ζυξβραντ'));
    check('after a brand is renamed the product is found under the NEW name', await finds('ζυξβραντ'));
    await saveBrand(null, brandForm('Ζυξαλλο'));
    check('…and renamed again, no longer under the previous name', !(await finds('ζυξβραντ')) && (await finds('ζυξαλλο')));
    await saveBrand(null, brandForm(brand.name));
    check('renaming it back finds the product under the original name again', await finds(brand.name));

    const categoryForm = (name: string) => form({ id: String(category.id), name, slug: '', parentId: category.parentId ? String(category.parentId) : '', icon: category.icon ?? '', description: category.description ?? '', sort: String(category.sort), isActive: 'on' });
    await saveCategory(null, categoryForm('Ζυξκατηγορια'));
    check('after a category is renamed the product is found under the NEW name', await finds('ζυξκατηγορια'));
    await saveCategory(null, categoryForm(category.name));

    // a brand that is deleted stops matching its products
    const { rebuildSearchTexts } = await import('../src/lib/search-text');
    const [temp] = await db.insert(brandTable).values({ name: 'Ζυξδιαγραφη', slug: 'test-zyx-delete' }).returning();
    await db.update(productTable).set({ brandId: temp.id }).where(eq(productTable.id, probe.id));
    await rebuildSearchTexts({ brandId: temp.id });
    check('a product found under its brand\'s name…', await finds('ζυξδιαγραφη'));
    await deleteTaxon(form({ id: String(temp.id), kind: 'brand' }));
    check('…stops being found under it once the brand is deleted', !(await finds('ζυξδιαγραφη')));
    await db.update(productTable).set({ brandId: brand.id }).where(eq(productTable.id, probe.id));
  }

  console.log('Category tree (saveCategory)');
  {
    const { categories } = await import('../src/lib/db/schema');
    const { saveCategory } = await import('../src/app/admin/actions');
    const [top] = await db.insert(categories).values({ name: 'ΔοκιμήΑ', slug: 'test-loop-a' }).returning();
    const [mid] = await db.insert(categories).values({ name: 'ΔοκιμήΒ', slug: 'test-loop-b', parentId: top.id }).returning();
    const [low] = await db.insert(categories).values({ name: 'ΔοκιμήΓ', slug: 'test-loop-c', parentId: mid.id }).returning();
    const move = async (id: number, parentId: number) => (await saveCategory(null, form({ id: String(id), name: 'Δοκιμή', slug: '', parentId: String(parentId), isActive: 'on' })))!;
    const loop = await move(top.id, low.id);
    check('a category cannot be moved under its own grandchild', loop.ok === false, loop);
    check('…and nothing changed', (await db.select().from(categories).where(eq(categories.id, top.id)))[0].parentId === null);
    const fine = await move(low.id, top.id);
    check('moving it under an ancestor is still allowed', fine.ok === true, fine);
    await db.delete(categories).where(inArray(categories.id, [top.id, mid.id, low.id]));
  }

  console.log('Second pass');
  {
    const { saveProduct, imageAction } = await import('../src/app/admin/actions');
    const { orderItems, productImages, variants } = await import('../src/lib/db/schema');
    // saveProduct ends with redirect(), which throws: that is its success
    const runProduct = async (fd: FormData) => saveProduct(null, fd).catch((err: unknown) => (String((err as { digest?: string })?.digest ?? err).startsWith('NEXT_REDIRECT') ? { ok: true as const, message: 'redirect' } : Promise.reject(err)));
    const [p2] = await db.select().from(products).limit(1);
    const sizes = await db.select().from(variants).where(eq(variants.productId, p2.id));
    const [first] = sizes;
    await db.update(variants).set({ trackStock: true, stock: 10 }).where(eq(variants.id, first.id));
    const rowsAt = (stockOf: (id: number) => number, loaded: number) =>
      JSON.stringify(sizes.map((v) => ({ id: v.id, label: v.label, sku: v.sku, price: (v.priceCents / 100).toFixed(2).replace('.', ','), compareAt: '', stock: v.id === first.id ? stockOf(v.id) : v.stock, loadedStock: v.id === first.id ? loaded : v.stock, trackStock: v.id === first.id ? true : v.trackStock, availability: v.availability, weightGrams: v.weightGrams, barcode: v.barcode ?? '', mpn: v.mpn ?? '', imageUrl: v.imageUrl ?? '', isActive: v.isActive, priceVerified: v.priceVerified })));
    const productForm = (variantsJson: string) => form({ id: String(p2.id), name: p2.name, variants: variantsJson, isActive: 'on' });
    const stockOfFirst = async () => (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, first.id)))[0].s;
    // the page was loaded at 10; an order then took 3
    await db.update(variants).set({ stock: 7 }).where(eq(variants.id, first.id));
    await runProduct(productForm(rowsAt(() => 10, 10)));
    check('a product save that did not touch the stock keeps the units sold meanwhile', (await stockOfFirst()) === 7, await stockOfFirst());
    await runProduct(productForm(rowsAt(() => 12, 10)));
    check('…and the owner\'s +2 is added to the stock as it is now', (await stockOfFirst()) === 9, await stockOfFirst());
    const unreadable = await runProduct(form({ id: String(p2.id), name: p2.name, isActive: 'on', variants: rowsAt(() => 9, 9).replace('"compareAt":""', '"compareAt":"abc"') }));
    check('an unreadable «Αρχική €» is refused instead of being dropped', unreadable?.ok === false && (unreadable.message ?? '').includes('αρχική τιμή'), unreadable);

    // a photo that a past order still shows stays on disk when it is removed from the product
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    process.env.DATA_DIR = dir;
    mkdirSync(path.join(dir, 'uploads', 'products'), { recursive: true });
    const keptUrl = '/media/products/second-pass-kept.webp';
    const goneUrl = '/media/products/second-pass-gone.webp';
    for (const url of [keptUrl, goneUrl]) writeFileSync(path.join(dir, 'uploads', url.slice('/media/'.length)), 'x');
    const [kept] = await db.insert(productImages).values({ productId: p2.id, url: keptUrl, alt: 'x', sort: 99 }).returning();
    const [gone] = await db.insert(productImages).values({ productId: p2.id, url: goneUrl, alt: 'x', sort: 98 }).returning();
    await db.insert(orderItems).values({ orderId: createdOrderIds[0], productId: p2.id, variantId: first.id, name: 'x', variantLabel: 'x', sku: 'x', imageUrl: keptUrl, unitPriceCents: 100, quantity: 1, lineTotalCents: 100, weightGrams: 0 });
    await imageAction(form({ imageId: String(kept.id), op: 'delete' }));
    await imageAction(form({ imageId: String(gone.id), op: 'delete' }));
    check('a deleted photo that a past order shows stays on disk', existsSync(path.join(dir, 'uploads', 'products', 'second-pass-kept.webp')));
    check('…while one that nothing shows any more is removed', !existsSync(path.join(dir, 'uploads', 'products', 'second-pass-gone.webp')));
    delete process.env.DATA_DIR;
  }

  console.log('Product sizes: removal and stock');
  {
    const { saveProduct } = await import('../src/app/admin/actions');
    const { orderItems, priceChanges } = await import('../src/lib/db/schema');
    const { buildSkroutzFeed } = await import('../src/lib/skroutz-feed');
    const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
    const { getProductBySlug, resolveCartLines } = await import('../src/lib/catalog');
    const { and, isNull, ne } = await import('drizzle-orm');
    const runProduct = async (fd: FormData) => saveProduct(null, fd).catch((err: unknown) => (String((err as { digest?: string })?.digest ?? err).startsWith('NEXT_REDIRECT') ? { ok: true as const, message: 'redirect' } : Promise.reject(err)));
    const feedSettings = structuredClone(DEFAULT_SETTINGS);
    // a product that the shop and the feed really list, so "gone from the feed" means something
    const [feedItem] = (await buildSkroutzFeed(feedSettings)).items;
    const [prod] = await db.select().from(products).where(eq(products.id, feedItem.productId));
    type Size = typeof variants.$inferSelect;
    const rowOf = (v: Size, over: Record<string, unknown> = {}) => ({
      id: v.id, label: v.label, sku: v.sku, price: (v.priceCents / 100).toFixed(2).replace('.', ','), compareAt: '', stock: v.stock, loadedStock: v.stock, trackStock: v.trackStock,
      availability: v.availability, weightGrams: v.weightGrams, barcode: v.barcode ?? '', mpn: v.mpn ?? '', imageUrl: v.imageUrl ?? '', isActive: v.isActive, priceVerified: v.priceVerified, ...over,
    });
    const newRow = (label: string, sku: string) => ({ label, sku, price: '9,90', compareAt: '', stock: 0, trackStock: false, availability: 'in_stock', weightGrams: 0, barcode: '', mpn: '', imageUrl: '', isActive: true, priceVerified: true });
    const allSizes = () => db.select().from(variants).where(eq(variants.productId, prod.id)).orderBy(asc(variants.sort), asc(variants.id));
    const shownRows = async () => (await allSizes()).filter((v) => !v.archivedAt).map((v) => rowOf(v));
    const sizeBySku = async (sku: string) => (await db.select().from(variants).where(eq(variants.sku, sku)))[0];
    const save = (rows: object[], removed: number[] = []) =>
      runProduct(form({ id: String(prod.id), name: prod.name, isActive: 'on', brandId: String(prod.brandId ?? ''), categoryId: String(prod.categoryId ?? ''), variants: JSON.stringify(rows), removedVariantIds: JSON.stringify(removed) }));
    const feedNow = () => buildSkroutzFeed(feedSettings);

    // two sizes are added through the form: one will get price history, the other none
    const baseline = (await allSizes()).length;
    let saved = await save([...(await shownRows()), newRow('TEST A 1L', 'T-SIZE-A'), newRow('TEST B 2L', 'T-SIZE-B')]);
    const sizeA = await sizeBySku('T-SIZE-A');
    const sizeB = await sizeBySku('T-SIZE-B');
    check('two sizes are added through the form', saved?.ok === true && !!sizeA && !!sizeB && (await allSizes()).length === baseline + 2, saved);
    await db.insert(priceChanges).values({ variantId: sizeA.id, oldCents: 100, newCents: 200, source: 'editor' });

    // a stale form: built now, and a size is added from elsewhere before it is submitted
    const staleRows = await shownRows();
    const [sizeC] = await db.insert(variants).values({ productId: prod.id, sku: 'T-SIZE-C', label: 'TEST C 4L', priceCents: 1990, stock: 5, trackStock: false, isActive: true, priceVerified: true, sort: 50 }).returning();
    saved = await save(staleRows);
    const cAfter = await sizeBySku('T-SIZE-C');
    check('a stale form that lacks a size added later keeps that size, untouched', saved?.ok === true && !!cAfter && cAfter.priceCents === 1990 && cAfter.stock === 5 && cAfter.isActive && !cAfter.archivedAt && cAfter.sort === 50, cAfter);
    check('…and the size added elsewhere is sold and in the feed', (await feedNow()).items.some((i) => i.variantId === sizeC.id));

    // explicit removal: A has price history, B has none
    const beforeRemoval = await shownRows();
    saved = await save(beforeRemoval.filter((r) => r.id !== sizeA.id && r.id !== sizeB.id), [sizeA.id, sizeB.id]);
    const aAfter = (await db.select().from(variants).where(eq(variants.id, sizeA.id)))[0];
    const bAfter = (await db.select().from(variants).where(eq(variants.id, sizeB.id)))[0];
    check('a removed size with price history is hidden, not deleted', saved?.ok === true && !!aAfter && aAfter.isActive === false && aAfter.archivedAt !== null, aAfter);
    check('…its price history survives', (await db.select().from(priceChanges).where(eq(priceChanges.variantId, sizeA.id))).length === 1);
    check('…and its codes are freed for reuse', aAfter?.sku.startsWith('T-SIZE-A~archived-') === true && aAfter.barcode === null && aAfter.mpn === null, aAfter?.sku);
    check('a removed size without any history is deleted', bAfter === undefined);
    check('removing sizes did not touch the one added elsewhere', (await sizeBySku('T-SIZE-C'))?.stock === 5);
    const text = (await db.select({ t: products.searchText }).from(products).where(eq(products.id, prod.id)))[0].t;
    check('the product is no longer found by the hidden size, and still by the kept one', !text.includes(normalizeText('TEST A 1L')) && text.includes(normalizeText('TEST C 4L')), text.slice(-120));

    // a size with only past orders is hidden too
    saved = await save([...(await shownRows()), newRow('TEST D 5L', 'T-SIZE-D')]);
    const sizeD = await sizeBySku('T-SIZE-D');
    await db.insert(orderItems).values({ orderId: createdOrderIds[0], productId: prod.id, variantId: sizeD.id, name: 'x', variantLabel: 'x', sku: 'T-SIZE-D', imageUrl: null, unitPriceCents: 100, quantity: 1, lineTotalCents: 100, weightGrams: 0 });
    saved = await save((await shownRows()).filter((r) => r.id !== sizeD.id), [sizeD.id]);
    const dAfter = (await db.select().from(variants).where(eq(variants.id, sizeD.id)))[0];
    check('a removed size that past orders mention is hidden, not deleted', saved?.ok === true && !!dAfter && dAfter.archivedAt !== null && dAfter.isActive === false, dAfter);

    // hidden means: not orderable, not in the feed, not in the shop
    const cart = await resolveCartLines([{ variantId: sizeA.id, quantity: 1 }]);
    check('a hidden size is refused by the cart', cart.length === 1 && cart[0].issue === 'unavailable' && cart[0].quantity === 0, cart);
    const feed = await feedNow();
    check('a hidden size is missing from the feed and from its diagnostics', !feed.items.some((i) => i.variantId === sizeA.id) && !feed.leftOut.some((i) => i.variantId === sizeA.id));
    const shop = await getProductBySlug(prod.slug);
    check('a hidden size is missing from the product page', !!shop && !shop.variants.some((v) => v.id === sizeA.id) && shop.variants.some((v) => v.id === sizeC.id));
    const priceCsv = await (await import('../src/app/admin/(panel)/prices/export/route')).GET().then((r) => r.text());
    check('a hidden size is missing from the price list export', !priceCsv.includes('T-SIZE-A') && priceCsv.includes('T-SIZE-C'));

    // a stale form that still lists the hidden size cannot bring it back
    saved = await save([...(await shownRows()), rowOf(aAfter, { isActive: true, sku: 'T-SIZE-A' })]);
    const aStill = (await db.select().from(variants).where(eq(variants.id, sizeA.id)))[0];
    check('a stale form cannot reactivate a hidden size', saved?.ok === true && aStill.isActive === false && aStill.archivedAt !== null, aStill);

    // the same code can be used again, also in the very save that removes the old size
    const sizeE0 = await (async () => { await save([...(await shownRows()), newRow('TEST E 1L', 'T-SIZE-E')]); return sizeBySku('T-SIZE-E'); })();
    await db.insert(priceChanges).values({ variantId: sizeE0.id, oldCents: 100, newCents: 300, source: 'editor' });
    saved = await save([...(await shownRows()).filter((r) => r.id !== sizeE0.id), newRow('TEST E 1L', 'T-SIZE-E')], [sizeE0.id]);
    const eNew = await sizeBySku('T-SIZE-E');
    check('a size added in the same save can take over the code of the one removed', saved?.ok === true && !!eNew && eNew.id !== sizeE0.id, saved);
    saved = await save([...(await shownRows()), newRow('TEST A 1L', 'T-SIZE-A')]);
    check('…and a hidden size does not block adding it again later', saved?.ok === true && (await sizeBySku('T-SIZE-A'))?.id !== sizeA.id, saved);

    // an id that belongs to another product, or a broken list, removes nothing
    const [foreign] = await db.select().from(variants).where(ne(variants.productId, prod.id)).limit(1);
    saved = await save(await shownRows(), [foreign.id]);
    check('an id of another product in the removal list is ignored', saved?.ok === true && (await db.select().from(variants).where(and(eq(variants.id, foreign.id), isNull(variants.archivedAt)))).length === 1);
    const garbage = await runProduct(form({ id: String(prod.id), name: prod.name, isActive: 'on', variants: JSON.stringify(await shownRows()), removedVariantIds: 'not json' }));
    check('a broken removal list is refused', garbage?.ok === false, garbage);

    // stock. The size is counted and the page was loaded at 10; an order then took 3
    const sizeOf = async (id: number) => (await db.select().from(variants).where(eq(variants.id, id)))[0];
    const saveOne = (id: number, over: Record<string, unknown>) => sizeOf(id).then((v) => save([rowOf(v, over)]));
    await db.update(variants).set({ trackStock: true, stock: 10 }).where(eq(variants.id, sizeC.id));
    await db.update(variants).set({ stock: 7 }).where(eq(variants.id, sizeC.id));
    await saveOne(sizeC.id, { stock: 12, loadedStock: 10 });
    check('counting stays on: the owner\'s +2 is added to what is there now', (await sizeOf(sizeC.id)).stock === 9, (await sizeOf(sizeC.id)).stock);
    // counting is switched off while an order takes 2 from a page loaded at 9
    await db.update(variants).set({ stock: 7 }).where(eq(variants.id, sizeC.id));
    await saveOne(sizeC.id, { stock: 9, loadedStock: 9, trackStock: false });
    const off = await sizeOf(sizeC.id);
    check('counting switched off keeps the units sold while the page was open', off.trackStock === false && off.stock === 7, off);
    // counting is switched on again: the typed number is a fresh count
    await saveOne(sizeC.id, { stock: 20, loadedStock: 7, trackStock: true });
    const on = await sizeOf(sizeC.id);
    check('counting switched on writes the number typed as the new count', on.trackStock === true && on.stock === 20, on);
    // a saved size without the figure the page was loaded with is not from the current form
    const stale = await sizeOf(sizeC.id).then((v) => save([rowOf(v, { stock: 1, loadedStock: undefined })]));
    check('a saved size without loadedStock is refused, stock untouched', stale?.ok === false && (await sizeOf(sizeC.id)).stock === 20, stale);

    // the quick editors (prices, Skroutz codes) skip a hidden size from a stale page; the rest of the batch still saves
    const { updateCodes, updatePrices } = await import('../src/app/admin/actions');
    const { isValidGtin } = await import('../src/lib/gtin');
    const hiddenA = await sizeOf(sizeA.id);
    const priceRowsBefore = (await db.select().from(priceChanges).where(eq(priceChanges.variantId, sizeA.id))).length;
    const prices = await updatePrices([{ id: sizeA.id, price: '55,00' }, { id: sizeC.id, price: '19,95' }]);
    const hiddenAfterPrice = await sizeOf(sizeA.id);
    check('a stale price edit on a hidden size changes nothing', hiddenAfterPrice.priceCents === hiddenA.priceCents && (await db.select().from(priceChanges).where(eq(priceChanges.variantId, sizeA.id))).length === priceRowsBefore, hiddenAfterPrice.priceCents);
    check('…the rest of the batch is saved, and the message says one row was skipped', prices.ok && (await sizeOf(sizeC.id)).priceCents === 1995 && prices.saved.length === 1 && prices.message.includes('αγνοήθηκε'), prices);
    const code = '4006381333931';
    check('(the barcode used below is a valid EAN-13)', isValidGtin(code));
    const codes = await updateCodes([{ id: sizeA.id, barcode: code, mpn: 'T-MPN-A' }, { id: sizeC.id, barcode: '', mpn: 'T-MPN-C' }]);
    const hiddenAfterCode = await sizeOf(sizeA.id);
    check('a stale barcode write on a hidden size changes nothing', hiddenAfterCode.barcode === null && hiddenAfterCode.mpn === null, hiddenAfterCode);
    check('…the rest of the batch is saved, and the message says one row was skipped', codes.ok && (await sizeOf(sizeC.id)).mpn === 'T-MPN-C' && codes.saved.length === 1 && codes.message.includes('αγνοήθηκε'), codes);
    const readded = await sizeBySku('T-SIZE-A');
    saved = await save([...(await shownRows()).map((r) => (r.id === readded.id ? { ...r, barcode: code } : r))]);
    check('the size added again can take that barcode', saved?.ok === true && (await sizeOf(readded.id)).barcode === code, await sizeOf(readded.id));
    await db.delete(priceChanges).where(eq(priceChanges.variantId, sizeA.id));
  }

  console.log('Bank IBANs');
  {
    const { formatIban, isValidIban, normalizeIban } = await import('../src/lib/iban');
    const GR = 'GR16 0110 1250 0000 0001 2300 695';
    check('a valid Greek IBAN is accepted, with spaces', isValidIban(GR));
    check('…without spaces', isValidIban('GR1601101250000000012300695'));
    check('…with dashes', isValidIban('GR16-0110-1250-0000-0001-2300-695'));
    check('…and in lowercase, normalized to capitals without spaces', isValidIban(GR.toLowerCase()) && normalizeIban(GR.toLowerCase()) === 'GR1601101250000000012300695');
    check('a wrong check digit is refused', !isValidIban('GR16 0110 1250 0000 0001 2300 694') && !isValidIban('GR17 0110 1250 0000 0001 2300 695'));
    check('two digits swapped is refused', !isValidIban('GR16 0110 1250 0000 0001 2300 659'));
    check('a wrong length is refused (one digit dropped, one added)', !isValidIban('GR16 0110 1250 0000 0001 2300 69') && !isValidIban('GR16 0110 1250 0000 0001 2300 6950'));
    check('an unknown country is refused', !isValidIban('XX16 0110 1250 0000 0001 2300 695') && !isValidIban('6R16 0110 1250 0000 0001 2300 695'));
    check('an empty string is not an IBAN', !isValidIban('') && !isValidIban('   '));
    check('IBANs of other euro-area countries are accepted', ['DE89 3704 0044 0532 0130 00', 'LT12 1000 0111 0100 1000', 'BE68 5390 0754 7034', 'CY17 0020 0128 0000 0012 0052 7600', 'NL91 ABNA 0417 1643 00'].every(isValidIban));
    check('formatIban groups in fours', formatIban('GR1601101250000000012300695') === GR && formatIban(GR) === GR);
    check('…and shows an invalid stored value instead of failing', formatIban('abc12') === 'ABC1 2');

    const { saveSettings } = await import('../src/app/admin/actions');
    const { getSettings, saveSettingsGroup } = await import('../src/lib/settings.server');
    const { orderConfirmationMail } = await import('../src/lib/email');
    const { getOrderByNumber } = await import('../src/lib/orders');
    const before = await getSettings();
    const savedCommerce = process.env.COMMERCE_ENABLED;
    delete process.env.COMMERCE_ENABLED;
    const base = { name: 'Oil Center', phone: '2310111111', street: 'Οδός 1', city: 'Θεσσαλονίκη', cod: 'on' };
    const account = (iban: string) => ({ 'bank0-name': 'Τράπεζα Δοκιμής', 'bank0-iban': iban, 'bank0-holder': 'Oil Center' });
    const run = (fields: Record<string, string>) => saveSettings(null, form({ ...base, ...fields }));

    const typed = await run({ ...account('gr16 0110 1250 0000 0001 2300 695') });
    check('a valid IBAN typed with spaces and lowercase is saved', typed?.ok === true, typed);
    check('…and stored normalized: capitals, no spaces', (await getSettings()).payments.bankAccounts[0]?.iban === 'GR1601101250000000012300695', (await getSettings()).payments.bankAccounts);
    const bad = await run({ phone: '2310999999', ...account('GR16 0110 1250 0000 0001 2300 694') });
    const after = await getSettings();
    check('an invalid IBAN is refused with a message that says which account', bad?.ok === false && (bad.message ?? '').includes('Μη έγκυρο IBAN') && (bad.message ?? '').includes('Τραπεζικός λογαριασμός 1') && (bad.message ?? '').includes('Δεν αποθηκεύτηκε τίποτα'), bad);
    check('…and nothing else in the form was saved either', after.shop.phone === '2310111111' && after.payments.bankAccounts[0]?.iban === 'GR1601101250000000012300695', { phone: after.shop.phone, accounts: after.payments.bankAccounts });
    const empty = await run({ bankTransfer: 'on' });
    check('with no account and ordering closed, an empty IBAN is accepted (bank transfer ticked)', empty?.ok === true && (await getSettings()).payments.bankAccounts.length === 0, empty);

    // while ordering is open, bank transfer needs an account a customer can pay into
    const noAccount = await run({ bankTransfer: 'on', ordersEnabled: 'on' });
    check('ordering open + bank transfer on + no IBAN is refused', noAccount?.ok === false && (noAccount.message ?? '').includes('δεν υπάρχει έγκυρο IBAN'), noAccount);
    check('…bank transfer off is accepted', (await run({ ordersEnabled: 'on' }))?.ok === true);
    check('…and with a valid IBAN it is accepted', (await run({ bankTransfer: 'on', ordersEnabled: 'on', ...account(GR) }))?.ok === true);
    process.env.COMMERCE_ENABLED = 'false';
    check('…a website-only deployment (COMMERCE_ENABLED=false) is not blocked by it', (await run({ bankTransfer: 'on', ordersEnabled: 'on' }))?.ok === true);
    if (savedCommerce === undefined) delete process.env.COMMERCE_ENABLED; else process.env.COMMERCE_ENABLED = savedCommerce;

    // customers read the IBAN in groups of four
    await run({ bankTransfer: 'on', ...account(GR) });
    const [anyOrder] = await db.select({ number: orders.number }).from(orders).where(eq(orders.id, createdOrderIds[0]));
    const full = (await getOrderByNumber(anyOrder.number))!;
    const mail = orderConfirmationMail({ ...full, paymentMethod: 'bank_transfer' }, await getSettings());
    check('the confirmation mail shows the IBAN in groups of four', mail.html.includes(GR) && !mail.html.includes('GR1601101250000000012300695'), mail.html.match(/IBAN:[^<]*/)?.[0]);

    for (const group of ['shop', 'storefront', 'payments', 'shipping', 'reviews', 'tax'] as const) await saveSettingsGroup(group, before[group] as never);
  }

  console.log('Login limits (customers and admin)');
  {
    const { customers } = await import('../src/lib/db/schema');
    const { hashPassword } = await import('../src/lib/auth/password');
    const { totpFor, newTotpSecret } = await import('../src/lib/auth/totp');
    const { loginCustomer } = await import('../src/app/(store)/account/actions');
    const { loginAdmin } = await import('../src/app/admin/actions');
    // redirect() throws: a login that succeeds ends in NEXT_REDIRECT, anything else answers with a message
    const attempt = async (ip: string, fn: () => Promise<unknown>) => {
      currentIp = ip;
      try {
        const r = (await fn()) as { ok: boolean; message: string } | null;
        return { redirected: false, message: r?.message ?? '' };
      } catch (err) {
        if (String((err as { digest?: string }).digest ?? '').startsWith('NEXT_REDIRECT')) return { redirected: true, message: '' };
        throw err;
      }
    };
    const WRONG = 'Λάθος e-mail ή κωδικός.';
    const customerLogin = (email: string, password: string) => () => loginCustomer(null, form({ email, password }));
    const adminLogin = (email: string, password: string, totp = '') => () => loginAdmin(null, form({ email, password, totp }));
    const pw = 'σωστός-κωδικός-1';
    await db.insert(customers).values({ email: 'victim@example.com', passwordHash: await hashPassword(pw), firstName: 'Θύμα', lastName: 'Τεστ' });

    // customers: strangers cannot lock an account out
    let wrongOnes = 0;
    for (let i = 1; i <= 15; i++) if ((await attempt(`198.51.100.${i}`, customerLogin('victim@example.com', 'λάθος-κωδικός'))).message === WRONG) wrongOnes++;
    check('15 wrong passwords for one account from 15 different addresses are each simply wrong', wrongOnes === 15, wrongOnes);
    const owner = await attempt('198.51.100.200', customerLogin('victim@example.com', pw));
    check('…and the real owner, from another address, still signs in', owner.redirected, owner);
    for (let i = 0; i < 8; i++) await attempt('198.51.100.201', customerLogin('victim@example.com', 'λάθος-κωδικός'));
    const sameIp = await attempt('198.51.100.201', customerLogin('victim@example.com', pw));
    check('one address that keeps failing is stopped for that account (even with the right password)', !sameIp.redirected && sameIp.message.startsWith('Πολλές αποτυχημένες'), sameIp);
    const otherIp = await attempt('198.51.100.202', customerLogin('victim@example.com', pw));
    check('…while every other address is not affected', otherIp.redirected, otherIp);
    const ghost = await attempt('198.51.100.203', customerLogin('nobody@example.com', 'λάθος-κωδικός'));
    const real = await attempt('198.51.100.204', customerLogin('victim@example.com', 'λάθος-κωδικός'));
    check('an unknown e-mail and a wrong password get the same answer', ghost.message === WRONG && real.message === WRONG, [ghost, real]);

    // the account-wide ceiling: about 50 failures an hour from anywhere, the same answer with or without an account
    await db.insert(customers).values({ email: 'ceiling@example.com', passwordHash: await hashPassword(pw), firstName: 'Όριο', lastName: 'Τεστ' });
    for (let i = 1; i <= 50; i++) {
      await attempt(`192.0.2.${i}`, customerLogin('ceiling@example.com', 'λάθος-κωδικός'));
      await attempt(`192.0.2.${i}`, customerLogin('ghost-ceiling@example.com', 'λάθος-κωδικός'));
    }
    const blockedReal = await attempt('192.0.2.200', customerLogin('ceiling@example.com', pw));
    const blockedGhost = await attempt('192.0.2.201', customerLogin('ghost-ceiling@example.com', pw));
    check('after 50 failures an hour the account is paused, whoever asks', !blockedReal.redirected && blockedReal.message.startsWith('Πολλές αποτυχημένες'), blockedReal);
    check('…and an address that has no account gets the same pause (nothing tells them apart)', blockedGhost.message.startsWith('Πολλές αποτυχημένες'), blockedGhost);

    // admin: the same, and the second factor stays strict
    const adminPw = 'κωδικός-διαχειριστή-9';
    await db.insert(adminUsers).values({ email: 'plain-admin@example.com', name: 'Plain', passwordHash: await hashPassword(adminPw) });
    for (let i = 1; i <= 12; i++) await attempt(`198.18.0.${i}`, adminLogin('plain-admin@example.com', 'λάθος-κωδικός'));
    const adminOwner = await attempt('198.18.0.100', adminLogin('plain-admin@example.com', adminPw));
    check('12 wrong admin passwords from 12 addresses do not lock the owner out', adminOwner.redirected, adminOwner);

    const secret = newTotpSecret();
    const mfaEmail = 'mfa-admin@example.com';
    await db.insert(adminUsers).values({ email: mfaEmail, name: 'Mfa', passwordHash: await hashPassword(adminPw), totpSecret: secret, totpConfirmedAt: new Date() });
    const noCode = await attempt('198.19.0.1', adminLogin(mfaEmail, adminPw));
    check('the right password alone does not sign in: it asks for the code', !noCode.redirected && noCode.message.includes('6ψήφιο'), noCode);
    const wrongPwMfa = await attempt('198.19.0.2', adminLogin(mfaEmail, 'λάθος-κωδικός', totpFor(secret, mfaEmail).generate()));
    check('a right code with a wrong password does not sign in', !wrongPwMfa.redirected && wrongPwMfa.message === WRONG, wrongPwMfa);
    for (let i = 10; i < 20; i++) await attempt(`198.19.0.${i}`, adminLogin(mfaEmail, adminPw, '000000'));
    const lateCode = await attempt('198.19.0.100', adminLogin(mfaEmail, adminPw, totpFor(secret, mfaEmail).generate()));
    check('10 wrong codes from 10 addresses stop further guessing, even with the right code', !lateCode.redirected && lateCode.message.startsWith('Πολλές προσπάθειες με κωδικό'), lateCode);
    const mfaOwner = await attempt('198.19.1.1', adminLogin('plain-admin@example.com', adminPw));
    check('…and that pause belongs to the one account: another admin still signs in', mfaOwner.redirected, mfaOwner);
    // a person who does not know the password cannot trigger the pause on the code
    const secret2 = newTotpSecret();
    const mfa2 = 'mfa-admin2@example.com';
    await db.insert(adminUsers).values({ email: mfa2, name: 'Mfa2', passwordHash: await hashPassword(adminPw), totpSecret: secret2, totpConfirmedAt: new Date() });
    for (let i = 1; i <= 12; i++) await attempt(`198.19.2.${i}`, adminLogin(mfa2, 'λάθος-κωδικός', '000000'));
    const mfa2Owner = await attempt('198.19.2.100', adminLogin(mfa2, adminPw, totpFor(secret2, mfa2).generate()));
    check('wrong passwords (with or without a code) never use up the code budget: the owner signs in', mfa2Owner.redirected, mfa2Owner);

    // the failed-password ceiling (about 50 an hour, any address) applies to admins WITHOUT two-step verification and to unknown
    // addresses, and not to an admin who has it: for them the code (capped separately) is what stops guessing
    const noMfa = 'ceiling-admin@example.com';
    await db.insert(adminUsers).values({ email: noMfa, name: 'NoMfa', passwordHash: await hashPassword(adminPw) });
    for (let i = 1; i <= 50; i++) {
      await attempt(`198.20.1.${i}`, adminLogin(noMfa, 'λάθος-κωδικός'));
      await attempt(`198.20.2.${i}`, adminLogin('ghost-admin@example.com', 'λάθος-κωδικός'));
    }
    const pausedNoMfa = await attempt('198.20.3.1', adminLogin(noMfa, adminPw));
    check('an admin without 2FA is paused after 50 failed passwords an hour, even with the right password', !pausedNoMfa.redirected && pausedNoMfa.message.startsWith('Πολλές προσπάθειες'), pausedNoMfa);
    const pausedGhost = await attempt('198.20.3.2', adminLogin('ghost-admin@example.com', adminPw));
    check('…an address with no account gets the same pause', !pausedGhost.redirected && pausedGhost.message === pausedNoMfa.message.replace(/\d+ λεπτά/, pausedGhost.message.match(/\d+ λεπτά/)?.[0] ?? ''), [pausedGhost, pausedNoMfa]);

    const secret3 = newTotpSecret();
    const mfa3 = 'mfa-admin3@example.com';
    await db.insert(adminUsers).values({ email: mfa3, name: 'Mfa3', passwordHash: await hashPassword(adminPw), totpSecret: secret3, totpConfirmedAt: new Date() });
    for (let i = 1; i <= 55; i++) await attempt(`198.20.4.${i}`, adminLogin(mfa3, 'λάθος-κωδικός'));
    const mfa3Owner = await attempt('198.20.5.1', adminLogin(mfa3, adminPw, totpFor(secret3, mfa3).generate()));
    check('an admin WITH 2FA is not paused by 55 failed passwords from 55 addresses: the owner signs in', mfa3Owner.redirected, mfa3Owner);
    const { sql: sqlTag } = await import('drizzle-orm');
    const { createHash } = await import('node:crypto');
    const counterRows = async (key: string) => Number((await db.all<{ n: number }>(sqlTag`SELECT count(*) AS n FROM rate_limits WHERE "key" = ${createHash('sha256').update(key).digest('hex')}`))[0]?.n ?? 0);
    check('…no password-failure counter is even kept for them (but is for the admin without 2FA)', (await counterRows(`admin-login-fail:account:${mfa3}`)) === 0 && (await counterRows(`admin-login-fail:account:${noMfa}`)) === 1);
    for (let i = 10; i < 20; i++) await attempt(`198.20.6.${i}`, adminLogin(mfa3, adminPw, '000000'));
    const mfa3Late = await attempt('198.20.6.100', adminLogin(mfa3, adminPw, totpFor(secret3, mfa3).generate()));
    check('…and their code is still capped (10 wrong codes pause it), so guessing stays bounded', !mfa3Late.redirected && mfa3Late.message.startsWith('Πολλές προσπάθειες με κωδικό'), mfa3Late);

    await db.delete(adminUsers).where(inArray(adminUsers.email, ['plain-admin@example.com', mfaEmail, mfa2]));
    await db.delete(customers).where(inArray(customers.email, ['victim@example.com', 'ceiling@example.com']));
    currentIp = '203.0.113.1';
    await createSession('admin', admin.id, admin.tokenVersion); // the sign-ins above replaced the session cookie
  }

  console.log('Cleanup');
  for (const code of fixCodes) await db.delete(coupons).where(eq(coupons.code, code));
  for (const name of fixSaleNames) await db.delete(sales).where(eq(sales.name, name));
  for (const id of createdOrderIds) await db.delete(orders).where(eq(orders.id, id));
  await db.delete(unmatchedPayments).where(eq(unmatchedPayments.id, um.id));
  check('the rows of this section are gone', (await db.select().from(orders).where(eq(orders.id, createdOrderIds[0]))).length === 0);
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
