import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { commerceEnabled } from '@/lib/commerce-flag';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { siteUrl } from '@/lib/payments';
import { settleCardPayment } from '@/lib/payments/settle';
import { stripeRetrieveSession } from '@/lib/payments/stripe';

/** success_url of the Checkout Session. The session is re-read from Stripe; the URL itself is not trusted. */
export async function GET(request: Request) {
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
  const sessionId = new URL(request.url).searchParams.get('session_id') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return home;

  try {
    const session = await stripeRetrieveSession(sessionId);
    const [order] = await db.select().from(orders).where(eq(orders.id, session.orderId));
    if (!order || order.paymentRef !== sessionId) return home;
    const orderUrl = `${siteUrl()}/order/${order.number}?t=${order.accessToken}`;
    if (session.paid) {
      // attemptRef: the checkout that was paid, so a payment on an order already marked paid by hand is recognised (as with Viva)
      const outcome = await settleCardPayment(order, { provider: 'stripe', ref: session.paymentIntent ?? sessionId, amountCents: session.amountCents, attemptRef: sessionId });
      // a payment that does not add up, or that belongs to a cancelled or refunded order, must not get the "thank you" page
      // (the Viva route does the same)
      const settled = outcome === 'paid' || outcome === 'already_paid' || outcome === 'paid_after_manual';
      return NextResponse.redirect(order.status === 'cancelled' || order.paymentStatus === 'refunded' || !settled ? orderUrl : `${orderUrl}&payment=success`);
    }
    // a delayed payment method is not a failure: «pay again» here would charge the buyer twice once it settles
    return NextResponse.redirect(`${orderUrl}&payment=${session.processing ? 'pending' : 'failed'}`);
  } catch (err) {
    console.error('[stripe] return verification failed', err);
    return home;
  }
}
