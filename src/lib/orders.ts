import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { coupons, orderEvents, orderItems, orders, variants, type Coupon, type Order, type OrderStatus } from '@/lib/db/schema';
import { randomToken } from '@/lib/auth/password';
import { claimAttemptStatus, setAttemptStatus, type Executor } from '@/lib/payments/attempts';
import { resolveCartLines, type ResolvedCartLine } from '@/lib/catalog';
import { commerceEnabled } from '@/lib/commerce-flag';
import { cleanIds, hasTargets, matchesTargets } from '@/lib/discounts';
import { availablePaymentMethods, CARD_MIN_CENTS, computeTotals, type AppliedCoupon } from '@/lib/pricing';
import { loadCategoryPaths } from '@/lib/sales';
import type { ShopSettings } from '@/lib/settings';
import { formatPrice, isGreekPostalCode, isValidAfm } from '@/lib/utils';

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
/** Which of the cart's lines a coupon works on: the ones inside its targets and, if it says so, not already marked down. */
async function eligibleVariantIds(row: Coupon, lines: ResolvedCartLine[]): Promise<number[]> {
  const targets = { productIds: cleanIds(row.productIds), brandIds: cleanIds(row.brandIds), categoryIds: cleanIds(row.categoryIds) };
  const paths = hasTargets(targets) ? await loadCategoryPaths() : new Map<number, number[]>();
  return lines
    .filter((l) => l.quantity > 0 && l.issue !== 'unavailable')
    .filter((l) => !row.excludeSaleItems || l.compareAtCents === null)
    .filter((l) => matchesTargets(targets, { productId: l.productId, brandId: l.brandId, categoryPath: l.categoryId !== null ? (paths.get(l.categoryId) ?? [l.categoryId]) : [] }))
    .map((l) => l.variantId);
}

export async function findCoupon(code: string | undefined | null, lines: ResolvedCartLine[]): Promise<{ coupon: AppliedCoupon | null; error: string | null }> {
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const clean = (code ?? '').trim().toUpperCase();
  if (!clean) return { coupon: null, error: null };
  const [row] = await db.select().from(coupons).where(eq(coupons.code, clean));
  const now = Date.now();
  if (!row || !row.isActive) return { coupon: null, error: 'Το κουπόνι δεν είναι έγκυρο.' };
  if (row.startsAt && row.startsAt.getTime() > now) return { coupon: null, error: 'Το κουπόνι δεν έχει ενεργοποιηθεί ακόμη.' };
  if (row.endsAt && row.endsAt.getTime() < now) return { coupon: null, error: 'Το κουπόνι έχει λήξει.' };
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return { coupon: null, error: 'Το κουπόνι έχει εξαντληθεί.' };
  const targeted = hasTargets({ productIds: cleanIds(row.productIds), brandIds: cleanIds(row.brandIds), categoryIds: cleanIds(row.categoryIds) });
  const limited = targeted || row.excludeSaleItems;
  const variantIds = limited ? await eligibleVariantIds(row, lines) : null;
  if (variantIds && variantIds.length === 0) return { coupon: null, error: 'Το κουπόνι δεν ισχύει για τα προϊόντα του καλαθιού σας.' };
  const eligibleCents = variantIds ? lines.filter((l) => variantIds.includes(l.variantId)).reduce((s, l) => s + l.lineTotalCents, 0) : subtotalCents;
  if (eligibleCents < row.minSubtotalCents) {
    const min = (row.minSubtotalCents / 100).toFixed(2).replace('.', ',');
    // a coupon that only skips sale items measures the minimum on what is NOT on sale: say that, not "the offer's products"
    const error = !variantIds
      ? `Το κουπόνι ισχύει για αγορές από ${min} € και πάνω.`
      : targeted
        ? `Το κουπόνι ισχύει για αγορές από ${min} € και πάνω στα προϊόντα στα οποία αναφέρεται το κουπόνι.`
        : `Το κουπόνι ισχύει για αγορές από ${min} € και πάνω σε προϊόντα που δεν είναι σε προσφορά.`;
    return { coupon: null, error };
  }
  return { coupon: { id: row.id, code: row.code, type: row.type, value: row.value, minSubtotalCents: row.minSubtotalCents, variantIds }, error: null };
}

