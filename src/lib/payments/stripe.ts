import Stripe from 'stripe';

/*
 * Stripe Checkout (hosted page) — https://docs.stripe.com/payments/checkout
 * Webhook endpoint:  {SITE_URL}/api/payments/stripe/webhook   (events: checkout.session.completed, …async_payment_succeeded, …async_payment_failed)
 *
 * NOT YET EXERCISED WITH REAL KEYS — test with sk_test_… and `stripe listen` before going live.
 */

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

export async function stripeCreateCheckout(input: {
  amountCents: number;
  orderNumber: string;
  orderId: number;
  email: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; redirectUrl: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    locale: 'el',
    customer_email: input.email,
    client_reference_id: input.orderNumber,
    metadata: { orderId: String(input.orderId), orderNumber: input.orderNumber },
    // One line for the whole order: totals (shipping, COD, coupons) are computed by the shop, not by Stripe.
    line_items: [
      {
        quantity: 1,
        price_data: { currency: 'eur', unit_amount: input.amountCents, product_data: { name: `Παραγγελία ${input.orderNumber} — Oil Center` } },
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 45,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { sessionId: session.id, redirectUrl: session.url };
}

/**
 * Is this Checkout Session one this shop created? stripeCreateCheckout puts the order number in client_reference_id and the
 * order id in metadata.orderId. A session without both (a Payment Link, another site on the same Stripe account) is not ours:
 * it is neither settled nor reported as an unmatched payment. The same idea as vivaTransactionIsOurs for Viva.
 */
export function stripeSessionIsOurs(clientReferenceId: string | null | undefined, orderId: string | number | null | undefined): boolean {
  return Boolean(clientReferenceId) && /^[1-9]\d*$/.test(String(orderId ?? ''));
}

export async function stripeRetrieveSession(sessionId: string) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  return {
    paid: session.payment_status === 'paid',
    /** the buyer finished the checkout but the money is still on its way (SEPA Debit and other delayed methods) */
    processing: session.status === 'complete' && session.payment_status === 'unpaid',
    amountCents: session.amount_total ?? 0,
    currency: session.currency ? session.currency.toUpperCase() : null,
    /** the order number we put on the session when it was created */
    clientReferenceId: session.client_reference_id ?? null,
    orderId: Number(session.metadata?.orderId ?? 0),
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
  };
}
