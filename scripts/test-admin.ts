/*
 * What the owner does in the admin, without a browser. Runs against a throwaway COPY of the local database:
 *   npm run test:admin
 * Covers the mistakes that would change what the public sees: a price list that comes back different from how it
 * left, a price read ten times too small, a product that stops answering to «λαδι» after it is saved.
 */
import { readFileSync, rmSync } from 'node:fs';
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
  const headersPath = require.resolve('next/headers');
  require.cache[headersPath] = {
    id: headersPath, filename: headersPath, loaded: true,
    exports: {
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
  const { asc, eq } = await import('drizzle-orm');
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

  console.log('Cleanup');
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
