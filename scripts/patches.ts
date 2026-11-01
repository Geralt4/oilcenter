import './env';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { brands, productImages, products, settings, variants } from '../src/lib/db/schema';
import { DEFAULT_SETTINGS, type ShopSettings } from '../src/lib/settings';
import { saveSettingsGroup } from '../src/lib/settings.server';
import { pruneDeadTargets } from '../src/lib/discount-cleanup';
import { applyHazardLabels, applyManufacturerSpecs } from './manufacturer-data';

/**
 * The owner's own details as given on 22.09.2026 — ΑΦΜ, ΓΕΜΗ, ΔΟΥ, the one landline he keeps (the old fax, mobile and
 * e-mail are gone; the new store Gmail follows), and the opening hours confirmed exactly as seeded. Whatever else the
 * settings form holds (address, links, tagline) is kept.
 */
async function pruneDeadTargetsPatch(): Promise<string> {
  const { cleaned, switchedOff } = await pruneDeadTargets();
  return `${cleaned} coupon(s)/sale(s) had dead targets removed, ${switchedOff} switched off`;
}

async function applyShopDetails(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : {}) as Partial<ShopSettings['shop']>;
  const d = DEFAULT_SETTINGS.shop;
  await saveSettingsGroup('shop', {
    ...d,
    ...stored,
    phone: d.phone,
    mobile: '',
    fax: '',
    email: '',
    vatNumber: d.vatNumber,
    taxOffice: d.taxOffice,
    gemi: d.gemi,
    hours: structuredClone(d.hours),
    hoursVerified: true,
  });
  return `ΑΦΜ ${d.vatNumber} · ΓΕΜΗ ${d.gemi} · ΔΟΥ ${d.taxOffice} · phone ${d.phone} only (fax, mobile, e-mail cleared) · hours confirmed`;
}

/**
 * The shop's new Gmail (given on 09.10.2026, question C1). It is the address the site shows — footer, contact page,
 * privacy and returns texts — and where form messages are sent once SMTP is configured. An address the owner has
 * typed into Admin → Ρυθμίσεις in the meantime is kept.
 */
async function applyShopEmail(): Promise<string> {
  const email = 'oilcenterthess@gmail.com';
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : {}) as Partial<ShopSettings['shop']>;
  if (stored.email) return `kept ${stored.email}`;
  await saveSettingsGroup('shop', { ...DEFAULT_SETTINGS.shop, ...stored, email });
  return `shop e-mail set to ${email}`;
}

/**
 * The Facebook link is gone from the site (owner's instruction, 09.10.2026): no button, no setting. This removes the
 * address that older databases still carry inside the stored shop settings.
 */
async function removeFacebookLink(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : null) as Record<string, unknown> | null;
  if (!stored || !('facebookUrl' in stored)) return 'nothing stored';
  const { facebookUrl: _gone, ...rest } = stored;
  await db.update(settings).set({ value: rest }).where(eq(settings.key, 'shop'));
  return 'stored Facebook link removed';
}
import { applySearchKeywords } from './search-keywords';
import { applySkroutzPrices } from './skroutz-prices';

/**
 * The seeded description of the accelerate brand said «Το Oil Center είναι εξουσιοδοτημένος αντιπρόσωπος της accelerate».
 * The owner has not confirmed that yet, so the sentence goes; a description he has rewritten himself is left alone.
 */
async function removeAccelerateClaim(): Promise<string> {
  const claim = ' Το Oil Center είναι εξουσιοδοτημένος αντιπρόσωπος της accelerate.';
  const [brand] = await db.select({ id: brands.id, description: brands.description }).from(brands).where(eq(brands.slug, 'accelerate'));
  if (!brand?.description?.includes(claim)) return 'nothing to change';
  await db.update(brands).set({ description: brand.description.replace(claim, '') }).where(eq(brands.id, brand.id));
  return 'sentence removed from the accelerate brand description';
}

/**
 * Saturday closes at 13:00 from 12.10.2026 (the owner's instruction). Only a stored 14:00 moves; a Saturday set some
 * other way, and every other field of the stored shop settings, is left as it is.
 */
async function saturdayClosesAt13(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : null) as Partial<ShopSettings['shop']> | null;
  const hours = stored?.hours;
  if (!stored || !Array.isArray(hours)) return 'nothing stored';
  if (!hours.some((d) => d.day === 6 && d.close === '14:00')) return 'kept Saturday as the owner set it';
  const moved = hours.map((d) => (d.day === 6 && d.close === '14:00' ? { ...d, close: '13:00' } : d));
  await db.update(settings).set({ value: { ...stored, hours: moved } }).where(eq(settings.key, 'shop'));
  return 'Saturday now closes at 13:00';
}

