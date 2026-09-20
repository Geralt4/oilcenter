import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { siteUrl } from '@/lib/payments';
import { settleCardPayment } from '@/lib/payments/settle';
import { vivaRetrieveTransaction } from '@/lib/payments/viva';

/**
 * Viva sends the buyer's browser here after Smart Checkout:  ?t=<transactionId>&s=<orderCode>[&failed=1]
 * The query string proves nothing by itself, so the transaction is always re-read from Viva's API.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderCode = url.searchParams.get('s') ?? '';
  const transactionId = url.searchParams.get('t') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  if (!/^\d{10,20}$/.test(orderCode)) return home;

  const [order] = await db.select().from(orders).where(and(eq(orders.paymentProvider, 'viva'), eq(orders.paymentRef, orderCode)));
  if (!order) return home;
  const orderUrl = `${siteUrl()}/order/${order.number}?t=${order.accessToken}`;

  if (transactionId && !url.searchParams.has('failed')) {
    try {
      const tx = await vivaRetrieveTransaction(transactionId);
      if (tx.paid && tx.orderCode === orderCode) {
        await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents });
        return NextResponse.redirect(`${orderUrl}&payment=success`);
      }
    } catch (err) {
      console.error('[viva] return verification failed', err);
    }
  }
  return NextResponse.redirect(`${orderUrl}&payment=failed`);
}