// ─── Create ──────────────────────────────────────────────────────────────────
export type CreateOrderResult =
  | { ok: true; order: Order }
  | { ok: false; reason: 'cart_changed' | 'invalid_method' | 'coupon' | 'commerce_disabled'; message: string };

export async function createOrder(input: CheckoutInput, settings: ShopSettings, opts: { customerId: number | null; cardProviderConfigured: boolean }): Promise<CreateOrderResult> {
  // 0. Deployment switch: with COMMERCE_ENABLED=false nothing in the application can create an order,
  //    not even a logged-in admin placing a "test" one (src/lib/commerce-flag.ts).
  if (!commerceEnabled()) {
    return { ok: false, reason: 'commerce_disabled', message: `Οι online παραγγελίες δεν έχουν ανοίξει ακόμη. Για αγορές καλέστε μας στο ${settings.shop.phone}.` };
  }

  // 1. Authoritative lines: DB prices, DB stock. Anything the browser believed about money is ignored.
  const lines = await resolveCartLines(input.lines);
  if (lines.length === 0 || lines.some((l) => l.issue !== null)) {
    return { ok: false, reason: 'cart_changed', message: 'Η διαθεσιμότητα κάποιων προϊόντων άλλαξε. Ελέγξτε το καλάθι σας και δοκιμάστε ξανά.' };
  }

  // 2. Methods must be ones the owner has switched on.
  const { shipping, payments, tax, storefront } = settings;
  // While ordering is closed to the public only an admin gets this far (see placeOrder): that is a test order too.
  const isTest = storefront.demoMode || !storefront.ordersEnabled;
  const shippingAllowed = input.shippingMethod === 'courier' ? shipping.courierEnabled : shipping.pickupEnabled;
  if (!shippingAllowed || !availablePaymentMethods(input.shippingMethod, payments, opts.cardProviderConfigured).includes(input.paymentMethod)) {
    return { ok: false, reason: 'invalid_method', message: 'Ο τρόπος αποστολής ή πληρωμής δεν είναι διαθέσιμος. Ανανεώστε τη σελίδα και δοκιμάστε ξανά.' };
  }

  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const weightGrams = lines.reduce((s, l) => s + l.weightGrams, 0);
  const { coupon, error: couponError } = await findCoupon(input.couponCode, lines);
  if (couponError) return { ok: false, reason: 'coupon', message: couponError };

  const totals = computeTotals({ subtotalCents, weightGrams, shippingMethod: input.shippingMethod, paymentMethod: input.paymentMethod, coupon, lines, shipping, vatRate: tax.vatRate });
  // a coupon can bring the total below what a card gateway accepts: such an order could never be paid
  if (input.paymentMethod === 'card' && totals.totalCents < CARD_MIN_CENTS) {
    return { ok: false, reason: 'invalid_method', message: 'Για τόσο μικρό ποσό δεν είναι δυνατή η πληρωμή με κάρτα. Επιλέξτε άλλον τρόπο πληρωμής.' };
  }
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
          .where(and(coupon.id !== undefined ? eq(coupons.id, coupon.id) : eq(coupons.code, coupon.code), sql`(${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`))
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
          couponId: coupon?.id ?? null,
          totalWeightGrams: weightGrams,
          isTest,
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
          availability: l.availability,
          // step 3 took these units off the shelf exactly when the size's stock is counted
          stockReserved: l.maxQuantity !== null,
        })),
      );
      await tx.insert(orderEvents).values({ orderId: created.id, type: 'created', message: `Η παραγγελία καταχωρήθηκε${isTest ? ' (δοκιμαστική)' : ''}.`, actor: 'customer' });
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
export async function addOrderEvent(orderId: number, type: string, message: string, actor = 'system', exec: Executor = db) {
  await exec.insert(orderEvents).values({ orderId, type, message, actor });
}

export type PaymentOutcome =
  | 'paid'
  | 'already_paid'
  | 'unknown_order'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'late_cancelled'
  /** the gateway's payment for an order the owner had already marked paid by hand (typically the webhook finally arriving) */
  | 'paid_after_manual'
  /** the same, but the owner had meanwhile refunded the order by hand: the owner has to check whether THIS payment was refunded */
  | 'paid_after_refund'
  /** a second, different payment for an order that is already paid (two open checkouts both paid) */
  | 'duplicate_payment'
  /** a problem the owner was already told about for this checkout (the browser return and the webhook both report it) */
  | 'already_flagged';

