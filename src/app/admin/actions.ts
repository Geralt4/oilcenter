'use server';

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { AVAILABILITY, type Availability } from '@/lib/availability';
import { hashPassword, randomToken, verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { adminUsers, brands, categories, contactMessages, coupons, launchSignups, orders, priceChanges, productImages, products, variants, type BaseType, type OrderStatus } from '@/lib/db/schema';
import { orderStatusMail, sendMail } from '@/lib/email';
import { buildHazard } from '@/lib/ghs';
import { isValidGtin, normalizeGtin } from '@/lib/gtin';
import { normalizeProductPhoto } from '@/lib/images';
import { addOrderEvent, cancelOrder, getOrderByNumber, ORDER_STATUS_LABELS } from '@/lib/orders';
import { describePriceImport, MAX_PRICE_CENTS, parseCsv, planPriceImport } from '@/lib/price-csv';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { DEFAULT_SETTINGS, SKROUTZ_AVAILABILITY, type BankAccount, type DayHours, type ShopSettings } from '@/lib/settings';
import { buildSearchText } from '@/lib/search-keywords';
import { getSettings, saveSettingsGroup } from '@/lib/settings.server';
import { parsePriceToCents, parseVolumeMl, slugify } from '@/lib/utils';

/* Every action below starts with requireAdmin(): page-level protection alone would not cover direct action calls. */

export type AdminFormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

const str = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();
const bool = (fd: FormData, key: string) => fd.get(key) === 'on' || fd.get(key) === 'true';
const int = (fd: FormData, key: string, fallback = 0) => {
  const raw = str(fd, key).replace(',', '.');
  // an emptied field means "the default", not zero: Number('') is 0, and a cleared ΦΠΑ box used to save 0 %
  if (!raw) return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : fallback;
};

// ─── Session ─────────────────────────────────────────────────────────────────
export async function loginAdmin(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const email = str(fd, 'email').toLowerCase();
  const password = String(fd.get('password') ?? '');
  const limited = rateLimit(`admin-login:${await clientIp()}`, 6, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά.` };

  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
  const valid = await verifyPassword(password, admin?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!admin || !valid) return { ok: false, message: 'Λάθος e-mail ή κωδικός.' };

  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, admin.id));
  await createSession('admin', admin.id, admin.tokenVersion);
  redirect('/admin');
}

export async function logoutAdmin(): Promise<void> {
  await destroySession('admin');
  redirect('/admin/login');
}

export async function changeAdminPassword(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const next = String(fd.get('newPassword') ?? '');
  if (next.length < 10) return { ok: false, message: 'Ο νέος κωδικός πρέπει να έχει τουλάχιστον 10 χαρακτήρες.' };
  if (next !== String(fd.get('newPasswordRepeat') ?? '')) return { ok: false, message: 'Οι δύο νέοι κωδικοί δεν είναι ίδιοι.' };
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row || !(await verifyPassword(String(fd.get('currentPassword') ?? ''), row.passwordHash))) return { ok: false, message: 'Ο τρέχων κωδικός δεν είναι σωστός.' };
  // Bump the session version so other sessions are signed out; re-issue this one so the admin stays logged in here.
  const nextVersion = row.tokenVersion + 1;
  await db.update(adminUsers).set({ passwordHash: await hashPassword(next), tokenVersion: nextVersion }).where(eq(adminUsers.id, me.id));
  await createSession('admin', me.id, nextVersion);
  return { ok: true, message: 'Ο κωδικός άλλαξε.' };
}

// ─── Orders ──────────────────────────────────────────────────────────────────
const STATUSES = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];

export async function updateOrder(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const admin = await requireAdmin();
  const id = int(fd, 'id');
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return { ok: false, message: 'Η παραγγελία δεν βρέθηκε.' };

  const status = str(fd, 'status') as OrderStatus;
  if (!STATUSES.includes(status)) return { ok: false, message: 'Μη έγκυρη κατάσταση.' };
  const paid = bool(fd, 'paid');
  const notify = bool(fd, 'notify');
  const trackingCarrier = str(fd, 'trackingCarrier') || null;
  const trackingNumber = str(fd, 'trackingNumber') || null;
  const actor = admin.name || admin.email;

  if (status === 'cancelled' && order.status !== 'cancelled') {
    await cancelOrder(id, actor); // restocks
  } else if (status !== order.status) {
    if (order.status === 'cancelled') return { ok: false, message: 'Μια ακυρωμένη παραγγελία δεν επανέρχεται (το απόθεμα έχει ήδη αποδεσμευτεί). Δημιουργήστε νέα.' };
    await db.update(orders).set({ status }).where(eq(orders.id, id));
    await addOrderEvent(id, 'status', `Κατάσταση: ${ORDER_STATUS_LABELS[order.status]} → ${ORDER_STATUS_LABELS[status]}.`, actor);
  }

  if (paid !== (order.paymentStatus === 'paid')) {
    await db.update(orders).set({ paymentStatus: paid ? 'paid' : 'pending', paidAt: paid ? new Date() : null }).where(eq(orders.id, id));
    await addOrderEvent(id, 'payment', paid ? 'Σημειώθηκε ως εξοφλημένη.' : 'Η ένδειξη εξόφλησης αφαιρέθηκε.', actor);
  }

  await db.update(orders).set({ trackingCarrier, trackingNumber, adminNotes: str(fd, 'adminNotes') || null }).where(eq(orders.id, id));
  if (trackingNumber && trackingNumber !== order.trackingNumber) await addOrderEvent(id, 'shipping', `Αριθμός αποστολής: ${trackingNumber}${trackingCarrier ? ` (${trackingCarrier})` : ''}.`, actor);

  if (notify && status !== order.status) {
    const [full, settings] = await Promise.all([getOrderByNumber(order.number), getSettings()]);
    if (full) {
      const sent = await sendMail(orderStatusMail(full, settings));
      await addOrderEvent(id, 'email', sent ? `Στάλθηκε ενημέρωση «${ORDER_STATUS_LABELS[status]}» στο ${order.email}.` : 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ενημέρωσης.', actor);
    }
  }
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: 'Η παραγγελία ενημερώθηκε.' };
}

// ─── Products ────────────────────────────────────────────────────────────────
const VariantInput = z.object({
  id: z.number().int().positive().optional(),
  label: z.string().trim().min(1, 'Κενή συσκευασία').max(40),
  sku: z.string().trim().max(64),
  price: z.string().trim(),
  compareAt: z.string().trim().optional(),
  stock: z.number().int().min(0).max(100000),
  trackStock: z.boolean(),
  availability: z.enum(AVAILABILITY).optional(),
  weightGrams: z.number().int().min(0).max(100000),
  barcode: z.string().trim().max(32).optional(),
  mpn: z.string().trim().max(80).optional(),
  imageUrl: z.string().trim().max(300).optional(),
  isActive: z.boolean(),
  priceVerified: z.boolean(),
});

async function uniqueSlug(base: string, ignoreId?: number): Promise<string> {
  let slug = base || `product-${randomToken(4).toLowerCase()}`;
  for (let i = 2; ; i++) {
    const [hit] = await db.select({ id: products.id }).from(products).where(and(eq(products.slug, slug), ne(products.id, ignoreId ?? -1)));
    if (!hit) return slug;
    slug = `${base}-${i}`;
  }
}

const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/**
 * Photos for a product. Every file is decoded BEFORE anything is written: one photo that cannot be read refuses the
 * whole save with a message naming it, instead of crashing the editor or being dropped without a word.
 */
async function storeUploads(files: File[], slug: string): Promise<{ urls: string[] } | { error: string }> {
  const chosen = files.filter((f) => f.size > 0);
  if (chosen.length > MAX_PHOTOS) return { error: `Έως ${MAX_PHOTOS} φωτογραφίες τη φορά (επιλέξατε ${chosen.length}).` };
  const encoded: Buffer[] = [];
  for (const file of chosen) {
    if (file.size > MAX_PHOTO_BYTES) return { error: `Η φωτογραφία «${file.name}» ξεπερνά τα 20 MB.` };
    try {
      // Re-encoding through sharp both normalises the photo and guarantees the stored bytes really are an image.
      encoded.push((await normalizeProductPhoto(Buffer.from(await file.arrayBuffer()))).data);
    } catch {
      return { error: `Η φωτογραφία «${file.name}» δεν διαβάζεται. Ανεβάστε την ως JPG ή PNG (τα αρχεία HEIC του iPhone δεν υποστηρίζονται).` };
    }
  }
  const dir = path.resolve(process.env.DATA_DIR || './data', 'uploads', 'products');
  await mkdir(dir, { recursive: true });
  const urls: string[] = [];
  for (const data of encoded) {
    const name = `${slug.slice(0, 60)}-${randomToken(5).toLowerCase()}.webp`;
    await writeFile(path.join(dir, name), data);
    urls.push(`/media/products/${name}`);
  }
  return { urls };
}

/** drizzle wraps the driver's error: SQLite's own message («UNIQUE constraint failed: variants.sku») sits on `.cause` */
function isUniqueViolation(err: unknown, column: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const text = e instanceof Error ? e.message : String(e);
    if (text.includes('UNIQUE') && text.includes(column)) return true;
  }
  return false;
}

/** A safety data sheet. Stored only if it really is a PDF (by signature, not by what the browser claims) and of a sane size. */
async function storeSds(file: File, slug: string): Promise<string | { error: string }> {
  if (file.size > 10 * 1024 * 1024) return { error: 'Το δελτίο δεδομένων ασφαλείας ξεπερνά τα 10 MB.' };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'Το δελτίο δεδομένων ασφαλείας πρέπει να είναι αρχείο PDF.' };
  const dir = path.resolve(process.env.DATA_DIR || './data', 'uploads', 'sds');
  await mkdir(dir, { recursive: true });
  const name = `${slug.slice(0, 60)}-sds-${randomToken(5).toLowerCase()}.pdf`;
  await writeFile(path.join(dir, name), bytes);
  return `/media/sds/${name}`;
}

export async function saveProduct(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (name.length < 2) return { ok: false, message: 'Συμπληρώστε ονομασία.', fieldErrors: { name: 'Υποχρεωτικό πεδίο' } };

  let variantRows: z.infer<typeof VariantInput>[];
  try {
    variantRows = z.array(VariantInput).min(1, 'Χρειάζεται τουλάχιστον μία συσκευασία').max(30).parse(JSON.parse(str(fd, 'variants') || '[]'));
  } catch (err) {
    return { ok: false, message: err instanceof z.ZodError ? (err.issues[0]?.message ?? 'Μη έγκυρες συσκευασίες') : 'Μη έγκυρες συσκευασίες.' };
  }
  const priced = variantRows.map((v) => ({ ...v, priceCents: parsePriceToCents(v.price), compareAtCents: v.compareAt ? parsePriceToCents(v.compareAt) : null }));
  if (priced.some((v) => v.priceCents === null || v.priceCents <= 0)) return { ok: false, message: 'Κάθε συσκευασία χρειάζεται έγκυρη τιμή (π.χ. 12,90).' };
  const badBarcode = priced.find((v) => v.barcode && !isValidGtin(v.barcode));
  if (badBarcode) return { ok: false, message: `Το barcode «${badBarcode.barcode}» (${badBarcode.label}) δεν είναι έγκυρο: χρειάζονται 8, 12 ή 13 ψηφία — πιθανότατα ένα ψηφίο είναι λάθος.` };

  const brandId = int(fd, 'brandId') || null;
  const categoryId = int(fd, 'categoryId') || null;
  const [brand] = brandId ? await db.select().from(brands).where(eq(brands.id, brandId)) : [];
  const [category] = categoryId ? await db.select().from(categories).where(eq(categories.id, categoryId)) : [];

  const slug = await uniqueSlug(slugify(str(fd, 'slug') || (name.toLowerCase().startsWith((brand?.name ?? '\u0000').toLowerCase()) ? name : `${brand?.name ?? ''} ${name}`)), id ?? undefined);
  // the grade becomes an address (/viscosity/5w-30): «SAE 30» is stored as 30, and «80W/90» would be a broken link
  const viscosity = str(fd, 'viscosity').toUpperCase().replace(/\s/g, '').replace(/^SAE(?=\d)/, '') || null;
  if (viscosity && !/^[0-9A-Z][0-9A-Z.-]{0,15}$/.test(viscosity)) return { ok: false, message: `Το ιξώδες «${viscosity}» γράφεται με γράμματα, αριθμούς και παύλα: 5W-30, 75W-90, 46.`, fieldErrors: { viscosity: 'Π.χ. 5W-30' } };
  const specs = str(fd, 'specs').split(/\n|;/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
  const baseType = (['synthetic', 'synthetic-technology', 'semi-synthetic', 'mineral'] as const).find((b) => b === str(fd, 'baseType')) ?? null;

  const values = {
    slug, name, brandId, categoryId, viscosity, baseType: baseType as BaseType | null, specs,
    shortDescription: str(fd, 'shortDescription') || null,
    description: String(fd.get('description') ?? '').trim() || null,
    isActive: bool(fd, 'isActive'),
    isFeatured: bool(fd, 'isFeatured'),
    metaTitle: str(fd, 'metaTitle') || null,
    metaDescription: str(fd, 'metaDescription') || null,
    internalNotes: String(fd.get('internalNotes') ?? '').trim() || null,
    keywords: str(fd, 'keywords').slice(0, 400),
    searchText: buildSearchText({ brand: brand?.name, name, viscosity, specs, category: category?.name, keywords: str(fd, 'keywords').slice(0, 400), labels: priced.map((v) => v.label) }),
  };

  // Hazard labelling & safety data sheet (lib/ghs.ts). A newly uploaded PDF replaces whatever link was there.
  const sdsFile = fd.get('sds');
  const sdsUpload = sdsFile instanceof File && sdsFile.size > 0 ? await storeSds(sdsFile, slug) : null;
  if (sdsUpload && typeof sdsUpload !== 'string') return { ok: false, message: sdsUpload.error };
  const sdsLink = str(fd, 'sdsUrl');
  if (sdsLink && !sdsLink.startsWith('/media/sds/') && !/^https:\/\/[^\s]+$/i.test(sdsLink)) {
    if (sdsUpload) await removeUpload(sdsUpload);
    return { ok: false, message: 'Ο σύνδεσμος του δελτίου δεδομένων ασφαλείας πρέπει να ξεκινά με https://' };
  }
  const hazard = buildHazard({
    none: bool(fd, 'hazardNone'), confirmed: bool(fd, 'hazardConfirmed'), signalWord: str(fd, 'hazardSignal'), pictograms: fd.getAll('hazardPictograms').map(String),
    statements: String(fd.get('hazardStatements') ?? ''), precautions: String(fd.get('hazardPrecautions') ?? ''), sdsUrl: sdsUpload ?? sdsLink,
  });
  const [previous] = id ? await db.select({ hazard: products.hazard }).from(products).where(eq(products.id, id)) : [];

  const stored = await storeUploads(fd.getAll('images').filter((f): f is File => f instanceof File), slug);
  if ('error' in stored) {
    if (sdsUpload) await removeUpload(sdsUpload);
    return { ok: false, message: stored.error };
  }
  const uploads = stored.urls;
  // files written for a save that then fails must not stay behind
  const discardUploads = async () => {
    for (const url of uploads) await removeUpload(url);
    if (sdsUpload) await removeUpload(sdsUpload);
  };

  // a size without a code gets one from the product and its label; two sizes must never end up with the same one
  const taken = new Set(priced.map((v) => v.sku.toUpperCase()).filter(Boolean));
  const skus = priced.map((v) => {
    if (v.sku) return v.sku;
    const base = `${slug}-${slugify(v.label)}`.toUpperCase().slice(0, 60);
    let sku = base;
    for (let n = 2; taken.has(sku); n++) sku = `${base.slice(0, 56)}-${n}`;
    taken.add(sku);
    return sku;
  });

  const productId = await db.transaction(async (tx) => {
    let pid = id;
    if (pid) await tx.update(products).set({ ...values, hazard }).where(eq(products.id, pid));
    else pid = (await tx.insert(products).values({ ...values, hazard }).returning({ id: products.id }))[0].id;

    const keep = priced.flatMap((v) => (v.id ? [v.id] : []));
    // a size may only point at one of this product's own photos
    const ownImages = new Set([...(await tx.select({ url: productImages.url }).from(productImages).where(eq(productImages.productId, pid))).map((i) => i.url), ...uploads]);
    const before = new Map((await tx.select({ id: variants.id, priceCents: variants.priceCents }).from(variants).where(eq(variants.productId, pid))).map((v) => [v.id, v.priceCents]));
    await tx.delete(variants).where(keep.length ? and(eq(variants.productId, pid), notInArray(variants.id, keep)) : eq(variants.productId, pid));

    for (const [sort, v] of priced.entries()) {
      const row = {
        productId: pid, label: v.label, volumeMl: /\d\s*g$/i.test(v.label) ? null : parseVolumeMl(v.label), priceCents: v.priceCents!, compareAtCents: v.compareAtCents,
        stock: v.stock, trackStock: v.trackStock, availability: v.availability ?? 'in_stock', weightGrams: v.weightGrams, barcode: v.barcode ? normalizeGtin(v.barcode) : null, mpn: v.mpn || null, imageUrl: v.imageUrl && ownImages.has(v.imageUrl) ? v.imageUrl : null, isActive: v.isActive, priceVerified: v.priceVerified, sort,
        sku: skus[sort],
      };
      if (v.id) await tx.update(variants).set(row).where(and(eq(variants.id, v.id), eq(variants.productId, pid)));
      else await tx.insert(variants).values(row);
      const was = v.id ? before.get(v.id) : undefined;
      if (v.id && was !== undefined && was !== row.priceCents) await tx.insert(priceChanges).values({ variantId: v.id, oldCents: was, newCents: row.priceCents, source: 'product' });
    }

    if (uploads.length) {
      const existing = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, pid));
      await tx.insert(productImages).values(uploads.map((url, i) => ({ productId: pid!, url, alt: name, sort: existing.length + i })));
    }
    return pid;
  }).catch(async (err: unknown) => {
    await discardUploads();
    if (isUniqueViolation(err, 'sku')) return null;
    throw err;
  });

  if (productId === null) return { ok: false, message: 'Κάποιος κωδικός (SKU) χρησιμοποιείται ήδη — σε άλλο προϊόν ή δύο φορές εδώ.' };
  // the data sheet that was replaced or removed is no longer linked from anywhere
  if (previous?.hazard?.sdsUrl && previous.hazard.sdsUrl !== hazard?.sdsUrl) await removeUpload(previous.hazard.sdsUrl);
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${productId}`);
  if (!id) redirect(`/admin/products/${productId}?created=1`);
  return { ok: true, message: 'Το προϊόν αποθηκεύτηκε.' };
}

export async function deleteProduct(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  const images = await db.select().from(productImages).where(eq(productImages.productId, id));
  const [row] = await db.select({ hazard: products.hazard }).from(products).where(eq(products.id, id));
  await db.transaction(async (tx) => {
    await tx.delete(variants).where(eq(variants.productId, id));
    await tx.delete(productImages).where(eq(productImages.productId, id));
    await tx.delete(products).where(eq(products.id, id));
  });
  await Promise.all([...images.map((i) => i.url), ...(row?.hazard?.sdsUrl ? [row.hazard.sdsUrl] : [])].map(removeUpload));
  redirect('/admin/products?deleted=1');
}

async function removeUpload(url: string) {
  if (!url.startsWith('/media/')) return; // seeded images in /public/catalog are part of the repo
  const root = path.resolve(process.env.DATA_DIR || './data', 'uploads');
  const file = path.resolve(root, url.slice('/media/'.length));
  if (file.startsWith(root + path.sep)) await unlink(file).catch(() => undefined);
}

export async function imageAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const imageId = int(fd, 'imageId');
  const op = str(fd, 'op');
  const [image] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!image) return;
  if (op === 'delete') {
    await db.delete(productImages).where(eq(productImages.id, imageId));
    await db.update(variants).set({ imageUrl: null }).where(and(eq(variants.productId, image.productId), eq(variants.imageUrl, image.url)));
    await removeUpload(image.url);
  } else if (op === 'primary') {
    const all = await db.select().from(productImages).where(eq(productImages.productId, image.productId));
    const ordered = [image, ...all.filter((i) => i.id !== imageId).sort((a, b) => a.sort - b.sort)];
    for (const [sort, img] of ordered.entries()) await db.update(productImages).set({ sort }).where(eq(productImages.id, img.id));
  }
  revalidatePath(`/admin/products/${image.productId}`);
}

