'use server';

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword, randomToken, verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { adminUsers, brands, categories, contactMessages, coupons, orders, productImages, products, variants, type BaseType, type OrderStatus } from '@/lib/db/schema';
import { orderStatusMail, sendMail } from '@/lib/email';
import { normalizeProductPhoto } from '@/lib/images';
import { addOrderEvent, cancelOrder, getOrderByNumber, ORDER_STATUS_LABELS } from '@/lib/orders';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { DEFAULT_SETTINGS, type BankAccount, type DayHours, type ShopSettings } from '@/lib/settings';
import { getSettings, saveSettingsGroup } from '@/lib/settings.server';
import { normalizeText, parsePriceToCents, parseVolumeMl, slugify } from '@/lib/utils';

/* Every action below starts with requireAdmin(): page-level protection alone would not cover direct action calls. */

export type AdminFormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

const str = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();
const bool = (fd: FormData, key: string) => fd.get(key) === 'on' || fd.get(key) === 'true';
const int = (fd: FormData, key: string, fallback = 0) => {
  const n = Math.round(Number(str(fd, key).replace(',', '.')));
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
  await createSession('admin', admin.id);
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
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row || !(await verifyPassword(String(fd.get('currentPassword') ?? ''), row.passwordHash))) return { ok: false, message: 'Ο τρέχων κωδικός δεν είναι σωστός.' };
  await db.update(adminUsers).set({ passwordHash: await hashPassword(next) }).where(eq(adminUsers.id, me.id));
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
  weightGrams: z.number().int().min(0).max(100000),
  barcode: z.string().trim().max(32).optional(),
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

async function storeUploads(files: File[], slug: string): Promise<string[]> {
  const dir = path.resolve(process.env.DATA_DIR || './data', 'uploads', 'products');
  await mkdir(dir, { recursive: true });
  const urls: string[] = [];
  for (const file of files.slice(0, 12)) {
    if (!file.size || file.size > 20 * 1024 * 1024 || !file.type.startsWith('image/')) continue;
    // Re-encoding through sharp both normalises the photo and guarantees the stored bytes really are an image.
    const { data } = await normalizeProductPhoto(Buffer.from(await file.arrayBuffer()));
    const name = `${slug.slice(0, 60)}-${randomToken(5).toLowerCase()}.webp`;
    await writeFile(path.join(dir, name), data);
    urls.push(`/media/products/${name}`);
  }
  return urls;
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

  const brandId = int(fd, 'brandId') || null;
  const categoryId = int(fd, 'categoryId') || null;
  const [brand] = brandId ? await db.select().from(brands).where(eq(brands.id, brandId)) : [];
  const [category] = categoryId ? await db.select().from(categories).where(eq(categories.id, categoryId)) : [];

  const slug = await uniqueSlug(slugify(str(fd, 'slug') || (name.toLowerCase().startsWith((brand?.name ?? ' ').toLowerCase()) ? name : `${brand?.name ?? ''} ${name}`)), id ?? undefined);
  const viscosity = str(fd, 'viscosity').toUpperCase().replace(/\s/g, '') || null;
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
    searchText: normalizeText([brand?.name ?? '', name, viscosity ?? '', viscosity?.replace('-', '') ?? '', specs.join(' '), category?.name ?? '', str(fd, 'keywords'), priced.map((v) => v.label).join(' ')].join(' ')),
  };

  const uploads = await storeUploads(fd.getAll('images').filter((f): f is File => f instanceof File), slug);

  const productId = await db.transaction(async (tx) => {
    let pid = id;
    if (pid) await tx.update(products).set(values).where(eq(products.id, pid));
    else pid = (await tx.insert(products).values(values).returning({ id: products.id }))[0].id;

    const keep = priced.flatMap((v) => (v.id ? [v.id] : []));
    await tx.delete(variants).where(keep.length ? and(eq(variants.productId, pid), notInArray(variants.id, keep)) : eq(variants.productId, pid));

    for (const [sort, v] of priced.entries()) {
      const row = {
        productId: pid, label: v.label, volumeMl: /\d\s*g$/i.test(v.label) ? null : parseVolumeMl(v.label), priceCents: v.priceCents!, compareAtCents: v.compareAtCents,
        stock: v.stock, trackStock: v.trackStock, weightGrams: v.weightGrams, barcode: v.barcode || null, imageUrl: v.imageUrl || null, isActive: v.isActive, priceVerified: v.priceVerified, sort,
        sku: v.sku || `${slug}-${slugify(v.label)}`.toUpperCase().slice(0, 60),
      };
      if (v.id) await tx.update(variants).set(row).where(and(eq(variants.id, v.id), eq(variants.productId, pid)));
      else await tx.insert(variants).values(row);
    }

    if (uploads.length) {
      const existing = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, pid));
      await tx.insert(productImages).values(uploads.map((url, i) => ({ productId: pid!, url, alt: name, sort: existing.length + i })));
    }
    return pid;
  }).catch((err: unknown) => {
    if (String(err).includes('UNIQUE') && String(err).includes('sku')) return null;
    throw err;
  });

  if (productId === null) return { ok: false, message: 'Κάποιος κωδικός (SKU) χρησιμοποιείται ήδη από άλλο προϊόν.' };
  revalidatePath('/admin/products');
  if (!id) redirect(`/admin/products/${productId}?created=1`);
  return { ok: true, message: 'Το προϊόν αποθηκεύτηκε.' };
}

