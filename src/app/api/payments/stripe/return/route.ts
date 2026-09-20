import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { siteUrl } from '@/lib/payments';
import { settleCardPayment } from '@/lib/payments/settle';
import { stripeRetrieveSession } from '@/lib/payments/stripe';

/** success_url of the Checkout Session. The session is re-read from Stripe; the URL itself is not trusted. */
export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('session_id') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return home;

  try {
    const session = await stripeRetrieveSession(sessionId);
    const [order] = await db.select().from(orders).where(eq(orders.id, session.orderId));
    if (!order || order.paymentRef !== sessionId) return home;
    const orderUrl = `${siteUrl()}/order/${order.number}?t=${order.accessToken}`;
    if (session.paid) {
      await settleCardPayment(order, { provider: 'stripe', ref: session.paymentIntent ?? sessionId, amountCents: session.amountCents });
      return NextResponse.redirect(`${orderUrl}&payment=success`);
    }
    return NextResponse.redirect(`${orderUrl}&payment=failed`);
  } catch (err) {
    console.error('[stripe] return verification failed', err);
    return home;
  }
}