// ─── Bulk prices ─────────────────────────────────────────────────────────────
export type PriceUpdate = { id: number; price: string; verified?: boolean; availability?: Availability };
export type PriceUpdateResult = {
  ok: boolean;
  message: string;
  /** rows as they now stand in the database, so the editor can reset its baseline */
  saved: Array<{ id: number; priceCents: number; previousCents: number | null; changedAt: number | null; verified: boolean; availability: Availability }>;
  /** ids whose price could not be read (left untouched) */
  failed: number[];
};

const PriceUpdates = z.array(z.object({ id: z.number().int().positive(), price: z.string().trim().max(20), verified: z.boolean().optional(), availability: z.enum(AVAILABILITY).optional() })).min(1).max(2000);

/** The quick price editor sends only the rows the owner touched. Every real change is logged in price_changes. */
export async function updatePrices(input: PriceUpdate[]): Promise<PriceUpdateResult> {
  await requireAdmin();
  const parsed = PriceUpdates.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Δεν υπάρχουν αλλαγές προς αποθήκευση.', saved: [], failed: [] };

  const wanted = new Map(parsed.data.map((u) => [u.id, u]));
  const rows = await db.select().from(variants).where(inArray(variants.id, [...wanted.keys()]));
  const saved: PriceUpdateResult['saved'] = [];
  const failed: number[] = [];
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const v of rows) {
      const update = wanted.get(v.id)!;
      const cents = parsePriceToCents(update.price);
      if (cents === null || cents <= 0 || cents > MAX_PRICE_CENTS) {
        failed.push(v.id);
        continue;
      }
      // availability travels with the price because this is the screen the owner lives in: "ran out of the 4 L" is one click here
      const availability = update.availability ?? v.availability;
      if (cents !== v.priceCents) {
        // typing a new price is itself a confirmation
        await tx.update(variants).set({ priceCents: cents, priceVerified: true, availability }).where(eq(variants.id, v.id));
        await tx.insert(priceChanges).values({ variantId: v.id, oldCents: v.priceCents, newCents: cents, source: 'editor', createdAt: now });
        saved.push({ id: v.id, priceCents: cents, previousCents: v.priceCents, changedAt: now.getTime(), verified: true, availability });
      } else if ((update.verified !== undefined && update.verified !== v.priceVerified) || availability !== v.availability) {
        const verified = update.verified ?? v.priceVerified;
        await tx.update(variants).set({ priceVerified: verified, availability }).where(eq(variants.id, v.id));
        saved.push({ id: v.id, priceCents: cents, previousCents: null, changedAt: null, verified, availability });
      }
    }
  });

  revalidatePath('/admin/prices');
  const count = saved.length === 1 ? 'Αποθηκεύτηκε 1 αλλαγή' : `Αποθηκεύτηκαν ${saved.length} αλλαγές`;
  if (failed.length) return { ok: false, message: `${count}. ${failed.length === 1 ? 'Μία τιμή δεν είναι έγκυρη' : `${failed.length} τιμές δεν είναι έγκυρες`} (σημειωμένες με κόκκινο).`, saved, failed };
  return { ok: true, message: saved.length ? `${count}. ${saved.length === 1 ? 'Ισχύει' : 'Ισχύουν'} ήδη στο κατάστημα.` : 'Καμία αλλαγή.', saved, failed };
}

