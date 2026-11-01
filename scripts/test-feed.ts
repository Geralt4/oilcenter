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
// There is no built-in session secret (lib/auth/secret.ts): this script signs an admin session, so it brings its own.
process.env.AUTH_SECRET = 'feed-test-only-secret-not-used-anywhere-0123456789';
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
  // The route reads the visitor's address and the admin cookie from next/headers: an in-memory jar and a settable address stand in for a request.
  const cookieJar = new Map<string, string>();
  let currentIp = '198.51.100.1';
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
  const { and, eq, gt } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  const { products: productsTable, settings: settingsTableRef, variants } = await import('../src/lib/db/schema');
  const { isValidGtin, normalizeGtin } = await import('../src/lib/gtin');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
  const { buildSkroutzFeed, FEED_EXCLUSION_LABELS, feedName, getFeedLog, recordFeedFetch } = await import('../src/lib/skroutz-feed');

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
  // Skroutz's validator flags a category without a parent (our top-level «Γράσα») as a partial path
  check('every category is a full path', feed.items.every((i) => i.category.split(' > ').length >= 2), feed.items.find((i) => !i.category.includes(' > '))?.category);

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

  console.log('Availability');
  const third = feed.items[2];
  await db.update(variants).set({ availability: 'days_1_3' }).where(eq(variants.id, other.variantId));
  await db.update(variants).set({ availability: 'on_order' }).where(eq(variants.id, third.variantId));
  next = await buildSkroutzFeed(settings);
  const said = (id: number) => next.items.find((i) => i.variantId === id)?.availability;
  check('on the shelf → the phrase chosen in Admin → Skroutz', said(target.variantId) === 'Διαθέσιμο από 1 έως 3 ημέρες', said(target.variantId));
  check('from the supplier in 1–3 days → «4 έως 6 ημέρες»', said(other.variantId) === 'Διαθέσιμο από 4 έως 6 ημέρες', said(other.variantId));
  check('on order → «7 έως 12 ημέρες»', said(third.variantId) === 'Διαθέσιμο από 7 έως 12 ημέρες', said(third.variantId));
  const sameDay = structuredClone(settings);
  sameDay.skroutz.availability = 'Άμεσα διαθέσιμο';
  next = await buildSkroutzFeed(sameDay);
  check('the owner can declare shelf stock as «Άμεσα διαθέσιμο»', said(target.variantId) === 'Άμεσα διαθέσιμο' && said(other.variantId) === 'Διαθέσιμο από 4 έως 6 ημέρες');
  await db.update(variants).set({ availability: 'unavailable' }).where(eq(variants.id, third.variantId));
  next = await buildSkroutzFeed(settings);
  check('a size marked «Μη διαθέσιμο» is left out', !next.items.some((i) => i.variantId === third.variantId) && next.leftOut.some((l) => l.variantId === third.variantId && l.reason === 'unavailable'));
  await db.update(variants).set({ availability: 'in_stock' }).where(gt(variants.id, 0));

  console.log('Photos');
  {
    const { productImages } = await import('../src/lib/db/schema');
    const { inArray } = await import('drizzle-orm');
    const origin = 'https://www.oilcenter.gr';
    const [donor] = await db.select().from(productsTable).where(eq(productsTable.id, target.productId));
    const mkProduct = async (slug: string) => (await db.insert(productsTable).values({ slug, name: `Δοκιμή φωτογραφίας ${slug}`, searchText: slug, brandId: donor.brandId, categoryId: donor.categoryId, isActive: true }).returning())[0];
    const mkSize = async (productId: number, sku: string, imageUrl: string | null) =>
      (await db.insert(variants).values({ productId, sku, label: sku.slice(-2), priceCents: 1000, priceVerified: true, trackStock: false, availability: 'in_stock', imageUrl, isActive: true }).returning())[0];

    const withGallery = await mkProduct('test-photo-gallery');
    await db.insert(productImages).values([
      { productId: withGallery.id, url: '/media/products/test-gallery.webp', sort: 0 },
      { productId: withGallery.id, url: '/media/products/test-gallery-2.webp', sort: 1 },
    ]);
    const noOwn = await mkSize(withGallery.id, 'TEST-PHOTO-G1', null);
    const blankOwn = await mkSize(withGallery.id, 'TEST-PHOTO-G2', '  ');
    const ownPhoto = await mkSize(withGallery.id, 'TEST-PHOTO-G3', '/catalog/test-own.webp');
    const bare = await mkProduct('test-photo-none');
    const bareSizes = [await mkSize(bare.id, 'TEST-PHOTO-N1', null), await mkSize(bare.id, 'TEST-PHOTO-N2', ''), await mkSize(bare.id, 'TEST-PHOTO-N3', 'http://example.com/x.jpg')];

    const photoFeed = await buildSkroutzFeed(settings);
    const itemOf = (id: number) => photoFeed.items.find((i) => i.variantId === id);
    check('a size without its own photo uses the product\'s first one (/media/ gets the site origin)', itemOf(noOwn.id)?.image === `${origin}/media/products/test-gallery.webp`, itemOf(noOwn.id)?.image);
    check('…and a blank photo field counts as none', itemOf(blankOwn.id)?.image === `${origin}/media/products/test-gallery.webp`, itemOf(blankOwn.id)?.image);
    check('a size with its own photo keeps it (/catalog/ gets the site origin)', itemOf(ownPhoto.id)?.image === `${origin}/catalog/test-own.webp`, itemOf(ownPhoto.id)?.image);
    check('the other gallery photo travels as an extra, never twice', itemOf(noOwn.id)?.additionalImages.join() === `${origin}/media/products/test-gallery-2.webp`, itemOf(noOwn.id)?.additionalImages);
    check('a product with no photos at all is left out entirely', bareSizes.every((s) => !itemOf(s.id)), bareSizes.map((s) => itemOf(s.id)?.image));
    check('…each of its sizes is reported as «Χωρίς φωτογραφία» (the admin page lists these)', bareSizes.every((s) => photoFeed.leftOut.some((l) => l.variantId === s.id && l.reason === 'no_image')) && FEED_EXCLUSION_LABELS.no_image === 'Χωρίς φωτογραφία', photoFeed.leftOut.filter((l) => l.productId === bare.id));
    check('an http:// photo is not sent (the size falls to the next rule, here: no photo)', photoFeed.leftOut.some((l) => l.variantId === bareSizes[2].id && l.reason === 'no_image'));
    const allAfter = await db.select({ id: variants.id }).from(variants);
    check('every size is still accounted for', photoFeed.items.length + photoFeed.leftOut.length === allAfter.length, { in: photoFeed.items.length, out: photoFeed.leftOut.length, all: allAfter.length });

    const images = [...photoFeed.xml.matchAll(/<image>([\s\S]*?)<\/image>/g)].map((m) => m[1]);
    const extraImages = [...photoFeed.xml.matchAll(/<additionalimage>([\s\S]*?)<\/additionalimage>/g)].map((m) => m[1]);
    check('there is one <image> per item', images.length === photoFeed.items.length, { images: images.length, items: photoFeed.items.length });
    check('no <image> is empty', images.every((u) => u.trim() !== ''));
    check('every <image> and <additionalimage> is an absolute https address', [...images, ...extraImages].every((u) => u.startsWith('https://')), [...images, ...extraImages].find((u) => !u.startsWith('https://')));
    check('the file is still well formed', wellFormed(photoFeed.xml) === null && products(photoFeed.xml).length === photoFeed.items.length, wellFormed(photoFeed.xml));
    const photoFile = path.join(dir, 'photos.xml');
    writeFileSync(photoFile, photoFeed.xml);
    const photoLint = spawnSync('xmllint', ['--noout', photoFile], { encoding: 'utf8' });
    if (!photoLint.error) check('xmllint agrees', photoLint.status === 0, photoLint.stderr.slice(0, 300));

    const ids = [withGallery.id, bare.id];
    await db.delete(productImages).where(inArray(productImages.productId, ids));
    await db.delete(variants).where(inArray(variants.productId, ids));
    await db.delete(productsTable).where(inArray(productsTable.id, ids));
  }

  console.log('Codes and awkward text');
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

  console.log('Cache, rate limit and conditional requests');
  {
    const { count, sql } = await import('drizzle-orm');
    const { adminUsers, rateLimits } = await import('../src/lib/db/schema');
    const { hashPassword } = await import('../src/lib/auth/password');
    const { createSession } = await import('../src/lib/auth/session');
    const { saveSettingsGroup, getSettings } = await import('../src/lib/settings.server');
    const { feedCacheLimits, getCachedSkroutzFeed, invalidateSkroutzFeed } = await import('../src/lib/skroutz-feed-cache');
    const { feedLogThrottle } = await import('../src/lib/skroutz-feed');
    const { GET } = await import('../src/app/feeds/skroutz.xml/route');
    const { NextRequest } = await import('next/server');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const rows = async (table: typeof rateLimits) => Number((await db.select({ n: count() }).from(table))[0].n);
    const hit = (o: { ip?: string; ua?: string; inm?: string; query?: string } = {}) => {
      currentIp = o.ip ?? '198.51.100.1';
      const headers: Record<string, string> = {};
      if (o.ua) headers['user-agent'] = o.ua;
      if (o.inm) headers['if-none-match'] = o.inm;
      return GET(new NextRequest(`https://www.oilcenter.gr/feeds/skroutz.xml${o.query ?? ''}`, { headers }));
    };

    await saveSettingsGroup('skroutz', { ...settings.skroutz, feedEnabled: true });
    const current = await getSettings();
    const live = (await buildSkroutzFeed(current)).items[0];
    const setPrice = (cents: number) => db.update(variants).set({ priceCents: cents }).where(eq(variants.id, live.variantId));
    const priceIn = (xml: string) => field(products(xml).find((b) => field(b, 'id') === live.id)!, 'price_with_vat');
    const p0 = live.priceCents;

    // ── the cache, through the route: the database is changed behind its back, so only a rebuild shows it
    feedCacheLimits.ttlMs = 60_000;
    invalidateSkroutzFeed();
    const first = await hit();
    const xml1 = await first.text();
    await setPrice(p0 + 100);
    const second = await hit();
    check('a second anonymous request is answered from memory (a price changed behind it is not rebuilt in)', (await second.text()) === xml1 && priceIn(xml1) === (p0 / 100).toFixed(2));
    check('…with the same ETag', first.headers.get('etag') !== null && first.headers.get('etag') === second.headers.get('etag'), [first.headers.get('etag'), second.headers.get('etag')]);

    // ── an admin always gets a fresh file, and is not limited
    await db.insert(adminUsers).values({ email: 'feed-admin@example.com', name: 'Feed', passwordHash: await hashPassword('feed-admin-pass-1') });
    const [adm] = await db.select().from(adminUsers).where(eq(adminUsers.email, 'feed-admin@example.com'));
    await createSession('admin', adm.id, adm.tokenVersion);
    const limitedBefore = await rows(rateLimits);
    const adminHit = await hit({ ip: '198.51.100.60' });
    check('an admin sees the data as it is now, never the cached copy', priceIn(await adminHit.text()) === ((p0 + 100) / 100).toFixed(2));
    check('…uncached, without an ETag', adminHit.headers.get('cache-control') === 'no-store' && adminHit.headers.get('etag') === null);
    let adminStatuses = 0;
    for (let i = 0; i < 40; i++) if ((await hit({ ip: '198.51.100.60' })).status === 200) adminStatuses++;
    check('an admin is not rate limited (41 requests)', adminStatuses === 40);
    check('…and spends nothing from any limit', (await rows(rateLimits)) === limitedBefore);
    cookieJar.clear();

    // ── time and invalidation
    feedCacheLimits.ttlMs = 40;
    await sleep(80);
    check('after the TTL the next request rebuilds', priceIn(await (await hit()).text()) === ((p0 + 100) / 100).toFixed(2));
    feedCacheLimits.ttlMs = 60_000;
    await setPrice(p0 + 200);
    check('inside the TTL the new price is not there yet', priceIn(await (await hit()).text()) === ((p0 + 100) / 100).toFixed(2));
    invalidateSkroutzFeed();
    check('invalidateSkroutzFeed() makes the next request show the change', priceIn(await (await hit()).text()) === ((p0 + 200) / 100).toFixed(2));

    // ── builds, counted
    let builds = 0;
    const counting: typeof buildSkroutzFeed = async (st, at) => { builds++; return buildSkroutzFeed(st, at); };
    const slow: typeof buildSkroutzFeed = async (st, at) => { builds++; await sleep(80); return buildSkroutzFeed(st, at); };
    invalidateSkroutzFeed();
    await getCachedSkroutzFeed(current, counting);
    await getCachedSkroutzFeed(current, counting);
    check('two quick requests build once', builds === 1, builds);
    feedCacheLimits.ttlMs = 40;
    await sleep(80);
    await getCachedSkroutzFeed(current, counting);
    check('…and one after the TTL builds again', builds === 2, builds);
    feedCacheLimits.ttlMs = 60_000;
    invalidateSkroutzFeed();
    await getCachedSkroutzFeed(current, counting);
    check('…and one after an invalidation too', builds === 3, builds);

    builds = 0;
    invalidateSkroutzFeed();
    const crowd = await Promise.all(Array.from({ length: 8 }, () => getCachedSkroutzFeed(current, slow)));
    check('eight requests during a build share that one build', builds === 1 && new Set(crowd.map((c) => c.etag)).size === 1, builds);

    builds = 0;
    invalidateSkroutzFeed();
    const broken: typeof buildSkroutzFeed = async () => { builds++; throw new Error('database busy'); };
    const failed = await getCachedSkroutzFeed(current, broken).then(() => false, () => true);
    await getCachedSkroutzFeed(current, counting);
    check('a failed build is not remembered: the next request builds again', failed && builds === 2, { failed, builds });

    builds = 0;
    invalidateSkroutzFeed();
    const racing = getCachedSkroutzFeed(current, slow);
    await sleep(20);
    invalidateSkroutzFeed();
    await racing;
    builds = 0;
    await getCachedSkroutzFeed(current, counting);
    check('a build that started before an invalidation is never stored', builds === 1, builds);

    builds = 0;
    invalidateSkroutzFeed();
    await getCachedSkroutzFeed(current, counting);
    const other = structuredClone(current);
    other.skroutz.defaultQuantity += 1;
    await getCachedSkroutzFeed(other, counting);
    check('a change in the Skroutz or VAT settings is never served from the old copy', builds === 2, builds);

    // ── rate limit
    invalidateSkroutzFeed();
    await hit({ ip: '203.0.113.7' }); // warm
    const before = await rows(rateLimits);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await hit({ ip: '203.0.113.50' })).status);
    const over = await hit({ ip: '203.0.113.50' });
    check('30 requests from one address are answered', statuses.slice(0, 30).every((st) => st === 200), statuses);
    check('the 31st gets 429', statuses[30] === 429, statuses[30]);
    const retry = Number(over.headers.get('retry-after'));
    check('…with a Retry-After in seconds, and no file', Number.isInteger(retry) && retry >= 1 && retry <= 600 && over.status === 429 && !(await over.text()).includes('<product>'), over.headers.get('retry-after'));
    check('another address is not affected', (await hit({ ip: '203.0.113.51' })).status === 200);
    check('a visitor costs one rate-limit row, however often they come', (await rows(rateLimits)) === before + 2, { before, after: await rows(rateLimits) });

    // ── conditional requests
    const fresh = await hit({ ip: '203.0.113.70' });
    const etag = fresh.headers.get('etag')!;
    await fresh.text();
    const notModified = await hit({ ip: '203.0.113.70', inm: etag });
    check('a matching If-None-Match gets 304 and no body', notModified.status === 304 && (await notModified.text()) === '' && notModified.headers.get('etag') === etag);
    check('…also as a weak validator inside a list', (await hit({ ip: '203.0.113.70', inm: `"x", W/${etag}` })).status === 304);
    const stale = await hit({ ip: '203.0.113.70', inm: '"old"' });
    check('a stale validator gets the whole file', stale.status === 200 && (await stale.text()).includes('<product>'));
    const download = await hit({ ip: '203.0.113.70', inm: etag, query: '?download=1' });
    check('?download=1 is always a file', download.status === 200 && (download.headers.get('content-disposition') ?? '').startsWith('attachment; filename="skroutz-feed-'));

    // ── the access log: the same single row, written at most once per window and kind
    const logRows = async () => Number((await db.select({ n: count() }).from(settingsTableRef).where(eq(settingsTableRef.key, 'skroutzFeedLog')))[0].n);
    feedLogThrottle.windowMs = 60_000;
    feedLogThrottle.lastBot = 0;
    feedLogThrottle.lastOther = 0;
    await hit({ ip: '203.0.113.80', ua: 'Mozilla/5.0' });
    const l1 = await getFeedLog();
    for (let i = 0; i < 20; i++) await hit({ ip: '203.0.113.80', ua: 'Mozilla/5.0' });
    const l2 = await getFeedLog();
    check('20 more hits do not touch the log', l1.lastAt !== null && l2.lastAt === l1.lastAt, [l1.lastAt, l2.lastAt]);
    await hit({ ip: '203.0.113.80', ua: 'SkroutzBot/1.0' });
    const b1 = await getFeedLog();
    await hit({ ip: '203.0.113.80', ua: 'SkroutzBot/1.0' });
    const b2 = await getFeedLog();
    check('SkroutzBot is recorded at once, once per window', b1.lastBotAt !== null && b1.botFetches === l2.botFetches + 1 && b2.botFetches === b1.botFetches, [l2.botFetches, b1.botFetches, b2.botFetches]);
    feedLogThrottle.windowMs = 40;
    await sleep(80);
    await hit({ ip: '203.0.113.80', ua: 'SkroutzBot/1.0' });
    const b3 = await getFeedLog();
    check('…and again after the window', b3.botFetches === b1.botFetches + 1 && (b3.lastBotAt ?? 0) > (b1.lastBotAt ?? 0), [b1.botFetches, b3.botFetches]);
    check('it is still one row', (await logRows()) === 1);
    feedLogThrottle.windowMs = 2 * 60_000;

    // ── closed
    await saveSettingsGroup('skroutz', { ...settings.skroutz, feedEnabled: false });
    invalidateSkroutzFeed();
    const closedBefore = await rows(rateLimits);
    const closed = await hit({ ip: '203.0.113.90' });
    check('a closed feed is 404 for visitors', closed.status === 404 && !(await closed.text()).includes('<product>'));
    check('…without touching the rate limit', (await rows(rateLimits)) === closedBefore);
    builds = 0;
    await getCachedSkroutzFeed(await getSettings(), counting);
    check('…and without building or caching anything', builds === 1, builds);
    await createSession('admin', adm.id, adm.tokenVersion);
    const adminClosed = await hit({ ip: '203.0.113.90' });
    check('…while an admin still gets the file', adminClosed.status === 200 && (await adminClosed.text()).includes('<product>'));
    cookieJar.clear();
    await saveSettingsGroup('skroutz', { ...settings.skroutz, feedEnabled: true });

    // ── what comes out has not changed
    invalidateSkroutzFeed();
    await setPrice(p0);
    const finalRes = await hit({ ip: '203.0.113.99' });
    const finalXml = await finalRes.text();
    const direct = await buildSkroutzFeed(await getSettings());
    const imgs = [...finalXml.matchAll(/<image>([\s\S]*?)<\/image>/g)].map((m) => m[1]);
    check('the served file is the built one: same items, same content type, well formed', products(finalXml).length === direct.items.length && finalRes.headers.get('content-type') === 'application/xml; charset=utf-8' && wellFormed(finalXml) === null);
    check('…with every <image> an https address and none empty', imgs.length === direct.items.length && imgs.every((u) => u.startsWith('https://') && u.trim() !== ''));

    await db.delete(adminUsers).where(eq(adminUsers.id, adm.id));
    await db.run(sql`DELETE FROM rate_limits`);
    feedCacheLimits.ttlMs = 15 * 60_000;
    feedLogThrottle.windowMs = 2 * 60_000;
    invalidateSkroutzFeed();
  }
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
