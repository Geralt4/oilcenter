'use server';

import { commerceEnabled } from '@/lib/commerce-flag';
import { getCustomer } from '@/lib/auth/session';
import { canOrderNow } from '@/lib/catalogue-mode';
import { resolveCartLines } from '@/lib/catalog';
import { newOrderNotificationMail, sendMail } from '@/lib/email';
import { addOrderEvent, CheckoutSchema, createOrder, findCoupon, getOrderByNumber, releaseUnstartedCardOrder } from '@/lib/orders';
import { sendPlacedOrderConfirmation } from '@/lib/order-mail';
import { cardProvider, startCardPayment } from '@/lib/payments';
import { hasProcessingPayment, recordPaymentAttempt } from '@/lib/payments/attempts';
import type { AppliedCoupon } from '@/lib/pricing';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';

export type PlaceOrderResult =
  | { ok: true; redirectUrl: string; external: boolean }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; cartChanged?: boolean };

export async function placeOrder(raw: unknown): Promise<PlaceOrderResult> {
  const limited = await rateLimit(`checkout:${await clientIp()}`, 8, 10 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά ή καλέστε μας.` };

  // Pre-launch the checkout is closed to the public. The page already hides the form; this is the check that counts.
  // canOrderNow() also answers the deployment switch (COMMERCE_ENABLED=false): website only, even for admins.
  const [settings, canOrder] = await Promise.all([getSettings(), canOrderNow()]);
  if (!canOrder) return { ok: false, message: `Οι online παραγγελίες δεν έχουν ανοίξει ακόμη. Για αγορές καλέστε μας στο ${settings.shop.phone}.` };

  const parsed = CheckoutSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors };
  }

  const customer = await getCustomer();
  const result = await createOrder(parsed.data, settings, { customerId: customer?.id ?? null, cardProviderConfigured: cardProvider() !== null });
  if (!result.ok) return { ok: false, message: result.message, cartChanged: result.reason === 'cart_changed' };

  const { order } = result;
  const orderUrl = `/order/${order.number}?t=${order.accessToken}`;
  const full = await getOrderByNumber(order.number);

  // The shop hears about every order immediately, including card orders that are still unpaid.
  if (full) {
    const notified = await sendMail(newOrderNotificationMail(full, settings));
    if (!notified) await addOrderEvent(order.id, 'email', 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης προς το κατάστημα.');
  }

  if (order.paymentMethod === 'card') {
    try {
      const payment = await startCardPayment(order);
      await recordPaymentAttempt(order.id, payment);
      await addOrderEvent(order.id, 'payment', `Ο πελάτης μεταφέρθηκε στη σελίδα πληρωμής (${payment.provider}).`);
      return { ok: true, redirectUrl: payment.redirectUrl, external: true };
    } catch (err) {
      console.error('[checkout] could not start card payment', err);
      await addOrderEvent(order.id, 'payment', 'Δεν ήταν δυνατή η έναρξη της πληρωμής με κάρτα.');
      // Nothing can be paid on this order: cancel it and give the stock back now. If that does not work, the order stays payable
      // (the retry button) and the two-hour sweep remains the safety net.
      const released = await releaseUnstartedCardOrder(order.id).catch((releaseErr) => {
        console.error('[checkout] could not release the order after a failed card start', releaseErr);
        return false;
      });
      return { ok: true, redirectUrl: `${orderUrl}&payment=${released ? 'unavailable' : 'failed'}`, external: false };
    }
  }

  // The order page thanks the buyer for the order in any case, but only says «we sent a confirmation» when one went out: a failure
  // is passed on as mail=0 (the mail itself is not retried on this path, the order page then says to keep the number).
  const sent = await sendPlacedOrderConfirmation(order, full, settings);
  return { ok: true, redirectUrl: `${orderUrl}&placed=1${sent ? '' : '&mail=0'}`, external: false };
}

/** Lets the buyer try the card again from the order page after a failed / abandoned payment. */
export async function retryCardPayment(number: string, token: string): Promise<{ ok: true; redirectUrl: string } | { ok: false; message: string }> {
  const limited = await rateLimit(`pay:${await clientIp()}`, 6, 10 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.' };
  if (!commerceEnabled()) return { ok: false, message: 'Η πληρωμή με κάρτα είναι απενεργοποιημένη.' };

  const order = await getOrderByNumber(number);
  if (!order || order.accessToken !== token) return { ok: false, message: 'Η παραγγελία δεν βρέθηκε.' };
  // only an open payment can be retried: a paid or REFUNDED order must not be charged again
  if (order.paymentMethod !== 'card' || (order.paymentStatus !== 'pending' && order.paymentStatus !== 'failed') || order.status === 'cancelled') return { ok: false, message: 'Η παραγγελία δεν αναμένει πληρωμή.' };
  // a flagged order may already have been charged (e.g. a payment with the wrong amount): the owner sorts it out, no second charge
  if (order.paymentFlag !== null) return { ok: false, message: 'Η πληρωμή σας ελέγχεται από το κατάστημα. Μην πληρώσετε ξανά· θα επικοινωνήσουμε μαζί σας.' };
  // a delayed payment (SEPA…) the buyer already finished is still on its way: a second charge would double it
  if (await hasProcessingPayment(order.id)) return { ok: false, message: 'Η πληρωμή σας βρίσκεται σε επεξεργασία. Μην πληρώσετε ξανά· θα ενημερωθείτε μόλις ολοκληρωθεί.' };
  try {
    const payment = await startCardPayment(order);
    await recordPaymentAttempt(order.id, payment);
    return { ok: true, redirectUrl: payment.redirectUrl };
  } catch (err) {
    console.error('[checkout] retry card payment failed', err);
    return { ok: false, message: 'Η πληρωμή με κάρτα δεν είναι διαθέσιμη αυτή τη στιγμή. Καλέστε μας για να ολοκληρώσουμε την παραγγελία.' };
  }
}

export async function checkCoupon(code: string, lines: Array<{ variantId: number; quantity: number }>): Promise<{ coupon: AppliedCoupon | null; error: string | null }> {
  const limited = await rateLimit(`coupon:${await clientIp()}`, 15, 10 * 60 * 1000);
  if (!limited.ok) return { coupon: null, error: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.' };
  const resolved = await resolveCartLines(Array.isArray(lines) ? lines.slice(0, 100) : []);
  return findCoupon(String(code ?? '').slice(0, 40), resolved);
}
