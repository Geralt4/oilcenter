import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { coupons, orderEvents, orderItems, orders, variants, type Order, type OrderStatus } from '@/lib/db/schema';
import { randomToken } from '@/lib/auth/password';
import { resolveCartLines } from '@/lib/catalog';
import { availablePaymentMethods, computeTotals, type AppliedCoupon } from '@/lib/pricing';
import type { ShopSettings } from '@/lib/settings';
import { isGreekPostalCode, isValidAfm } from '@/lib/utils';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Σε αναμονή',
  confirmed: 'Επιβεβαιωμένη',
  processing: 'Σε επεξεργασία',
  shipped: 'Απεστάλη',
  ready_for_pickup: 'Έτοιμη για παραλαβή',
  completed: 'Ολοκληρώθηκε',
  cancelled: 'Ακυρώθηκε',
};

export const PAYMENT_STATUS_LABELS = { pending: 'Εκκρεμεί', paid: 'Εξοφλήθηκε', failed: 'Απέτυχε', refunded: 'Επιστροφή χρημάτων' } as const;

// ─── Checkout input ──────────────────────────────────────────────────────────
const trimmed = (max: number) => z.string().trim().max(max);

export const CheckoutSchema = z
  .object({
    lines: z.array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().positive().max(999) })).min(1, 'Το καλάθι είναι άδειο').max(100),
    couponCode: trimmed(40).optional(),
    email: z.string().trim().toLowerCase().email('Μη έγκυρο e-mail').max(160),
    phone: trimmed(30).regex(/^[+\d][\d\s-]{8,}$/, 'Μη έγκυρο τηλέφωνο'),
    firstName: trimmed(80).min(2, 'Συμπληρώστε το όνομά σας'),
    lastName: trimmed(80).min(2, 'Συμπληρώστε το επώνυμό σας'),
    shippingMethod: z.enum(['courier', 'pickup']),
    paymentMethod: z.enum(['cod', 'bank_transfer', 'card', 'pay_in_store']),
    street: trimmed(160).optional(),
    city: trimmed(80).optional(),
    postalCode: trimmed(10).optional(),
    region: trimmed(80).optional(),
    notes: trimmed(1000).optional(),
    docType: z.enum(['receipt', 'invoice']),
    companyName: trimmed(160).optional(),
    vatNumber: trimmed(20).optional(),
    taxOffice: trimmed(80).optional(),
    companyActivity: trimmed(160).optional(),
    companyAddress: trimmed(200).optional(),
    acceptTerms: z.literal(true, { error: 'Πρέπει να αποδεχτείτε τους όρους' }),
  })
  .superRefine((v, ctx) => {
    if (v.shippingMethod === 'courier') {
      if (!v.street || v.street.length < 3) ctx.addIssue({ code: 'custom', path: ['street'], message: 'Συμπληρώστε οδό και αριθμό' });
      if (!v.city || v.city.length < 2) ctx.addIssue({ code: 'custom', path: ['city'], message: 'Συμπληρώστε πόλη' });
      if (!v.postalCode || !isGreekPostalCode(v.postalCode)) ctx.addIssue({ code: 'custom', path: ['postalCode'], message: 'Ο Τ.Κ. έχει 5 ψηφία' });
    }
    if (v.docType === 'invoice') {
      if (!v.companyName || v.companyName.length < 2) ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Συμπληρώστε επωνυμία' });
      if (!v.vatNumber || !isValidAfm(v.vatNumber)) ctx.addIssue({ code: 'custom', path: ['vatNumber'], message: 'Μη έγκυρο ΑΦΜ' });
      if (!v.taxOffice) ctx.addIssue({ code: 'custom', path: ['taxOffice'], message: 'Συμπληρώστε ΔΟΥ' });
      if (!v.companyActivity) ctx.addIssue({ code: 'custom', path: ['companyActivity'], message: 'Συμπληρώστε δραστηριότητα' });
    }
  });

export type CheckoutInput = z.infer<typeof CheckoutSchema>;

// ─── Coupons ─────────────────────────────────────────────────────────────────
export async function findCoupon(code: string | undefined | null, subtotalCents: number): Promise<{ coupon: AppliedCoupon | null; error: string | null }> {
  const clean = (code ?? '').trim().toUpperCase();
  if (!clean) return { coupon: null, error: null };
  const [row] = await db.select().from(coupons).where(eq(coupons.code, clean));
  const now = Date.now();
  if (!row || !row.isActive) return { coupon: null, error: 'Το κουπόνι δεν είναι έγκυρο.' };
  if (row.startsAt && row.startsAt.getTime() > now) return { coupon: null, error: 'Το κουπόνι δεν έχει ενεργοποιηθεί ακόμη.' };
  if (row.endsAt && row.endsAt.getTime() < now) return { coupon: null, error: 'Το κουπόνι έχει λήξει.' };
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return { coupon: null, error: 'Το κουπόνι έχει εξαντληθεί.' };
  if (subtotalCents < row.minSubtotalCents) return { coupon: null, error: `Το κουπόνι ισχύει για αγορές άνω των ${(row.minSubtotalCents / 100).toFixed(2).replace('.', ',')} €.` };
  return { coupon: { code: row.code, type: row.type, value: row.value, minSubtotalCents: row.minSubtotalCents }, error: null };
}