/** Puts the order on the owner's «χρειάζεται έλεγχο» list (dashboard, order list); cleared by hand once it has been dealt with. */
export async function flagForReview(orderId: number, exec: Executor = db): Promise<void> {
  await exec.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, orderId));
}

export type PaymentInfo = {
  provider: string;
  /** the gateway's reference for the payment (Viva transactionId): shown in the order's history and kept on the order */
  ref: string;
  amountCents: number;
  /** ISO code when the gateway tells us, null when it does not; anything but EUR is refused */
  currency?: string | null;
  /** the reference of the checkout that was paid (Viva order code), to mark its attempt */
  attemptRef?: string;
};

/**
 * Where a verified gateway payment lands. Idempotent: gateways deliver both a browser return and a webhook for the same
 * payment. Only 'paid' means "treat as a normal sale"; every other outcome except 'already_paid' needs the owner's attention.
 */
export async function recordPayment(orderId: number, info: PaymentInfo): Promise<PaymentOutcome> {
  // One transaction: the order, its attempt, the flag and the history line are written together or not at all. A failure
  // half-way would otherwise leave a paid order with no history and no confirmation, and Viva's retry would only find
  // 'already_paid'.
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return 'unknown_order';
    if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
      // The same payment arrives twice (browser return + webhook, or a replayed return URL) with the same reference. A
      // DIFFERENT reference on a paid order is a second charge: the buyer paid on two checkouts, or paid online after the
      // owner had already marked the order paid by hand (no stored reference). Only gateways that identify the checkout
      // (attemptRef) can say; a payment replayed after a refund changes nothing.
      const second = Boolean(info.attemptRef) && info.ref !== order.paymentTransactionId;
      if (!second) return 'already_paid';
      if (order.paymentTransactionId === null) {
        // The owner marked this order paid by hand (the usual reason: the webhook failed and the money showed up in the
        // gateway). The payment that now arrives is most likely that very money, so it is attached to the order, not
        // called a second charge. It is still put on the owner's list, with neutral wording, because a buyer who ALSO paid
        // another way (cash, phone) would have paid twice and nothing here can tell the two apart.
        const attached = await tx
          .update(orders)
          .set({ paymentProvider: info.provider, paymentTransactionId: info.ref })
          .where(and(eq(orders.id, orderId), isNull(orders.paymentTransactionId)))
          .returning({ id: orders.id });
        if (attached.length === 0) return 'already_paid';
        await claimAttemptStatus(orderId, info.provider, info.attemptRef!, 'paid', info.ref, ['created', 'processing', 'failed', 'mismatch'], tx);
        await flagForReview(orderId, tx);
        const refunded = order.paymentStatus === 'refunded';
        await addOrderEvent(
          orderId,
          'payment',
          refunded
            ? `ΠΡΟΣΟΧΗ: ήρθε η πληρωμή ${info.provider} (αναφορά ${info.ref}, ${formatPrice(info.amountCents)}) για παραγγελία που είχε σημειωθεί χειροκίνητα ως εξοφλημένη και μετά ως επιστραφείσα. Ελέγξτε στον πάροχο πληρωμών αν αυτή η πληρωμή έχει ήδη επιστραφεί· αν όχι, επιστρέψτε την. Μετά πατήστε «Το χειρίστηκα».`
            : `Η πληρωμή ${info.provider} (αναφορά ${info.ref}, ${formatPrice(info.amountCents)}) αντιστοιχίστηκε σε παραγγελία που είχε σημειωθεί εξοφλημένη χειροκίνητα. Αν είχατε εισπράξει και με άλλον τρόπο (μετρητά, τηλέφωνο), επιστρέψτε το ένα από τα δύο· αλλιώς δεν χρειάζεται ενέργεια. Πατήστε «Το χειρίστηκα» όταν το ελέγξετε.`,
          'system',
          tx,
        );
        return refunded ? 'paid_after_refund' : 'paid_after_manual';
      }
      if (!(await claimAttemptStatus(orderId, info.provider, info.attemptRef!, 'paid', info.ref, ['created', 'processing', 'failed'], tx))) return 'already_flagged';
      await flagForReview(orderId, tx);
      await addOrderEvent(
        orderId,
        'payment',
        `ΠΡΟΣΟΧΗ: δεύτερη πληρωμή για την ίδια παραγγελία (${info.provider}, αναφορά ${info.ref}, ${formatPrice(info.amountCents)}). Η παραγγελία είχε ήδη πληρωθεί${order.paymentTransactionId ? ` (αναφορά ${order.paymentTransactionId})` : ' (σημειωμένη χειροκίνητα)'}. Επιστρέψτε τα χρήματα της δεύτερης πληρωμής στον πάροχο πληρωμών και πατήστε «Το χειρίστηκα» (όχι «Επιστροφή χρημάτων», που αφορά ολόκληρη την παραγγελία).`,
        'system',
        tx,
      );
      return 'duplicate_payment';
    }

    const currency = info.currency ? info.currency.toUpperCase() : null;
    const problem: PaymentOutcome | null = currency && currency !== 'EUR' ? 'currency_mismatch' : info.amountCents !== order.totalCents ? 'amount_mismatch' : null;
    if (problem) {
      // the browser return and the webhook both report the same wrong payment: only the first one raises the alarm
      if (info.attemptRef && !(await claimAttemptStatus(orderId, info.provider, info.attemptRef, 'mismatch', info.ref, ['created', 'processing', 'failed'], tx))) return 'already_flagged';
      await flagForReview(orderId, tx);
      await addOrderEvent(
        orderId,
        'payment',
        problem === 'currency_mismatch'
          ? `ΠΡΟΣΟΧΗ: η πληρωμή έγινε σε νόμισμα ${currency} αντί για EUR. Αναφορά ${info.provider}: ${info.ref}`
          : `ΠΡΟΣΟΧΗ: το ποσό που εισπράχθηκε (${formatPrice(info.amountCents)}) διαφέρει από το σύνολο της παραγγελίας (${formatPrice(order.totalCents)}). Αναφορά ${info.provider}: ${info.ref}`,
        'system',
        tx,
      );
      return problem;
    }

    // The status is decided in SQL from what the row holds right now, never from the copy read above. A cancelled order
    // (e.g. the 2 h release of unpaid card orders) keeps its status: the money is recorded as received so nobody forgets it,
    // but the order is not revived, its stock is already back on the shelf.
    const updated = await tx
      .update(orders)
      .set({
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentProvider: info.provider,
        paymentTransactionId: info.ref,
        status: sql`CASE WHEN ${orders.status} = 'pending' THEN 'confirmed' ELSE ${orders.status} END`,
      })
      .where(and(eq(orders.id, orderId), sql`${orders.paymentStatus} NOT IN ('paid', 'refunded')`))
      .returning({ status: orders.status });
    if (updated.length === 0) return 'already_paid';
    if (info.attemptRef) await setAttemptStatus(info.provider, info.attemptRef, 'paid', info.ref, undefined, tx);
    if (updated[0].status === 'cancelled') {
      await flagForReview(orderId, tx);
      await addOrderEvent(
        orderId,
        'payment',
        `ΠΡΟΣΟΧΗ: η πληρωμή (${info.provider}, αναφορά ${info.ref}, ${formatPrice(info.amountCents)}) ήρθε αφού η παραγγελία είχε ακυρωθεί και το απόθεμα είχε επανέλθει. Επιστρέψτε τα χρήματα από τον πάροχο πληρωμών (ή επικοινωνήστε με τον πελάτη) και σημειώστε «Επιστροφή χρημάτων».`,
        'system',
        tx,
      );
      return 'late_cancelled';
    }
    await addOrderEvent(orderId, 'payment', `Η πληρωμή με κάρτα ολοκληρώθηκε (${info.provider}, αναφορά ${info.ref}).`, 'system', tx);
    return 'paid';
  });
}

