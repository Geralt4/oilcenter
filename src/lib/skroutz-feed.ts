import { asc, eq } from 'drizzle-orm';
import { BASE_TYPE_LABELS } from '@/lib/catalog';
import { db } from '@/lib/db';
import { brands, categories, productImages, products, settings as settingsTable, variants } from '@/lib/db/schema';
import { isValidGtin, normalizeGtin } from '@/lib/gtin';
import { SKROUTZ_AVAILABILITY, type ShopSettings } from '@/lib/settings';
import { siteUrl } from '@/lib/site-url';

/*
 * The product feed skroutz.gr reads — https://developer.skroutz.gr/products/xml_feed (layout of their "Simple XML" example).
 *
 * Once Skroutz has the address of this file it fetches it about every hour (08:00–00:00), so a price saved in
 * Admin → Τιμές reaches Skroutz without anyone typing it a second time.
 *
 *  - One <product> per PACK SIZE. On Skroutz "Castrol Edge 5W-30 1lt" and "…4lt" are different products, and their
 *    <size> field is reserved for clothing, so the pack goes into the name.
 *  - <id> is the SKU: Skroutz requires an id that never changes and is never reused, and the SKU survives a rebuild
 *    of the database, which a row id does not. Renaming a SKU therefore makes Skroutz see a new product.
 *  - Only sizes whose price the owner has confirmed are listed. A placeholder price must never reach Skroutz.
 *  - A size that is sold out is left out of the file; Skroutz then shows it as unavailable until it returns.
 */

export const FEED_PATH = '/feeds/skroutz.xml';
const MAX_EXTRA_IMAGES = 15;

export type FeedExclusion = 'product_inactive' | 'size_inactive' | 'price_unconfirmed' | 'out_of_stock' | 'no_brand' | 'no_category';

export const FEED_EXCLUSION_LABELS: Record<FeedExclusion, string> = {
  price_unconfirmed: 'Η τιμή δεν έχει επιβεβαιωθεί',
  out_of_stock: 'Εξαντλημένο',
  no_brand: 'Λείπει η μάρκα',
  no_category: 'Λείπει η κατηγορία',
  size_inactive: 'Ανενεργή συσκευασία',
  product_inactive: 'Ανενεργό προϊόν',
};

export type FeedItem = {
  variantId: number;
  productId: number;
  /** <id> */
  id: string;
  name: string;
  link: string;
  image: string | null;
  additionalImages: string[];
  category: string;
  priceCents: number;
  manufacturer: string;
  /** the manufacturer's article number; null = not entered yet, and the SKU is sent in its place */
  mpn: string | null;
  /** null = not entered yet, or entered with a wrong check digit (never sent) */
  ean: string | null;
  invalidEan: string | null;
  availability: string;
  quantity: number;
  weightGrams: number;
  description: string;
  specs: Array<[string, string]>;
};

export type FeedLeftOut = { variantId: number; productId: number; sku: string; name: string; reason: FeedExclusion };

export type SkroutzFeed = {
  xml: string;
  createdAt: Date;
  items: FeedItem[];
  leftOut: FeedLeftOut[];
  /** barcodes that appear on more than one size — each pack has its own, so one of them is a typo */
  duplicateEans: string[];
};

// ─── Text helpers ────────────────────────────────────────────────────────────
/** Characters XML 1.0 forbids are dropped; the five that matter are escaped. */
const xml = (s: string) =>
  s
    .replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const xmlAttr = (s: string) => xml(s).replace(/"/g, '&quot;');

/** A paragraph that talks to OUR customer ("…ή καλέστε μας") is shop talk, not product information: it stays on the site. */
const SHOP_TALK = /καλέστε μας|επικοινωνήστε μαζί μας|τηλεφωνήστε/i;

/** Skroutz allows no HTML in any field. Descriptions are plain text today; this keeps it that way if one is ever pasted from a web page. */
function plainText(s: string, max: number): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split(/\s*\n\s*/)
    .filter((paragraph) => paragraph && !SHOP_TALK.test(paragraph))
    .join('\n')
    .trim()
    .slice(0, max);
}