/**
 * accelerate's authorised dealership and the founding year (1998) were confirmed by the owner on 12.10.2026. The year
 * is written only where none was entered (0 or missing), so a year typed in Ρυθμίσεις is never overwritten.
 */
async function shopSince1998(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : null) as Partial<ShopSettings['shop']> | null;
  if (!stored) return 'nothing stored';
  const setYear = !stored.foundedYear;
  await db.update(settings).set({ value: { ...stored, accelerateDealer: true, ...(setYear && { foundedYear: 1998 }) } }).where(eq(settings.key, 'shop'));
  return `set accelerateDealer to true${setYear ? ' and foundedYear to 1998' : ''}`;
}

/**
 * The shop's Instagram profile (given on 13.10.2026): the link shows in the header strip, the footer and the contact
 * page. A profile the owner has typed into Admin → Ρυθμίσεις in the meantime is kept.
 */
async function applyInstagramLink(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'shop'));
  const stored = (row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value) ? row.value : {}) as Partial<ShopSettings['shop']>;
  if (stored.instagramUrl) return `kept ${stored.instagramUrl}`;
  const instagramUrl = DEFAULT_SETTINGS.shop.instagramUrl;
  await saveSettingsGroup('shop', { ...DEFAULT_SETTINGS.shop, ...stored, instagramUrl });
  return `Instagram link set to ${instagramUrl}`;
}

/**
 * The owner's Toyota photos (5 L and 1 L) were uploaded, but no size pointed at them, so every size showed the main
 * photo (12.10.2026). Each size is linked to the photo of its own label, and only where it has no photo of its own yet.
 */
async function linkToyotaSizePhotos(): Promise<string> {
  const [product] = await db.select({ id: products.id }).from(products).where(eq(products.slug, 'toyota-premium-fuel-economy-5w-30-5l'));
  if (!product) return 'product not found';
  const photos: Record<string, string> = {
    '5L': '/media/products/toyota-premium-fuel-economy-5w-30-5l-affdwsm.webp',
    '1L': '/media/products/toyota-premium-fuel-economy-5w-30-5l-o1uvmze.webp',
  };
  let linked = 0;
  for (const [label, url] of Object.entries(photos)) {
    const [photo] = await db.select({ id: productImages.id }).from(productImages).where(and(eq(productImages.productId, product.id), eq(productImages.url, url)));
    if (!photo) continue;
    const sizes = await db.update(variants).set({ imageUrl: url }).where(and(eq(variants.productId, product.id), eq(variants.label, label), or(isNull(variants.imageUrl), eq(variants.imageUrl, '')))).returning({ id: variants.id });
    linked += sizes.length;
  }
  return `${linked} sizes linked to their photo`;
}

/*
 * One-time DATA patches for existing databases. Runs at start-up after the migrations and the seed (see Dockerfile).
 * The hosted database lives on a volume and is never re-seeded, so this is how a data change rides along with a deploy.
 * Each patch runs exactly once per database: its id is recorded in the settings table under the key "dataPatches".
 * Patches must be safe on a freshly seeded database too (they simply find nothing to do there).
 */

/**
 * `requires`: ids of patches that must have been applied (recorded) first. Several patches work on the same stored value and
 * only give the intended result in the order they are listed (the shop-details patch resets e-mail and opening hours to the
 * seed's, the e-mail and Saturday patches then change them). Since a failing patch no longer stops the boot, a later one
 * must not run ahead of it: a retry of the earlier patch would otherwise undo what the later one did, and the later one is
 * recorded and never runs again. (The search-keywords patch rebuilds every search text from the specs; run before the specs
 * patch, the specs would then be appended behind the keywords instead of sitting in their place, another text than a clean run.)
 */
export type Patch = { id: string; run: () => Promise<string>; requires?: string[] };