/**
 * CSV columns: sku;price[;stock][;verified][;availability] — separator ; or , — decimal comma or point (lib/price-csv.ts).
 * Unknown SKUs are reported, never created. An empty cell changes nothing: the file that was just exported can be uploaded as it is.
 */
export async function importPricesCsv(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const file = fd.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Επιλέξτε αρχείο CSV.' };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: 'Το αρχείο είναι πολύ μεγάλο.' };

  const rows = await db.select({ id: variants.id, sku: variants.sku, priceCents: variants.priceCents, priceVerified: variants.priceVerified, stock: variants.stock, trackStock: variants.trackStock, availability: variants.availability }).from(variants);
  const plan = planPriceImport(await file.text(), new Map(rows.map(({ sku, ...v }) => [sku, v])));
  if (plan.error !== undefined) return { ok: false, message: plan.error };

  // all or nothing: half a price list is worse than none
  await db.transaction(async (tx) => {
    for (const change of plan.changes) {
      await tx.update(variants).set(change.patch).where(eq(variants.id, change.id));
      if (change.patch.priceCents !== undefined) await tx.insert(priceChanges).values({ variantId: change.id, oldCents: change.oldCents, newCents: change.newCents, source: 'csv' });
    }
  });
  revalidatePath('/admin/prices');
  return { ok: plan.unknown.length + plan.skipped.length === 0, message: describePriceImport(plan) };
}