/** "2026-09-20 14:05" in Athens time — the format of Skroutz's <created_at>. */
function athensStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** "Castrol" + "MAGNATEC 5W-40 C3" + "4L" → "Castrol MAGNATEC 5W-40 C3 4L". The brand must be in the title; «Τεμάχιο» says nothing about the pack. */
export function feedName(brand: string, name: string, label: string): string {
  const base = name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
  const size = /^τεμ/i.test(label.trim()) ? '' : label.trim();
  const alreadyThere = size && ` ${base.toLowerCase()} `.includes(` ${size.toLowerCase()} `);
  return (size && !alreadyThere ? `${base} ${size}` : base).slice(0, 300);
}

// ─── Build ───────────────────────────────────────────────────────────────────
export async function buildSkroutzFeed(settings: ShopSettings, now: Date = new Date()): Promise<SkroutzFeed> {
  const [productRows, variantRows, imageRows, brandRows, categoryRows] = await Promise.all([
    db.select().from(products),
    db.select().from(variants).orderBy(asc(variants.productId), asc(variants.sort), asc(variants.volumeMl)),
    db.select().from(productImages).orderBy(asc(productImages.sort), asc(productImages.id)),
    db.select().from(brands),
    db.select().from(categories),
  ]);

  const base = siteUrl();
  const absolute = (url: string) => (/^https?:\/\//i.test(url) ? url : `${base}${url}`);
  const brandById = new Map(brandRows.map((b) => [b.id, b]));
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  const productById = new Map(productRows.map((p) => [p.id, p]));

  const categoryPath = (id: number | null): string => {
    const names: string[] = [];
    for (let c = id ? categoryById.get(id) : undefined, guard = 0; c && guard < 8; c = c.parentId ? categoryById.get(c.parentId) : undefined, guard++) names.unshift(c.name);
    return names.join(' > ').slice(0, 250);
  };

  const imagesByProduct = new Map<number, string[]>();
  for (const img of imageRows) imagesByProduct.set(img.productId, [...(imagesByProduct.get(img.productId) ?? []), img.url]);
  const activeSizes = new Map<number, number>();
  const sizeImages = new Map<number, Set<string>>();
  for (const v of variantRows) {
    if (v.isActive) activeSizes.set(v.productId, (activeSizes.get(v.productId) ?? 0) + 1);
    if (v.imageUrl) sizeImages.set(v.productId, (sizeImages.get(v.productId) ?? new Set()).add(v.imageUrl));
  }

  const availability = (SKROUTZ_AVAILABILITY as readonly string[]).includes(settings.skroutz.availability) ? settings.skroutz.availability : SKROUTZ_AVAILABILITY[1];
  const defaultQuantity = Math.min(10_000_000, Math.max(0, Math.round(settings.skroutz.defaultQuantity)));
  const vat = settings.tax.vatRate.toFixed(2);

  const items: FeedItem[] = [];
  const leftOut: FeedLeftOut[] = [];

  for (const v of variantRows) {
    const p = productById.get(v.productId);
    if (!p) continue;
    const brand = p.brandId ? brandById.get(p.brandId) : undefined;
    const name = feedName(brand?.name ?? '', p.name, v.label).trim();
    const category = categoryPath(p.categoryId);

    const reason: FeedExclusion | null = !p.isActive ? 'product_inactive'
      : !v.isActive ? 'size_inactive'
      : !v.priceVerified || v.priceCents <= 0 ? 'price_unconfirmed'
      : !brand ? 'no_brand'
      : !category ? 'no_category'
      : v.trackStock && v.stock <= 0 ? 'out_of_stock'
      : null;
    if (reason) {
      leftOut.push({ variantId: v.id, productId: p.id, sku: v.sku, name, reason });
      continue;
    }

    const gallery = imagesByProduct.get(p.id) ?? [];
    const main = v.imageUrl ?? gallery[0] ?? null;
    // photos of the OTHER pack sizes would show the wrong bottle: only shots that belong to no particular size are extras
    const extras = gallery.filter((url) => url !== main && !sizeImages.get(p.id)?.has(url)).slice(0, MAX_EXTRA_IMAGES);

    const barcode = v.barcode ? normalizeGtin(v.barcode) : '';
    const specs: Array<[string, string]> = [];
    if (p.viscosity) specs.push(['Ιξώδες SAE', p.viscosity]);
    if (p.baseType) specs.push(['Τύπος', BASE_TYPE_LABELS[p.baseType]]);
    if (p.specs?.length) specs.push(['Προδιαγραφές & εγκρίσεις', p.specs.join(', ').slice(0, 1000)]);
    if (!/^τεμ/i.test(v.label.trim())) specs.push(['Συσκευασία', v.label.trim()]);
    for (const [key, value] of Object.entries(p.attributes ?? {})) if (key.trim() && String(value).trim()) specs.push([key.trim(), String(value).trim()]);

    items.push({
      variantId: v.id,
      productId: p.id,
      id: v.sku,
      name,
      // the page opens on this pack size, so the price Skroutz sees there is the price in this file
      link: `${base}/product/${p.slug}${(activeSizes.get(p.id) ?? 0) > 1 ? `?v=${v.id}` : ''}`,
      image: main ? absolute(main) : null,
      additionalImages: extras.map(absolute),
      category,
      priceCents: v.priceCents,
      manufacturer: brand!.name,
      mpn: v.mpn?.trim() || null,
      ean: barcode && isValidGtin(barcode) ? barcode : null,
      invalidEan: barcode && !isValidGtin(barcode) ? barcode : null,
      availability,
      quantity: v.trackStock ? Math.min(10_000_000, v.stock) : defaultQuantity,
      weightGrams: v.weightGrams,
      description: plainText(p.description || '', 10_000) || plainText(p.shortDescription || '', 10_000) || name,
      specs,
    });
  }

  const seen = new Map<string, number>();
  for (const item of items) if (item.ean) seen.set(item.ean, (seen.get(item.ean) ?? 0) + 1);
  const duplicateEans = [...seen].filter(([, n]) => n > 1).map(([ean]) => ean);

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<mywebstore>', `  <created_at>${athensStamp(now)}</created_at>`, '  <products>'];
  for (const item of items) {
    lines.push('    <product>');
    const tag = (name: string, value: string) => lines.push(`      <${name}>${xml(value)}</${name}>`);
    tag('id', item.id);
    tag('name', item.name);
    tag('link', item.link);
    tag('image', item.image ?? '');
    for (const url of item.additionalImages) tag('additionalimage', url);
    tag('category', item.category);
    tag('price_with_vat', (item.priceCents / 100).toFixed(2));
    tag('vat', vat);
    tag('manufacturer', item.manufacturer);
    tag('mpn', item.mpn ?? item.id);
    if (item.ean) tag('ean', item.ean);
    tag('availability', item.availability);
    if (item.weightGrams > 0) tag('weight', String(item.weightGrams));
    tag('description', item.description);
    tag('quantity', String(item.quantity));
    if (item.specs.length) {
      lines.push('      <specifications>');
      for (const [key, value] of item.specs) lines.push(`        <spec name="${xmlAttr(key)}">${xml(value)}</spec>`);
      lines.push('      </specifications>');
    }
    lines.push('    </product>');
  }
  lines.push('  </products>', '</mywebstore>', '');

  return { xml: lines.join('\n'), createdAt: now, items, leftOut, duplicateEans };
}

// ─── Who read it, and when ───────────────────────────────────────────────────
export type FeedLog = { lastAt: number | null; lastBotAt: number | null; botFetches: number; lastItems: number };

const LOG_KEY = 'skroutzFeedLog';
const EMPTY_LOG: FeedLog = { lastAt: null, lastBotAt: null, botFetches: 0, lastItems: 0 };

export async function getFeedLog(): Promise<FeedLog> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, LOG_KEY));
  return row && typeof row.value === 'object' && row.value !== null ? { ...EMPTY_LOG, ...(row.value as Partial<FeedLog>) } : EMPTY_LOG;
}

/** Skroutz's downloader identifies itself as "SkroutzBot". Anyone can claim that name, so this is a diagnostic, not a gate. */
export async function recordFeedFetch(userAgent: string, itemCount: number): Promise<void> {
  const log = await getFeedLog();
  const isBot = /skroutzbot/i.test(userAgent);
  const now = Date.now();
  const value: FeedLog = { lastAt: now, lastBotAt: isBot ? now : log.lastBotAt, botFetches: log.botFetches + (isBot ? 1 : 0), lastItems: itemCount };
  await db.insert(settingsTable).values({ key: LOG_KEY, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}
