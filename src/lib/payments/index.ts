import { siteUrl } from '@/lib/site-url';
import { stripeConfigured, stripeCreateCheckout } from './stripe';
import { vivaConfigured, vivaCreateOrder } from './viva';

export type CardProvider = 'viva' | 'stripe';

/** Viva wins when both are configured: it is the gateway Greek shops and their accountants expect. */
export function cardProvider(): CardProvider | null {
  if (vivaConfigured()) return 'viva';
  if (stripeConfigured()) return 'stripe';
  return null;
}

export { siteUrl };

export async function startCardPayment(order: {
  id: number;
  number: string;
  accessToken: string;
  totalCents: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}): Promise<{ provider: CardProvider; ref: string; redirectUrl: string }> {
  const provider = cardProvider();
  if (!provider) throw new Error('No card payment provider is configured');

  if (provider === 'viva') {
    const { orderCode, redirectUrl } = await vivaCreateOrder({
      amountCents: order.totalCents,
      orderNumber: order.number,
      email: order.email,
      fullName: `${order.firstName} ${order.lastName}`.trim(),
      phone: order.phone,
    });
    return { provider, ref: orderCode, redirectUrl };
  }

  const orderUrl = `${siteUrl()}/order/${order.number}?t=${order.accessToken}`;
  const { sessionId, redirectUrl } = await stripeCreateCheckout({
    amountCents: order.totalCents,
    orderNumber: order.number,
    orderId: order.id,
    email: order.email,
    successUrl: `${siteUrl()}/api/payments/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${orderUrl}&payment=cancelled`,
  });
  return { provider, ref: sessionId, redirectUrl };
}