// ─── Brands, categories, coupons, messages ───────────────────────────────────
export async function saveBrand(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (!name) return { ok: false, message: 'Συμπληρώστε όνομα.' };
  const values = { name, slug: slugify(str(fd, 'slug') || name), country: str(fd, 'country') || null, description: str(fd, 'description') || null, isFeatured: bool(fd, 'isFeatured'), sort: int(fd, 'sort') };
  try {
    if (id) await db.update(brands).set(values).where(eq(brands.id, id));
    else await db.insert(brands).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη μάρκα με αυτό το slug.' };
  }
  revalidatePath('/admin/brands');
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function saveCategory(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (!name) return { ok: false, message: 'Συμπληρώστε όνομα.' };
  const parentId = int(fd, 'parentId') || null;
  if (id && parentId === id) return { ok: false, message: 'Μια κατηγορία δεν μπορεί να είναι γονέας του εαυτού της.' };
  const values = { name, slug: slugify(str(fd, 'slug') || name), parentId, icon: str(fd, 'icon') || null, description: str(fd, 'description') || null, isActive: bool(fd, 'isActive'), sort: int(fd, 'sort') };
  try {
    if (id) await db.update(categories).set(values).where(eq(categories.id, id));
    else await db.insert(categories).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη κατηγορία με αυτό το slug.' };
  }
  revalidatePath('/admin/categories');
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function deleteTaxon(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (str(fd, 'kind') === 'brand') {
    await db.update(products).set({ brandId: null }).where(eq(products.brandId, id));
    await db.delete(brands).where(eq(brands.id, id));
    revalidatePath('/admin/brands');
  } else {
    await db.update(products).set({ categoryId: null }).where(eq(products.categoryId, id));
    await db.update(categories).set({ parentId: null }).where(eq(categories.parentId, id));
    await db.delete(categories).where(eq(categories.id, id));
    revalidatePath('/admin/categories');
  }
}

export async function saveCoupon(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const code = str(fd, 'code').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = (['percent', 'fixed', 'free_shipping'] as const).find((t) => t === str(fd, 'type'));
  if (code.length < 3 || !type) return { ok: false, message: 'Συμπληρώστε κωδικό (τουλάχιστον 3 χαρακτήρες) και τύπο.' };
  const value = type === 'percent' ? Math.min(100, Math.max(1, int(fd, 'value'))) : type === 'fixed' ? (parsePriceToCents(str(fd, 'value')) ?? 0) : 0;
  if (type !== 'free_shipping' && value <= 0) return { ok: false, message: 'Συμπληρώστε αξία έκπτωσης.' };
  const date = (key: string) => (str(fd, key) ? new Date(`${str(fd, key)}T00:00:00`) : null);
  const values = { code, type, value, minSubtotalCents: parsePriceToCents(str(fd, 'minSubtotal')) ?? 0, maxUses: str(fd, 'maxUses') ? int(fd, 'maxUses') : null, startsAt: date('startsAt'), endsAt: date('endsAt'), isActive: bool(fd, 'isActive') };
  try {
    if (id) await db.update(coupons).set(values).where(eq(coupons.id, id));
    else await db.insert(coupons).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη κουπόνι με αυτόν τον κωδικό.' };
  }
  revalidatePath('/admin/coupons');
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function deleteCoupon(fd: FormData): Promise<void> {
  await requireAdmin();
  await db.delete(coupons).where(eq(coupons.id, int(fd, 'id')));
  revalidatePath('/admin/coupons');
}

export async function messageAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (str(fd, 'op') === 'delete') await db.delete(contactMessages).where(eq(contactMessages.id, id));
  else await db.update(contactMessages).set({ isRead: str(fd, 'op') === 'read' }).where(eq(contactMessages.id, id));
  revalidatePath('/admin/messages');
}

/** A visitor who asked for the "orders are open" e-mail wants off the list (their right under GDPR). */
export async function deleteSignup(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (id) await db.delete(launchSignups).where(eq(launchSignups.id, id));
  revalidatePath('/admin/stats');
}

// ─── Settings ────────────────────────────────────────────────────────────────
const TIME =/^([01]\d|2[0-3]):[0-5]\d$/;

/** Links pasted by the owner end up in <a href>: accept http(s) only, and forgive a missing "https://". */
function cleanUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.includes('.') ? url.toString() : '';
  } catch {
    return '';
  }
}

