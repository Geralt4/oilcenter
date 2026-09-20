'use server';

import { eq } from 'drizzle-orm';
import { getAdmin, getCustomer } from '@/lib/auth/session';
import { resolveCartLines } from '@/lib/catalog';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { newOrderNotificationMail, orderConfirmationMail, sendMail } from '@/lib/email';
import { addOrderEvent, CheckoutSchema, createOrder, findCoupon, getOrderByNumber } from '@/lib/orders';
import { cardProvider, startCardPayment } from '@/lib/payments';
import type { AppliedCoupon } from '@/lib/pricing';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';

export type PlaceOrderResult =
  | { ok: true; redirectUrl: string; external: boolean }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; cartChanged?: boolean };

export async function placeOrder(raw: unknown): Promise<PlaceOrderResult> {
  const limited = rateLimit(`checkout:${await clientIp()}`, 8, 10 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά ή καλέστε μας.` };

  // Pre-launch the checkout is closed to the public. The page already hides the form; this is the check that counts.
  const [{ storefront, shop }, admin] = await Promise.all([getSettings(), getAdmin()]);
  if (!storefront.ordersEnabled && !admin) return { ok: false, message: `Οι online παραγγελίες δεν έχουν ανοίξει ακόμη. Για αγορές καλέστε μας στο ${shop.phone}.` };

  const parsed = CheckoutSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors };
  }

  const [settings, customer] = await Promise.all([getSettings(), getCustomer()]);
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
      await db.update(orders).set({ paymentProvider: payment.provider, paymentRef: payment.ref }).where(eq(orders.id, order.id));
      await addOrderEvent(order.id, 'payment', `Ο πελάτης μεταφέρθηκε στη σελίδα πληρωμής (${payment.provider}).`);
      return { ok: true, redirectUrl: payment.redirectUrl, external: true };
    } catch (err) {
      console.error('[checkout] could not start card payment', err);
      await addOrderEvent(order.id, 'payment', 'Δεν ήταν δυνατή η έναρξη της πληρωμής με κάρτα.');
      return { ok: true, redirectUrl: `${orderUrl}&payment=failed`, external: false };
    }
  }

  if (full) {
    const sent = await sendMail(orderConfirmationMail(full, settings));
    await addOrderEvent(order.id, 'email', sent ? `Στάλθηκε e-mail επιβεβαίωσης στο ${order.email}.` : `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${order.email}.`);
  }
  return { ok: true, redirectUrl: `${orderUrl}&placed=1`, external: false };
}

/** Lets the buyer try the card again from the order page after a failed / abandoned payment. */
export async function retryCardPayment(number: string, token: string): Promise<{ ok: true; redirectUrl: string } | { ok: false; message: string }> {
  const limited = rateLimit(`pay:${await clientIp()}`, 6, 10 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.' };

  const order = await getOrderByNumber(number);
  if (!order || order.accessToken !== token) return { ok: false, message: 'Η παραγγελία δεν βρέθηκε.' };
  if (order.paymentMethod !== 'card' || order.paymentStatus === 'paid' || order.status === 'cancelled') return { ok: false, message: 'Η παραγγελία δεν αναμένει πληρωμή.' };
  try {
    const payment = await startCardPayment(order);
    await db.update(orders).set({ paymentProvider: payment.provider, paymentRef: payment.ref }).where(eq(orders.id, order.id));
    return { ok: true, redirectUrl: payment.redirectUrl };
  } catch (err) {
    console.error('[checkout] retry card payment failed', err);
    return { ok: false, message: 'Η πληρωμή με κάρτα δεν είναι διαθέσιμη αυτή τη στιγμή. Καλέστε μας για να ολοκληρώσουμε την παραγγελία.' };
  }
}

export async function checkCoupon(code: string, lines: Array<{ variantId: number; quantity: number }>): Promise<{ coupon: AppliedCoupon | null; error: string | null }> {
  const limited = rateLimit(`coupon:${await clientIp()}`, 15, 10 * 60 * 1000);
  if (!limited.ok) return { coupon: null, error: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.' };
  const resolved = await resolveCartLines(Array.isArray(lines) ? lines.slice(0, 100) : []);
  const subtotal = resolved.reduce((s, l) => s + l.lineTotalCents, 0);
  return findCoupon(String(code ?? '').slice(0, 40), subtotal);
}