/** True the first time a payment is settled as an ordinary sale. */
export async function markOrderPaid(orderId: number, info: PaymentInfo): Promise<boolean> {
  return (await recordPayment(orderId, info)) === 'paid';
}

/** Puts reserved stock and the coupon use back. Safe to call once per order: guarded by the status transition. */
export async function cancelOrder(orderId: number, actor: string, reason?: string, opts: { requireUnpaid?: boolean; noAttemptSince?: Date } = {}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const flipped = await tx
      .update(orders)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(orders.id, orderId),
          sql`${orders.status} <> 'cancelled'`,
          // requireUnpaid: the automatic release must never cancel an order whose payment landed, or was flagged for the
          // owner, or that someone moved on, after it was selected
          opts.requireUnpaid
            ? and(
                sql`${orders.paymentStatus} NOT IN ('paid', 'refunded')`,
                eq(orders.status, 'pending'),
                isNull(orders.paymentFlag),
                // a delayed payment (SEPA…) that is still on its way is not abandoned
                sql`NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.order_id = ${orders.id} AND a.status = 'processing')`,
              )
            : undefined,
          // …nor one whose buyer opened a new checkout in the meantime
          opts.noAttemptSince ? sql`NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.order_id = ${orders.id} AND a.created_at >= ${opts.noAttemptSince.getTime()})` : undefined,
        ),
      )
      .returning({ id: orders.id, couponCode: orders.couponCode, couponId: orders.couponId });
    if (flipped.length === 0) return false;

    // a cancelled order no longer counts against the coupon's «μέγιστες χρήσεις»
    // by the coupon's id: its code may have been renamed since (orders from before the id was kept fall back to the code)
    const { couponCode, couponId } = flipped[0];
    if (couponId !== null || couponCode) {
      await tx.update(coupons).set({ usedCount: sql`MAX(${coupons.usedCount} - 1, 0)` }).where(couponId !== null ? eq(coupons.id, couponId) : eq(coupons.code, couponCode!));
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const ids = items.map((i) => i.variantId).filter((id): id is number => id !== null);
    const tracked = ids.length ? await tx.select({ id: variants.id, trackStock: variants.trackStock }).from(variants).where(inArray(variants.id, ids)) : [];
    const isTracked = new Set(tracked.filter((v) => v.trackStock).map((v) => v.id));
    for (const item of items) {
      // exactly what the order took: counting switched on after the order must not add units it never reserved, and switched
      // off after it must not keep them; orders from before this was recorded fall back to whether the size counts now
      if (item.variantId && (item.stockReserved ?? isTracked.has(item.variantId))) {
        await tx.update(variants).set({ stock: sql`${variants.stock} + ${item.quantity}` }).where(eq(variants.id, item.variantId));
      }
    }
    await tx.insert(orderEvents).values({ orderId, type: 'status', message: `Η παραγγελία ακυρώθηκε${reason ? `: ${reason}` : ''}. Το απόθεμα επανήλθε.`, actor });
    return true;
  });
}