export async function deleteProduct(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  const images = await db.select().from(productImages).where(eq(productImages.productId, id));
  await db.transaction(async (tx) => {
    await tx.delete(variants).where(eq(variants.productId, id));
    await tx.delete(productImages).where(eq(productImages.productId, id));
    await tx.delete(products).where(eq(products.id, id));
  });
  await Promise.all(images.map((i) => removeUpload(i.url)));
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
export async function savePrices(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const ids = [...new Set([...fd.keys()].flatMap((k) => (k.startsWith('price-') ? [Number(k.slice(6))] : [])))].filter(Number.isInteger);
  if (!ids.length) return { ok: false, message: 'Δεν υπάρχουν αλλαγές.' };
  const rows = await db.select().from(variants).where(inArray(variants.id, ids));
  let changed = 0;
  const bad: string[] = [];
  for (const v of rows) {
    const cents = parsePriceToCents(str(fd, `price-${v.id}`));
    if (cents === null || cents <= 0) {
      bad.push(v.sku);
      continue;
    }
    const verified = bool(fd, `verified-${v.id}`);
    if (cents !== v.priceCents || verified !== v.priceVerified) {
      // typing a new price is itself a confirmation
      await db.update(variants).set({ priceCents: cents, priceVerified: verified || cents !== v.priceCents }).where(eq(variants.id, v.id));
      changed++;
    }
  }
  revalidatePath('/admin/prices');
  if (bad.length) return { ok: false, message: `Αποθηκεύτηκαν ${changed}. Μη έγκυρη τιμή σε: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}` };
  return { ok: true, message: changed ? `Αποθηκεύτηκαν ${changed} αλλαγές.` : 'Καμία αλλαγή.' };
}

/** CSV columns: sku;price[;stock]  — separator ; or , — decimal comma or point. Unknown SKUs are reported, never created. */
export async function importPricesCsv(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const file = fd.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Επιλέξτε αρχείο CSV.' };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: 'Το αρχείο είναι πολύ μεγάλο.' };
  const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
  const header = (lines[0] ?? '').toLowerCase().split(sep).map((h) => h.replace(/"/g, '').trim());
  const col = { sku: header.indexOf('sku'), price: header.findIndex((h) => h.startsWith('price') || h.startsWith('τιμ')), stock: header.findIndex((h) => h.startsWith('stock') || h.startsWith('απόθ') || h.startsWith('αποθ')) };
  if (col.sku < 0 || col.price < 0) return { ok: false, message: 'Η πρώτη γραμμή πρέπει να έχει στήλες «sku» και «price».' };

  let updated = 0;
  const unknown: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((c) => c.replace(/^"|"$/g, '').trim());
    const sku = cells[col.sku];
    // with a comma separator a decimal comma would have split the cell: accept only point decimals there
    const cents = parsePriceToCents(cells[col.price] ?? '');
    if (!sku || cents === null || cents <= 0) continue;
    const patch: { priceCents: number; priceVerified: boolean; stock?: number; trackStock?: boolean } = { priceCents: cents, priceVerified: true };
    const stock = col.stock >= 0 ? Number(cells[col.stock]) : NaN;
    if (Number.isInteger(stock) && stock >= 0) Object.assign(patch, { stock, trackStock: true });
    const hit = await db.update(variants).set(patch).where(eq(variants.sku, sku)).returning({ id: variants.id });
    if (hit.length) updated++;
    else unknown.push(sku);
  }
  revalidatePath('/admin/prices');
  return { ok: unknown.length === 0, message: `Ενημερώθηκαν ${updated} κωδικοί.${unknown.length ? ` Άγνωστοι: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? '…' : ''}` : ''}` };
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

// ─── Settings ────────────────────────────────────────────────────────────────
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveSettings(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const current = await getSettings();
  const euro = (key: string, fallback: number) => parsePriceToCents(str(fd, key)) ?? fallback;
  const num = (key: string, fallback: number) => {
    const n = Number(str(fd, key).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const hours: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const t = (k: string) => (TIME.test(str(fd, `h${day}-${k}`)) ? str(fd, `h${day}-${k}`) : '');
    const open = t('open'), close = t('close'), open2 = t('open2'), close2 = t('close2');
    return { day, closed: bool(fd, `h${day}-closed`) || !open || !close, open, close, ...(open2 && close2 ? { open2, close2 } : {}) };
  });

  const bankAccounts: BankAccount[] = [0, 1, 2, 3]
    .map((i) => ({ bank: str(fd, `bank${i}-name`), iban: str(fd, `bank${i}-iban`).toUpperCase().replace(/\s+/g, ' '), holder: str(fd, `bank${i}-holder`) }))
    .filter((a) => a.bank && a.iban);

  const shop: ShopSettings['shop'] = {
    ...current.shop,
    name: str(fd, 'name') || DEFAULT_SETTINGS.shop.name, legalName: str(fd, 'legalName'), tagline: str(fd, 'tagline'), phone: str(fd, 'phone'), mobile: str(fd, 'mobile'), fax: str(fd, 'fax'),
    email: str(fd, 'email'), street: str(fd, 'street'), city: str(fd, 'city'), postalCode: str(fd, 'postalCode'), region: str(fd, 'region'),
    lat: num('lat', current.shop.lat), lng: num('lng', current.shop.lng), facebookUrl: str(fd, 'facebookUrl'), instagramUrl: str(fd, 'instagramUrl'),
    vatNumber: str(fd, 'vatNumber'), taxOffice: str(fd, 'taxOffice'), gemi: str(fd, 'gemi'), hours, hoursVerified: bool(fd, 'hoursVerified'),
  };
  if (!shop.phone || !shop.street || !shop.city) return { ok: false, message: 'Τηλέφωνο, οδός και πόλη είναι υποχρεωτικά.' };

  await saveSettingsGroup('shop', shop);
  await saveSettingsGroup('storefront', { demoMode: bool(fd, 'demoMode'), announcement: str(fd, 'announcement'), lowStockThreshold: int(fd, 'lowStockThreshold', 3) });
  await saveSettingsGroup('shipping', {
    courierEnabled: bool(fd, 'courierEnabled'), pickupEnabled: bool(fd, 'pickupEnabled'), carrierName: str(fd, 'carrierName') || 'Courier', deliveryEstimate: str(fd, 'deliveryEstimate'),
    baseCents: euro('baseCents', current.shipping.baseCents), baseWeightKg: num('baseWeightKg', current.shipping.baseWeightKg), perExtraKgCents: euro('perExtraKgCents', current.shipping.perExtraKgCents),
    freeOverCents: euro('freeOverCents', 0), freeMaxWeightKg: num('freeMaxWeightKg', 0), codFeeCents: euro('codFeeCents', 0),
  });
  await saveSettingsGroup('payments', { cod: bool(fd, 'cod'), bankTransfer: bool(fd, 'bankTransfer'), payInStore: bool(fd, 'payInStore'), card: bool(fd, 'card'), bankAccounts });
  await saveSettingsGroup('tax', { vatRate: Math.min(50, Math.max(0, int(fd, 'vatRate', 24))) });

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' };
}