/** Owners often type "@handle" instead of the profile link. */
function instagramUrl(raw: string): string {
  const handle = /^@?([a-z0-9._]{1,30})$/i.exec(raw)?.[1];
  return cleanUrl(handle && !/instagram\.com/i.test(raw) ? `https://www.instagram.com/${handle}/` : raw);
}

export async function saveSettings(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const current = await getSettings();
  // Whatever cannot be saved as typed is refused with a reason (the form keeps what was typed) — never quietly turned
  // into "closed", zero or an empty link while the screen says «αποθηκεύτηκαν».
  const problems: string[] = [];
  const euro = (key: string, fallback: number, label: string) => {
    const raw = str(fd, key);
    if (!raw) return fallback;
    const cents = parsePriceToCents(raw);
    if (cents === null) problems.push(`${label}: «${raw}» δεν είναι ποσό`);
    return cents ?? fallback;
  };
  const num = (key: string, fallback: number) => {
    const raw = str(fd, key).replace(',', '.');
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const link = (key: string, label: string, clean: (raw: string) => string = cleanUrl) => {
    const raw = str(fd, key);
    const url = clean(raw);
    if (raw && !url) problems.push(`Ο σύνδεσμος ${label} δεν είναι έγκυρος`);
    return url;
  };

  const DAY_NAMES = ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο', 'Κυριακή'];
  const hours: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const raw = (k: string) => str(fd, `h${day}-${k}`);
    const open = raw('open'), close = raw('close'), open2 = raw('open2'), close2 = raw('close2');
    const closed = bool(fd, `h${day}-closed`) || (!open && !close);
    if (closed) return { day, closed: true, open: TIME.test(open) ? open : '', close: TIME.test(close) ? close : '' };
    const name = DAY_NAMES[day - 1];
    if (!open || !close) problems.push(`${name}: συμπληρώστε και άνοιγμα και κλείσιμο, ή σημειώστε «κλειστά»`);
    else if (!TIME.test(open) || !TIME.test(close)) problems.push(`${name}: οι ώρες γράφονται ως 08:30`);
    else if (close <= open) problems.push(`${name}: το κλείσιμο (${close}) είναι πριν το άνοιγμα (${open})`);
    else if (open2 || close2) {
      if (!TIME.test(open2) || !TIME.test(close2)) problems.push(`${name}: συμπληρώστε και τις δύο ώρες του απογεύματος, ή αφήστε τες κενές`);
      else if (open2 < close || close2 <= open2) problems.push(`${name}: το απογευματινό ωράριο πρέπει να ξεκινά μετά το πρωινό και να κλείνει μετά το άνοιγμά του`);
    }
    return { day, closed: false, open, close, ...(open2 && close2 ? { open2, close2 } : {}) };
  });

  const bankAccounts: BankAccount[] = [0, 1, 2, 3]
    .map((i) => ({ bank: str(fd, `bank${i}-name`), iban: str(fd, `bank${i}-iban`).toUpperCase().replace(/\s+/g, ' '), holder: str(fd, `bank${i}-holder`) }))
    .filter((a, i) => {
      if (a.iban && !a.bank) problems.push(`Τραπεζικός λογαριασμός ${i + 1}: συμπληρώστε και το όνομα της τράπεζας`);
      if (a.bank && !a.iban) problems.push(`Τραπεζικός λογαριασμός ${i + 1}: λείπει το IBAN`);
      return a.bank && a.iban;
    });

  const shop: ShopSettings['shop'] = {
    ...current.shop,
    name: str(fd, 'name') || DEFAULT_SETTINGS.shop.name, legalName: str(fd, 'legalName'), tagline: str(fd, 'tagline'), phone: str(fd, 'phone'), mobile: str(fd, 'mobile'), fax: str(fd, 'fax'),
    email: str(fd, 'email'), street: str(fd, 'street'), city: str(fd, 'city'), postalCode: str(fd, 'postalCode'), region: str(fd, 'region'),
    lat: num('lat', current.shop.lat), lng: num('lng', current.shop.lng),
    instagramUrl: link('instagramUrl', 'Instagram', instagramUrl), skroutzUrl: link('skroutzUrl', 'Skroutz'),
    vatNumber: str(fd, 'vatNumber'), taxOffice: str(fd, 'taxOffice'), gemi: str(fd, 'gemi'), hours, hoursVerified: bool(fd, 'hoursVerified'),
    foundedYear: ((y) => (y >= 1900 && y <= new Date().getFullYear() ? y : 0))(int(fd, 'foundedYear')),
    accelerateDealer: bool(fd, 'accelerateDealer'),
  };
  if (!shop.phone || !shop.street || !shop.city) return { ok: false, message: 'Τηλέφωνο, οδός και πόλη είναι υποχρεωτικά.' };
  if (shop.lat > 90 || shop.lng > 180) problems.push('Οι συντεταγμένες του χάρτη δεν είναι έγκυρες');

  // a rating is only worth showing if it is exactly what the platform shows: anything outside 1–5 is a typo, not a rating
  const rating = (key: string) => ((n) => (n >= 1 && n <= 5 ? Math.round(n * 10) / 10 : 0))(num(key, 0));
  const googleRating = rating('googleRating'), skroutzRating = rating('skroutzRating');

  const googleUrl = link('googleUrl', 'των κριτικών Google');
  const shipping = {
    courierEnabled: bool(fd, 'courierEnabled'), pickupEnabled: bool(fd, 'pickupEnabled'), carrierName: str(fd, 'carrierName') || 'Courier', deliveryEstimate: str(fd, 'deliveryEstimate'),
    baseCents: euro('baseCents', current.shipping.baseCents, 'Βασικά μεταφορικά'), baseWeightKg: num('baseWeightKg', current.shipping.baseWeightKg), perExtraKgCents: euro('perExtraKgCents', current.shipping.perExtraKgCents, 'Χρέωση ανά επιπλέον κιλό'),
    freeOverCents: euro('freeOverCents', 0, 'Όριο δωρεάν μεταφορικών'), freeMaxWeightKg: num('freeMaxWeightKg', 0), codFeeCents: euro('codFeeCents', 0, 'Χρέωση αντικαταβολής'),
  };
  const vatRaw = str(fd, 'vatRate');
  const vatRate = int(fd, 'vatRate', current.tax.vatRate);
  if (vatRaw && (!/^\d{1,2}([.,]\d+)?$/.test(vatRaw) || vatRate > 50)) problems.push(`ΦΠΑ: «${vatRaw}» δεν είναι ποσοστό`);
  if (problems.length) return { ok: false, message: `Δεν αποθηκεύτηκε τίποτα. ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` · και ${problems.length - 3} ακόμη` : ''}.` };

  await saveSettingsGroup('shop', shop);
  await saveSettingsGroup('storefront', { demoMode: bool(fd, 'demoMode'), ordersEnabled: bool(fd, 'ordersEnabled'), launchSignup: bool(fd, 'launchSignup'), announcement: str(fd, 'announcement'), lowStockThreshold: int(fd, 'lowStockThreshold', 3), b2bPage: bool(fd, 'b2bPage') });
  await saveSettingsGroup('reviews', {
    googleUrl,
    googleRating, googleCount: googleRating ? int(fd, 'googleCount') : 0,
    skroutzRating, skroutzCount: skroutzRating ? int(fd, 'skroutzCount') : 0,
  });
  await saveSettingsGroup('shipping', shipping);
  await saveSettingsGroup('payments', { cod: bool(fd, 'cod'), bankTransfer: bool(fd, 'bankTransfer'), payInStore: bool(fd, 'payInStore'), card: bool(fd, 'card'), bankAccounts });
  await saveSettingsGroup('tax', { vatRate });

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' };
}

