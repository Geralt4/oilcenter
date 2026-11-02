import { NextResponse } from 'next/server';
import { commerceEnabled } from '@/lib/commerce-flag';
import { addOrderEvent } from '@/lib/orders';
import { siteUrl } from '@/lib/payments';
import { findOrderByPayment, setAttemptStatus } from '@/lib/payments/attempts';
import { reportUnmatchedPayment, settleCardPayment } from '@/lib/payments/settle';
import { stripeRetrieveSession, stripeSessionIsOurs } from '@/lib/payments/stripe';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * success_url of the Checkout Session. The session is re-read from Stripe; the URL itself is not trusted.
 *
 * The order's secret link is only handed out once Stripe confirms the payment on an order that is still a normal sale.
 * Anything else goes to the order-status page, so a session id alone cannot open a stranger's order (as in the Viva
 * return route).
 */
export async function GET(request: Request) {
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
  const sessionId = new URL(request.url).searchParams.get('session_id') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  // The same states as the Viva return: failed = the payment did not go through, pending = Stripe is still processing
  // it, review = money arrived but needs the owner (wrong amount, cancelled or refunded order, no matching order).
  const back = (state: 'failed' | 'pending' | 'review') => NextResponse.redirect(`${siteUrl()}/order-status?payment=${state}`);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return home;

  // Every accepted request re-reads the session from Stripe, so throttle by address to avoid hammering their API.
  if (!(await rateLimit(`stripe-return:${await clientIp()}`, 20, 10 * 60 * 1000)).ok) return NextResponse.redirect(`${siteUrl()}/order-status`);

  try {
    const session = await stripeRetrieveSession(sessionId);
    // through the checkout history: the buyer may have paid an earlier checkout than the latest one
    const order = await findOrderByPayment('stripe', sessionId);
    if (!order) {
      // not paid, or not a checkout this shop created (see stripeSessionIsOurs): nothing to record
      if (!session.paid || !stripeSessionIsOurs(session.clientReferenceId, session.orderId)) return home;
      // paid, one of ours, but no order owns this checkout: kept for the owner (the webhook reports the same row), and the buyer is told
      // to wait for the shop instead of seeing the home page as if nothing happened
      await reportUnmatchedPayment({ provider: 'stripe', orderCode: sessionId, transactionId: session.paymentIntent ?? sessionId, merchantTrns: session.clientReferenceId, amountCents: session.amountCents, currency: session.currency });
      return back('review');
    }
    if (session.paid) {
      // attemptRef: the checkout that was paid, so a payment on an order already marked paid by hand is recognised (as with Viva)
      const outcome = await settleCardPayment(order, { provider: 'stripe', ref: session.paymentIntent ?? sessionId, amountCents: session.amountCents, currency: session.currency, attemptRef: sessionId });
      // A payment that does not add up, or that belongs to a cancelled or refunded order, is the owner's to sort out:
      // no «thank you» page and no secret link, whichever of the browser return and the webhook got there first (hence
      // the order's own status too). The Viva route does the same.
      const settled = outcome === 'paid' || outcome === 'already_paid' || outcome === 'paid_after_manual';
      if (order.status === 'cancelled' || order.paymentStatus === 'refunded' || !settled) return back('review');
      return NextResponse.redirect(`${siteUrl()}/order/${order.number}?t=${order.accessToken}&payment=success`);
    }
    // a delayed payment method is not a failure: «pay again» here would charge the buyer twice once it settles
    if (session.processing && (await setAttemptStatus('stripe', sessionId, 'processing', null, ['created']))) await addOrderEvent(order.id, 'payment', 'Η πληρωμή με κάρτα/τράπεζα είναι σε επεξεργασία: δεν έχει εισπραχθεί ακόμη.');
    return back(session.processing ? 'pending' : 'failed');
  } catch (err) {
    console.error('[stripe] return verification failed', err);
    return back('pending'); // Stripe could not be asked right now: the webhook may still settle it
  }
}
