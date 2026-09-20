/*
 * Skroutz feed regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:feed
 * Covers what would embarrass the shop on Skroutz: a placeholder price leaking out, a sold-out size listed as
 * available, broken XML (one "&" in a product name is enough), ids that are not unique, a mistyped barcode.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cloneDatabase } from './test-db';

process.env.SITE_URL = 'https://www.oilcenter.gr';
let dir = '';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

/** Minimal well-formedness check: tags balance, and no raw "&" or "<" survives in text. */
function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const text = body.slice(last, m.index);
    if (/<|&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) return `raw markup in text near: ${text.slice(0, 60)}`;
    last = m.index! + m[0].length;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `unbalanced </${m[2]}>`;
    } else if (!m[4]) stack.push(m[2]);
  }
  if (/\S/.test(body.slice(last))) return 'text after the root element';
  return stack.length ? `unclosed <${stack.pop()}>` : null;
}

const products = (xml: string) => [...xml.matchAll(/<product>([\s\S]*?)<\/product>/g)].map((m) => m[1]);
const field = (block: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? null;

async function main() {
  dir = await cloneDatabase('oc-feed-');
  const { and, eq, gt } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  const { products: productsTable, variants } = await import('../src/lib/db/schema');
  const { isValidGtin, normalizeGtin } = await import('../src/lib/gtin');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
  const { buildSkroutzFeed, feedName, getFeedLog, recordFeedFetch } = await import('../src/lib/skroutz-feed');

  const settings = structuredClone(DEFAULT_SETTINGS);

  console.log('Barcodes');
  check('EAN-13 from the Skroutz documentation is valid', isValidGtin('9780471117094'));
  check('another EAN-13 is valid', isValidGtin('4006381333931'));
  check('EAN-8 is valid', isValidGtin('73513537'));
  check('UPC-A (12 digits) is valid', isValidGtin('036000291452'));
  check('spaces and dashes are forgiven', isValidGtin('4 006381-333931') && normalizeGtin('4 006381-333931') === '4006381333931');
  check('one wrong digit is caught', !isValidGtin('4006381333932'));
  check('two swapped digits are caught', !isValidGtin('4003681333931'));
  check('wrong length is refused', !isValidGtin('40063813339') && !isValidGtin('40063813339311') && !isValidGtin(''));
  check('letters are refused', !isValidGtin('40063813ABC31'));

  console.log('Titles');
  check('brand + name + pack', feedName('Castrol', 'MAGNATEC 5W-40 C3', '4L') === 'Castrol MAGNATEC 5W-40 C3 4L');
  check('brand is not repeated', feedName('Mannol', 'Mannol 7904 Chain Cleaner', '400ml') === 'Mannol 7904 Chain Cleaner 400ml');
  check('«Τεμάχιο» is not a pack size', feedName('Bosch', 'Aerotwin A297S', 'Τεμάχιο') === 'Bosch Aerotwin A297S');
  check('a pack already in the name is not repeated', feedName('Pro-Tec', 'Oil Booster 375ml', '375ml') === 'Pro-Tec Oil Booster 375ml');

  console.log('What goes in');
  const all = await db.select({ v: variants, p: productsTable }).from(variants).innerJoin(productsTable, eq(variants.productId, productsTable.id));
  const sellable = all.filter((r) => r.p.isActive && r.v.isActive && r.v.priceVerified && r.v.priceCents > 0 && r.p.brandId && r.p.categoryId && (!r.v.trackStock || r.v.stock > 0));
  const feed = await buildSkroutzFeed(settings, new Date('2026-09-20T11:05:00Z'));
  const blocks = products(feed.xml);
  check('there is something to test with', sellable.length > 10, sellable.length);
  check('every sellable size is listed, and nothing else', feed.items.length === sellable.length && blocks.length === sellable.length, { items: feed.items.length, blocks: blocks.length, sellable: sellable.length });
  check('every size is accounted for (listed or left out with a reason)', feed.items.length + feed.leftOut.length === all.length, { in: feed.items.length, out: feed.leftOut.length, all: all.length });
  const verified = new Set(all.filter((r) => r.v.priceVerified).map((r) => r.v.id));
  check('no unconfirmed price is listed', feed.items.every((i) => verified.has(i.variantId)));
  const byId = new Map(all.map((r) => [r.v.id, r.v]));
  check('prices are the prices in the database', feed.items.every((i) => byId.get(i.variantId)!.priceCents === i.priceCents));

  console.log('The file');
  const problem = wellFormed(feed.xml);
  check('XML is well formed', problem === null, problem);
  const file = path.join(dir, 'feed.xml');
  writeFileSync(file, feed.xml);
  const lint = spawnSync('xmllint', ['--noout', file], { encoding: 'utf8' });
  if (lint.error) console.log('  – xmllint is not installed: skipped the second opinion');
  else check('xmllint agrees', lint.status === 0, lint.stderr.slice(0, 300));
  check('declares UTF-8', feed.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  check('created_at is Athens time in Skroutz format', field(feed.xml, 'created_at') === '2026-09-20 14:05', field(feed.xml, 'created_at'));
  const required = ['id', 'name', 'link', 'image', 'category', 'price_with_vat', 'vat', 'manufacturer', 'mpn', 'availability', 'description', 'quantity'];
  const incomplete = blocks.filter((b) => required.some((t) => !field(b, t)?.trim()));
  check('every product carries every required field', incomplete.length === 0, incomplete.slice(0, 2).map((b) => field(b, 'id')));
  const ids = blocks.map((b) => field(b, 'id'));
  check('ids are unique', new Set(ids).size === ids.length);
  check('prices look like 12.90', blocks.every((b) => /^\d+\.\d{2}$/.test(field(b, 'price_with_vat') ?? '')));
  check('VAT is 24.00', blocks.every((b) => field(b, 'vat') === '24.00'));
  check('links and photos are https on the public domain', blocks.every((b) => field(b, 'link')!.startsWith('https://www.oilcenter.gr/product/') && field(b, 'image')!.startsWith('https://www.oilcenter.gr/')));
  check('field lengths respect the Skroutz limits', blocks.every((b) => field(b, 'id')!.length <= 200 && field(b, 'name')!.length <= 300 && field(b, 'link')!.length <= 1000 && field(b, 'image')!.length <= 400 && field(b, 'category')!.length <= 250 && field(b, 'description')!.length <= 10000));
  check('no HTML in descriptions', blocks.every((b) => !/&lt;\/?[a-z]/i.test(field(b, 'description') ?? '')));
  check('shop talk ("call us") stays out of descriptions', blocks.every((b) => !/καλέστε μας/i.test(field(b, 'description') ?? '')));
  check('the brand is in every title', feed.items.every((i) => i.name.toLowerCase().includes(i.manufacturer.toLowerCase())));
  check('category is a full path', feed.items.some((i) => i.category.includes(' > ')), feed.items[0]?.category);

  const sizesPerProduct = new Map<number, number>();
  for (const r of all) if (r.v.isActive) sizesPerProduct.set(r.p.id, (sizesPerProduct.get(r.p.id) ?? 0) + 1);
  const multi = feed.items.find((i) => (sizesPerProduct.get(i.productId) ?? 0) > 1);
  const single = feed.items.find((i) => (sizesPerProduct.get(i.productId) ?? 0) === 1);
  check('a product with several sizes links to the size it advertises', !multi || multi.link.endsWith(`?v=${multi.variantId}`), multi?.link);
  check('a product with one size has a clean link', !single || !single.link.includes('?'), single?.link);

  console.log('Changes in the shop show up');
  const target = feed.items[0];
  const other = feed.items[1];
  await db.update(variants).set({ priceVerified: false }).where(eq(variants.id, target.variantId));
  let next = await buildSkroutzFeed(settings);
  check('an unconfirmed price takes the size out', !next.items.some((i) => i.variantId === target.variantId) && next.leftOut.some((l) => l.variantId === target.variantId && l.reason === 'price_unconfirmed'));

  await db.update(variants).set({ priceVerified: true, priceCents: 1234, trackStock: true, stock: 0 }).where(eq(variants.id, target.variantId));
  next = await buildSkroutzFeed(settings);
  check('a sold-out size is left out', next.leftOut.some((l) => l.variantId === target.variantId && l.reason === 'out_of_stock'));

  await db.update(variants).set({ stock: 7 }).where(eq(variants.id, target.variantId));
  next = await buildSkroutzFeed(settings);
  const back = next.items.find((i) => i.variantId === target.variantId);
  check('counted stock is declared as it is', back?.quantity === 7, back?.quantity);
  check('a new price is in the very next file', back?.priceCents === 1234 && next.xml.includes('<price_with_vat>12.34</price_with_vat>'));
  check('uncounted stock declares the default quantity', next.items.find((i) => i.variantId === other.variantId)?.quantity === settings.skroutz.defaultQuantity);

  await db.update(variants).set({ barcode: '4006381333931', mpn: 'AB-123' }).where(eq(variants.id, target.variantId));
  await db.update(variants).set({ barcode: '4006381333932' }).where(eq(variants.id, other.variantId));
  next = await buildSkroutzFeed(settings);
  const coded = products(next.xml).find((b) => field(b, 'id') === target.id)!;
  const miscoded = products(next.xml).find((b) => field(b, 'id') === other.id)!;
  check('a valid barcode and the manufacturer code are sent', field(coded, 'ean') === '4006381333931' && field(coded, 'mpn') === 'AB-123');
  check('a barcode with a wrong check digit is never sent', field(miscoded, 'ean') === null && next.items.find((i) => i.variantId === other.variantId)?.invalidEan === '4006381333932');
  check('without a manufacturer code the SKU stands in', field(miscoded, 'mpn') === other.id);

  await db.update(variants).set({ barcode: '4006381333931' }).where(eq(variants.id, other.variantId));
  next = await buildSkroutzFeed(settings);
  check('the same barcode on two sizes is reported', next.duplicateEans.includes('4006381333931'));

  await db.update(productsTable).set({ name: 'Tom & Jerry <b>5W-30</b> "Extra"', description: '<p>Πρώτη παράγραφος</p>\n\nΔεύτερη & τελευταία' }).where(eq(productsTable.id, target.productId));
  next = await buildSkroutzFeed(settings);
  const awkward = products(next.xml).find((b) => field(b, 'id') === target.id)!;
  check('awkward characters are escaped', field(awkward, 'name')!.includes('Tom &amp; Jerry &lt;b&gt;5W-30&lt;/b&gt;'), field(awkward, 'name'));
  check('HTML is stripped from descriptions', field(awkward, 'description') === 'Πρώτη παράγραφος\nΔεύτερη &amp; τελευταία', field(awkward, 'description'));
  check('…and the file is still well formed', wellFormed(next.xml) === null, wellFormed(next.xml));

  await db.update(productsTable).set({ isActive: false }).where(eq(productsTable.id, target.productId));
  next = await buildSkroutzFeed(settings);
  check('a switched-off product is left out', !next.items.some((i) => i.productId === target.productId));

  const odd = structuredClone(settings);
  odd.skroutz.availability = 'Σε 40 μέρες, ίσως';
  next = await buildSkroutzFeed(odd);
  check('an availability phrase Skroutz does not know falls back to a known one', next.items.every((i) => i.availability === 'Διαθέσιμο από 1 έως 3 ημέρες'));

  await db.update(variants).set({ isActive: false }).where(gt(variants.id, 0));
  next = await buildSkroutzFeed(settings);
  check('an empty catalogue still gives a valid file', next.items.length === 0 && wellFormed(next.xml) === null && next.xml.includes('<products>'));
  await db.update(variants).set({ isActive: true }).where(and(gt(variants.id, 0), eq(variants.isActive, false)));

  console.log('Who read it');
  const before = await getFeedLog();
  await recordFeedFetch('Mozilla/5.0 (curious competitor)', 140);
  const afterHuman = await getFeedLog();
  check('an ordinary download is not mistaken for Skroutz', afterHuman.lastAt !== null && afterHuman.lastBotAt === before.lastBotAt && afterHuman.botFetches === before.botFetches);
  await recordFeedFetch('SkroutzBot v1.0', 140);
  const afterBot = await getFeedLog();
  check('a SkroutzBot download is recorded', afterBot.lastBotAt !== null && afterBot.botFetches === before.botFetches + 1 && afterBot.lastItems === 140);
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