// ─── Skroutz feed ────────────────────────────────────────────────────────────
export async function saveSkroutzSettings(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const feedEnabled = bool(fd, 'feedEnabled');
  await saveSettingsGroup('skroutz', {
    feedEnabled,
    // what is declared for a size that is on the shelf: only the first two phrases describe that
    availability: SKROUTZ_AVAILABILITY.slice(0, 2).find((a) => a === str(fd, 'availability')) ?? DEFAULT_SETTINGS.skroutz.availability,
    // 0 would tell Skroutz that every size whose stock is not counted is sold out
    defaultQuantity: Math.min(1000, Math.max(1, int(fd, 'defaultQuantity', DEFAULT_SETTINGS.skroutz.defaultQuantity))),
  });
  revalidatePath('/admin/skroutz');
  return { ok: true, message: feedEnabled ? 'Αποθηκεύτηκε. Το αρχείο είναι ανοιχτό για το Skroutz.' : 'Αποθηκεύτηκε. Το αρχείο παραμένει κλειστό: το βλέπετε μόνο εσείς.' };
}

export type CodeUpdate = { id: number; barcode: string; mpn: string };
export type CodeUpdateResult = {
  ok: boolean;
  message: string;
  saved: CodeUpdate[];
  /** rows left untouched, and why */
  failed: Array<{ id: number; reason: 'invalid' | 'duplicate' }>;
};

