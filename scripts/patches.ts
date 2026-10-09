import './env';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { brands, settings } from '../src/lib/db/schema';
import { DEFAULT_SETTINGS, type ShopSettings } from '../src/lib/settings';
import { saveSettingsGroup } from '../src/lib/settings.server';
import { applyHazardLabels, applyManufacturerSpecs } from './manufacturer-data';

/**
 * The owner's own details as given on 22.09.2026 — ΑΦΜ, ΓΕΜΗ, ΔΟΥ, the one landline he keeps (the old fax, mobile and
 * e-mail are gone; the new store Gmail follows), and the opening hours confirmed exactly as seeded. Whatever else the
 * settings form holds (address, links, tagline) is kept.
 */
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

/*
 * One-time DATA patches for existing databases. Runs at start-up after the migrations and the seed (see Dockerfile).
 * The hosted database lives on a volume and is never re-seeded, so this is how a data change rides along with a deploy.
 * Each patch runs exactly once per database: its id is recorded in the settings table under the key "dataPatches".
 * Patches must be safe on a freshly seeded database too (they simply find nothing to do there).
 */

const PATCHES: Array<{ id: string; run: () => Promise<string> }> = [
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
  { id: '2026-10-09-shop-email', run: applyShopEmail },
  // Search synonyms get their own column; search texts the product editor had stripped of them are rebuilt.
  { id: '2026-10-09-search-keywords', run: applySearchKeywords },
];

const KEY = 'dataPatches';

async function main() {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const applied = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
  const pending = PATCHES.filter((p) => !applied.has(p.id));
  if (!pending.length) {
    console.log('Data patches: nothing to apply.');
    return;
  }
  for (const patch of pending) {
    console.log(`Data patch ${patch.id}: ${await patch.run()}`);
    applied.add(patch.id);
    const value = [...applied];
    await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