// ─── Create ──────────────────────────────────────────────────────────────────
export type CreateOrderResult =
  | { ok: true; order: Order }
  | { ok: false; reason: 'cart_changed' | 'invalid_method' | 'coupon'; message: string };

export async function createOrder(input: CheckoutInput, settings: ShopSettings, opts: { customerId: number | null; cardProviderConfigured: boolean }): Promise<CreateOrderResult> {
  // 1. Authoritative lines: DB prices, DB stock. Anything the browser believed about money is ignored.
  const lines = await resolveCartLines(input.lines);
  if (lines.length === 0 || lines.some((l) => l.issue !== null)) {
    return { ok: false, reason: 'cart_changed', message: 'Η διαθεσιμότητα κάποιων προϊόντων άλλαξε. Ελέγξτε το καλάθι σας και δοκιμάστε ξανά.' };
  }

  // 2. Methods must be ones the owner has switched on.
  const { shipping, payments, tax, storefront } = settings;
  const shippingAllowed = input.shippingMethod === 'courier' ? shipping.courierEnabled : shipping.pickupEnabled;
  if (!shippingAllowed || !availablePaymentMethods(input.shippingMethod, payments, opts.cardProviderConfigured).includes(input.paymentMethod)) {
    return { ok: false, reason: 'invalid_method', message: 'Ο τρόπος αποστολής ή πληρωμής δεν είναι διαθέσιμος. Ανανεώστε τη σελίδα και δοκιμάστε ξανά.' };
  }

  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const weightGrams = lines.reduce((s, l) => s + l.weightGrams, 0);
  const { coupon, error: couponError } = await findCoupon(input.couponCode, subtotalCents);
  if (couponError) return { ok: false, reason: 'coupon', message: couponError };

  const totals = computeTotals({ subtotalCents, weightGrams, shippingMethod: input.shippingMethod, paymentMethod: input.paymentMethod, coupon, shipping, vatRate: tax.vatRate });
  const courier = input.shippingMethod === 'courier';

  try {
    const order = await db.transaction(async (tx) => {
      // 3. Reserve stock. The WHERE clause makes each decrement atomic: two buyers cannot take the last unit.
      for (const l of lines) {
        if (l.maxQuantity === null) continue;
        const updated = await tx
          .update(variants)
          .set({ stock: sql`${variants.stock} - ${l.quantity}` })
          .where(and(eq(variants.id, l.variantId), gte(variants.stock, l.quantity)))
          .returning({ id: variants.id });
        if (updated.length === 0) throw new OutOfStockError();
      }

      if (coupon) {
        const bumped = await tx
          .update(coupons)
          .set({ usedCount: sql`${coupons.usedCount} + 1` })
          .where(and(eq(coupons.code, coupon.code), sql`(${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`))
          .returning({ id: coupons.id });
        if (bumped.length === 0) throw new CouponGoneError();
      }

      const [created] = await tx
        .insert(orders)
        .values({
          number: `TMP-${randomToken(9)}`,
          accessToken: randomToken(24),
          paymentMethod: input.paymentMethod,
          shippingMethod: input.shippingMethod,
          customerId: opts.customerId,
          email: input.email,
          phone: input.phone,
          firstName: input.firstName,
          lastName: input.lastName,
          street: courier ? input.street : null,
          city: courier ? input.city : null,
          postalCode: courier ? input.postalCode?.replace(/\s/g, '') : null,
          region: courier ? input.region || null : null,
          notes: input.notes || null,
          docType: input.docType,
          companyName: input.docType === 'invoice' ? input.companyName : null,
          vatNumber: input.docType === 'invoice' ? input.vatNumber?.replace(/\D/g, '') : null,
          taxOffice: input.docType === 'invoice' ? input.taxOffice : null,
          companyActivity: input.docType === 'invoice' ? input.companyActivity : null,
          companyAddress: input.docType === 'invoice' ? input.companyAddress || null : null,
          subtotalCents: totals.subtotalCents,
          shippingCents: totals.shippingCents,
          codFeeCents: totals.codFeeCents,
          discountCents: totals.discountCents,
          totalCents: totals.totalCents,
          vatRate: tax.vatRate,
          couponCode: coupon?.code ?? null,
          totalWeightGrams: weightGrams,
          isTest: storefront.demoMode,
        })
        .returning();

      const number = `OC-${10000 + created.id}`;
      await tx.update(orders).set({ number }).where(eq(orders.id, created.id));

      await tx.insert(orderItems).values(
        lines.map((l) => ({
          orderId: created.id,
          productId: l.productId,
          variantId: l.variantId,
          name: [l.brandName, l.name].filter(Boolean).join(' '),
          variantLabel: l.variantLabel,
          sku: l.sku,
          imageUrl: l.imageUrl,
          slug: l.slug,
          unitPriceCents: l.unitPriceCents,
          quantity: l.quantity,
          lineTotalCents: l.lineTotalCents,
          weightGrams: l.unitWeightGrams,
        })),
      );
      await tx.insert(orderEvents).values({ orderId: created.id, type: 'created', message: `Η παραγγελία καταχωρήθηκε${storefront.demoMode ? ' (δοκιμαστική λειτουργία)' : ''}.`, actor: 'customer' });
      return { ...created, number };
    });
    return { ok: true, order };
  } catch (err) {
    if (err instanceof OutOfStockError) return { ok: false, reason: 'cart_changed', message: 'Κάποιο προϊόν μόλις εξαντλήθηκε. Ελέγξτε το καλάθι σας.' };
    if (err instanceof CouponGoneError) return { ok: false, reason: 'coupon', message: 'Το κουπόνι μόλις εξαντλήθηκε.' };
    throw err;
  }
}