const CodeUpdates = z.array(z.object({ id: z.number().int().positive(), barcode: z.string().trim().max(32), mpn: z.string().trim().max(80) })).min(1).max(2000);

/** Barcode + manufacturer code per pack size, from the quick editor in Admin → Skroutz. An empty value clears the field. */
export async function updateCodes(input: CodeUpdate[]): Promise<CodeUpdateResult> {
  await requireAdmin();
  const parsed = CodeUpdates.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Δεν υπάρχουν αλλαγές προς αποθήκευση.', saved: [], failed: [] };

  const all = await db.select({ id: variants.id, barcode: variants.barcode }).from(variants);
  const known = new Set(all.map((v) => v.id));
  // every pack size has its own barcode: the same one twice means the same bottle was scanned twice
  const owner = new Map(all.flatMap((v) => (v.barcode ? [[v.barcode, v.id] as const] : [])));
  const saved: CodeUpdate[] = [];
  const failed: CodeUpdateResult['failed'] = [];

  await db.transaction(async (tx) => {
    for (const u of parsed.data) {
      if (!known.has(u.id)) continue;
      const barcode = normalizeGtin(u.barcode);
      if (barcode && !isValidGtin(barcode)) {
        failed.push({ id: u.id, reason: 'invalid' });
        continue;
      }
      if (barcode && owner.has(barcode) && owner.get(barcode) !== u.id) {
        failed.push({ id: u.id, reason: 'duplicate' });
        continue;
      }
      await tx.update(variants).set({ barcode: barcode || null, mpn: u.mpn || null }).where(eq(variants.id, u.id));
      for (const [code, id] of owner) if (id === u.id) owner.delete(code);
      if (barcode) owner.set(barcode, u.id);
      saved.push({ id: u.id, barcode, mpn: u.mpn });
    }
  });

  revalidatePath('/admin/skroutz');
  const count = saved.length === 1 ? 'Αποθηκεύτηκε 1 συσκευασία' : `Αποθηκεύτηκαν ${saved.length} συσκευασίες`;
  if (failed.length) return { ok: false, message: `${count}. ${failed.length === 1 ? 'Ένα barcode δεν έγινε δεκτό' : `${failed.length} barcodes δεν έγιναν δεκτά`} (σημειωμένα με κόκκινο).`, saved, failed };
  return { ok: true, message: saved.length ? `${count}.` : 'Καμία αλλαγή.', saved, failed };
}

