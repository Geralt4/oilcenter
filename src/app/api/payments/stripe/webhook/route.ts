import { NextResponse } from 'next/server';
import { commerceEnabled } from '@/lib/commerce-flag';
import { addOrderEvent } from '@/lib/orders';
import { findOrderByPayment, setAttemptStatus } from '@/lib/payments/attempts';
import { settleCardPayment } from '@/lib/payments/settle';
import { stripe, stripeConfigured } from '@/lib/payments/stripe';

/** Signature-verified with STRIPE_WEBHOOK_SECRET; needs the RAW body, so it is read with request.text(). */
export async function POST(request: Request) {
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
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

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded' || event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object;
    // The order comes from the checkout history, not from "the latest checkout": a buyer who retried and then paid the
    // earlier page still has to be found. The session metadata is only a hint and is not trusted for the lookup.
    const order = await findOrderByPayment('stripe', session.id);
    if (order) {
      if (event.type === 'checkout.session.async_payment_failed') {
        // a delayed payment (SEPA…) that did not settle: the order is open for another try again
        if (await setAttemptStatus('stripe', session.id, 'failed', null, ['created', 'processing'])) await addOrderEvent(order.id, 'payment', 'Η πληρωμή με καθυστερημένη μέθοδο απέτυχε.');
      } else if (session.payment_status === 'paid') {
        const ref = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;
        await settleCardPayment(order, { provider: 'stripe', ref, amountCents: session.amount_total ?? 0, attemptRef: session.id });
      } else if (event.type === 'checkout.session.completed' && session.payment_status === 'unpaid') {
        // finished by the buyer, money still on its way: no second checkout and no automatic release until it resolves
        if (await setAttemptStatus('stripe', session.id, 'processing', null, ['created'])) await addOrderEvent(order.id, 'payment', 'Η πληρωμή με κάρτα/τράπεζα είναι σε επεξεργασία: δεν έχει εισπραχθεί ακόμη.');
      }
    }
  }
  return NextResponse.json({ received: true });
}
