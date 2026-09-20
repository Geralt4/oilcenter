import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { settleCardPayment } from '@/lib/payments/settle';
import { stripe, stripeConfigured } from '@/lib/payments/stripe';

/** Signature-verified with STRIPE_WEBHOOK_SECRET; needs the RAW body, so it is read with request.text(). */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeConfigured() || !secret) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const signature = request.headers.get('stripe-signature') ?? '';
  const body = await request.text();
  let event;
  try {
    event = await stripe().webhooks.constructEventAsync(body, signature, secret);
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const orderId = Number(session.metadata?.orderId ?? 0);
    if (session.payment_status === 'paid' && orderId) {
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      if (order && order.paymentRef === session.id) {
        const ref = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;
        await settleCardPayment(order, { provider: 'stripe', ref, amountCents: session.amount_total ?? 0 });
      }
    }
  }
  return NextResponse.json({ received: true });
}
