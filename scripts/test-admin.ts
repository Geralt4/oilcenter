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
  check('"1.250" is one thousand two hundred and fifty euro, not 1,25', cents('1.250') === 125000, cents('1.250'));
  check('"1.234,56" and "1,234.56" are the same amount', cents('1.234,56') === 123456 && cents('1,234.56') === 123456, [cents('1.234,56'), cents('1,234.56')]);
  check('"0.125" and "12.5" stay decimals', cents('0.125') === 13 && cents('12.5') === 1250, [cents('0.125'), cents('12.5')]);
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
