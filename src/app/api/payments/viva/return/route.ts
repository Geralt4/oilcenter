import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { siteUrl } from '@/lib/payments';
import { settleCardPayment } from '@/lib/payments/settle';
import { vivaRetrieveTransaction } from '@/lib/payments/viva';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * Viva sends the buyer's browser here after Smart Checkout:  ?t=<transactionId>&s=<orderCode>[&failed=1]
 * The query string proves nothing by itself, so the transaction is always re-read from Viva's API.
 *
 * The order's secret link is only handed out once Viva confirms the payment. Without that, an order code alone
 * (it is visible in the buyer's own return URL) would let anyone open a stranger's order page — so a failed or
 * unverifiable return is sent to the order lookup, which requires the order number and the buyer's e-mail.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderCode = url.searchParams.get('s') ?? '';
  const transactionId = url.searchParams.get('t') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  const lookup = NextResponse.redirect(`${siteUrl()}/order-status`);
  if (!/^\d{10,20}$/.test(orderCode)) return home;

  // A miss here re-reads the transaction from Viva, so throttle by IP to avoid hammering their API.
  if (!rateLimit(`viva-return:${await clientIp()}`, 20, 10 * 60 * 1000).ok) return lookup;
  if (!transactionId || url.searchParams.has('failed')) return lookup;

  const [order] = await db.select().from(orders).where(and(eq(orders.paymentProvider, 'viva'), eq(orders.paymentRef, orderCode)));
  if (!order) return lookup;

  try {
    const tx = await vivaRetrieveTransaction(transactionId);
    if (tx.paid && tx.orderCode === orderCode) {
      await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents });
      return NextResponse.redirect(`${siteUrl()}/order/${order.number}?t=${order.accessToken}&payment=success`);
    }
  } catch (err) {
    console.error('[viva] return verification failed', err);
  }
  return lookup;
}