class OutOfStockError extends Error {}
class CouponGoneError extends Error {}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
export async function addOrderEvent(orderId: number, type: string, message: string, actor = 'system') {
  await db.insert(orderEvents).values({ orderId, type, message, actor });
}

/** Idempotent: gateways deliver both a browser return and a webhook for the same payment. Returns true the first time only. */
export async function markOrderPaid(orderId: number, info: { provider: string; ref: string; amountCents: number }): Promise<boolean> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.paymentStatus === 'paid') return false;
  if (info.amountCents !== order.totalCents) {
    await addOrderEvent(orderId, 'payment', `ΠΡΟΣΟΧΗ: το ποσό που εισπράχθηκε (${info.amountCents / 100} €) διαφέρει από το σύνολο της παραγγελίας (${order.totalCents / 100} €). Αναφορά ${info.provider}: ${info.ref}`);
    return false;
  }
  const updated = await db
    .update(orders)
    .set({ paymentStatus: 'paid', paidAt: new Date(), paymentProvider: info.provider, status: order.status === 'pending' ? 'confirmed' : order.status })
    .where(and(eq(orders.id, orderId), sql`${orders.paymentStatus} <> 'paid'`))
    .returning({ id: orders.id });
  if (updated.length === 0) return false;
  await addOrderEvent(orderId, 'payment', `Η πληρωμή με κάρτα ολοκληρώθηκε (${info.provider}, αναφορά ${info.ref}).`);
  return true;
}

/** Puts reserved stock back. Safe to call once per order: guarded by the status transition. */
export async function cancelOrder(orderId: number, actor: string, reason?: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const flipped = await tx
      .update(orders)
      .set({ status: 'cancelled' })
      .where(and(eq(orders.id, orderId), sql`${orders.status} <> 'cancelled'`))
      .returning({ id: orders.id });
    if (flipped.length === 0) return false;

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const ids = items.map((i) => i.variantId).filter((id): id is number => id !== null);
    const tracked = ids.length ? await tx.select({ id: variants.id, trackStock: variants.trackStock }).from(variants).where(inArray(variants.id, ids)) : [];
    const isTracked = new Set(tracked.filter((v) => v.trackStock).map((v) => v.id));
    for (const item of items) {
      if (item.variantId && isTracked.has(item.variantId)) {
        await tx.update(variants).set({ stock: sql`${variants.stock} + ${item.quantity}` }).where(eq(variants.id, item.variantId));
      }
    }
    await tx.insert(orderEvents).values({ orderId, type: 'status', message: `Η παραγγελία ακυρώθηκε${reason ? `: ${reason}` : ''}. Το απόθεμα επανήλθε.`, actor });
    return true;
  });
}

/** Card orders the buyer walked away from keep stock reserved; release them after two hours. */
export async function releaseAbandonedCardOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.paymentMethod, 'card'), eq(orders.paymentStatus, 'pending'), eq(orders.status, 'pending'), lt(orders.createdAt, cutoff)));
  let released = 0;
  for (const o of stale) if (await cancelOrder(o.id, 'system', 'η πληρωμή με κάρτα δεν ολοκληρώθηκε')) released++;
  return released;
}

export async function getOrderByNumber(number: string) {
  return db.query.orders.findFirst({ where: eq(orders.number, number), with: { items: true, events: true } });
}

export type OrderWithItems = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>;