/** CSV columns: sku;ean;mpn (either of the last two may be missing) — for a list sent by a distributor. Empty cells change nothing. */
export async function importCodesCsv(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const file = fd.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Επιλέξτε αρχείο CSV.' };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: 'Το αρχείο είναι πολύ μεγάλο.' };
  const { header, rows: lines } = parseCsv(await file.text());
  const col = { sku: header.indexOf('sku'), ean: header.findIndex((h) => h === 'ean' || h.startsWith('barcode') || h === 'gtin'), mpn: header.findIndex((h) => h === 'mpn' || h.startsWith('κωδ')) };
  if (col.sku < 0 || (col.ean < 0 && col.mpn < 0)) return { ok: false, message: 'Η πρώτη γραμμή πρέπει να έχει στήλη «sku» και τουλάχιστον μία από τις «ean», «mpn».' };

  const rows = await db.select({ id: variants.id, sku: variants.sku, barcode: variants.barcode }).from(variants);
  const bySku = new Map(rows.map((v) => [v.sku, v]));
  const owner = new Map(rows.flatMap((v) => (v.barcode ? [[v.barcode, v.id] as const] : [])));
  let updated = 0;
  const unknown: string[] = [];
  const rejected: string[] = [];
  for (const { cells } of lines) {
    const sku = (cells[col.sku] ?? '').toUpperCase();
    if (!sku) continue;
    const current = bySku.get(sku);
    if (!current) {
      unknown.push(sku);
      continue;
    }
    const patch: { barcode?: string; mpn?: string } = {};
    const ean = col.ean >= 0 ? normalizeGtin(cells[col.ean] ?? '') : '';
    if (ean) {
      if (!isValidGtin(ean) || (owner.has(ean) && owner.get(ean) !== current.id)) rejected.push(sku);
      else patch.barcode = ean;
    }
    const mpn = col.mpn >= 0 ? (cells[col.mpn] ?? '').slice(0, 80) : '';
    if (mpn) patch.mpn = mpn;
    if (!patch.barcode && !patch.mpn) continue;
    await db.update(variants).set(patch).where(eq(variants.id, current.id));
    if (patch.barcode) owner.set(patch.barcode, current.id);
    updated++;
  }
  revalidatePath('/admin/skroutz');
  const list = (label: string, skus: string[]) => (skus.length ? ` ${label}: ${skus.slice(0, 6).join(', ')}${skus.length > 6 ? '…' : ''}.` : '');
  return { ok: unknown.length + rejected.length === 0, message: `${updated === 1 ? 'Ενημερώθηκε 1 συσκευασία' : `Ενημερώθηκαν ${updated} συσκευασίες`}.${list('Μη έγκυρο ή διπλό barcode', rejected)}${list('Άγνωστοι κωδικοί', unknown)}` };
}
