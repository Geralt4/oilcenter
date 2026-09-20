import Stripe from 'stripe';

/*
 * Stripe Checkout (hosted page) — https://docs.stripe.com/payments/checkout
 * Webhook endpoint:  {SITE_URL}/api/payments/stripe/webhook   (event: checkout.session.completed)
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

export async function stripeRetrieveSession(sessionId: string) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  return {
    paid: session.payment_status === 'paid',
    amountCents: session.amount_total ?? 0,
    orderId: Number(session.metadata?.orderId ?? 0),
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
  };
}