/**
 * Card orders the buyer walked away from keep stock reserved; release them after two hours. A Viva checkout expires after
 * 30 minutes (paymentTimeout in payments/viva.ts), so by then no new payment can start; a late webhook for one that did is
 * kept visible by recordPayment().
 */
export async function releaseAbandonedCardOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.paymentMethod, 'card'),
        eq(orders.paymentStatus, 'pending'),
        eq(orders.status, 'pending'),
        // an order with a payment problem waits for the owner (the money may already be taken): never auto-cancelled
        isNull(orders.paymentFlag),
        lt(orders.createdAt, cutoff),
        // the buyer finished a delayed payment that has not settled yet: wait for the gateway's answer
        sql`NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.order_id = ${orders.id} AND a.status = 'processing')`,
        // a retry opened shortly before the cutoff is still payable: leave the order alone until that checkout has expired too
        sql`NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.order_id = ${orders.id} AND a.created_at >= ${cutoff.getTime()})`,
      ),
    );
  let released = 0;
  for (const o of stale) if (await cancelOrder(o.id, 'system', 'η πληρωμή με κάρτα δεν ολοκληρώθηκε', { requireUnpaid: true, noAttemptSince: cutoff })) released++;
  return released;
}

export async function getOrderByNumber(number: string) {
  return db.query.orders.findFirst({ where: eq(orders.number, number), with: { items: true, events: true } });
}

export type OrderWithItems = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>;