export const PATCHES: Patch[] = [
  // Real prices from the shop's Skroutz listing. Never overwrites a price the owner has already confirmed.
  { id: '2026-09-20-skroutz-prices', run: () => applySkroutzPrices({ verbose: false }) },
  // Specifications from the manufacturers' data sheets, only where the product had none.
  { id: '2026-09-22-manufacturer-specs', run: () => applyManufacturerSpecs({ verbose: false }) },
  // Hazard labelling copied from the manufacturers' safety data sheets — unconfirmed, so nothing shows until checked.
  { id: '2026-09-22-hazard-labels', run: () => applyHazardLabels({ verbose: false }) },
  // Business details and contact channels as the owner gave them (questions B1–B5, H1).
  { id: '2026-09-22-shop-details', run: applyShopDetails },
  // The accelerate dealership is no longer stated until the owner confirms it (questions.md T4, Admin → Ρυθμίσεις).
  { id: '2026-10-09-accelerate-claim', run: removeAccelerateClaim },
  // The shop's Gmail: shown on the site and used as the recipient of form messages.
  { id: '2026-10-09-shop-email', run: applyShopEmail, requires: ['2026-09-22-shop-details'] },
  // No Facebook link any more: drop the stored address too.
  { id: '2026-10-09-remove-facebook', run: removeFacebookLink },
  // Search synonyms get their own column; search texts the product editor had stripped of them are rebuilt.
  { id: '2026-10-09-search-keywords', run: applySearchKeywords, requires: ['2026-09-22-manufacturer-specs'] },
  // Saturday closes at 13:00 from 12.10.2026 (the owner's instruction): only a stored 14:00 is moved.
  { id: '2026-10-12-saturday-hours', run: saturdayClosesAt13, requires: ['2026-09-22-shop-details'] },
  // Founded 1998 and accelerate dealer, both confirmed by the owner on 12.10.2026; a founding year already entered is kept.
  { id: '2026-10-12-shop-since-1998', run: shopSince1998, requires: ['2026-09-22-shop-details'] },
  // The owner's Toyota photos go to their own pack sizes: they were uploaded, but no size pointed at them.
  { id: '2026-10-12-toyota-size-photos', run: linkToyotaSizePhotos },
  // The shop's Instagram profile; a link already entered in the admin is kept.
  { id: '2026-10-13-instagram-link', run: applyInstagramLink, requires: ['2026-09-22-shop-details'] },
  // Coupons and sales that kept ids of products/brands/categories deleted before the delete cleanup existed: strip them, and switch
  // off any that end up limited to nothing (they would silently become whole-shop discounts the next time they are saved).
  { id: '2026-10-19-discount-dead-targets', run: pruneDeadTargetsPatch },
];

const KEY = 'dataPatches';

/**
 * Runs the patches that are not recorded yet, one by one. A patch that throws is reported as a WARNING, is NOT recorded (it runs
 * again at the next start) and does not stop the others or the boot: a data patch must never be the reason the shop is down.
 * The cost: patches are not atomic with their record (a patch that half-applied runs again) and a later patch may find the
 * data an earlier, failed one should have prepared, so every patch has to be safe to run twice.
 */
export async function runPatches(list: Patch[], log: Pick<Console, 'log' | 'warn'> = console): Promise<{ applied: string[]; failed: string[]; skipped: string[] }> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const recorded = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
  const pending = list.filter((p) => !recorded.has(p.id));
  const result = { applied: [] as string[], failed: [] as string[], skipped: [] as string[] };
  if (!pending.length) {
    log.log('Data patches: nothing to apply.');
    return result;
  }
  for (const patch of pending) {
    const waiting = (patch.requires ?? []).filter((id) => !recorded.has(id));
    if (waiting.length) {
      log.warn(`[patches] WARNING: ${patch.id} waits for ${waiting.join(', ')}, which is not applied yet; it runs after it, at a later start`);
      result.skipped.push(patch.id);
      continue;
    }
    try {
      const outcome = await patch.run();
      recorded.add(patch.id);
      const value = [...recorded];
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
      log.log(`Data patch ${patch.id}: ${outcome}`);
      result.applied.push(patch.id);
    } catch (err) {
      recorded.delete(patch.id);
      log.warn(`[patches] WARNING: ${patch.id} failed and was not recorded; it runs again at the next start: ${err instanceof Error ? err.message : String(err)}`);
      result.failed.push(patch.id);
    }
  }
  if (result.failed.length) log.warn(`[patches] WARNING: ${result.failed.length} of ${pending.length} data patch(es) failed: ${result.failed.join(', ')}`);
  return result;
}

// run directly (db:patch, the boot chain), not when a test imports runPatches
if (require.main === module) {
  runPatches(PATCHES)
    .then(() => process.exit(0))
    .catch((err) => {
      // only reached when the patch record itself cannot be read: nothing is known, so the boot stops as before
      console.error(err);
      process.exit(1);
    });
}
