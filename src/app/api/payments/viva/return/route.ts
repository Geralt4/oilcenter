import { NextResponse } from 'next/server';
import { commerceEnabled } from '@/lib/commerce-flag';
import { siteUrl } from '@/lib/payments';
import { findOrderByPayment } from '@/lib/payments/attempts';
import { reportUnmatchedPayment, settleCardPayment } from '@/lib/payments/settle';
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
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
  const url = new URL(request.url);
  const orderCode = url.searchParams.get('s') ?? '';
  const transactionId = url.searchParams.get('t') ?? '';
  const home = NextResponse.redirect(`${siteUrl()}/`);
  const lookup = NextResponse.redirect(`${siteUrl()}/order-status`);
  if (!/^\d{10,20}$/.test(orderCode)) return home;

  // A miss here re-reads the transaction from Viva, so throttle by IP to avoid hammering their API.
  if (!(await rateLimit(`viva-return:${await clientIp()}`, 20, 10 * 60 * 1000)).ok) return lookup;
  if (!transactionId || url.searchParams.has('failed')) return lookup;

  try {
    const tx = await vivaRetrieveTransaction(transactionId);
    if (tx.paid && tx.orderCode === orderCode) {
      // the checkout may be an older attempt (the buyer retried): the attempt table, then merchantTrns, find the order
      const order = await findOrderByPayment('viva', orderCode, tx.merchantTrns);
      if (!order) {
        await reportUnmatchedPayment({ provider: 'viva', orderCode, transactionId, merchantTrns: tx.merchantTrns, amountCents: tx.amountCents, currency: tx.currency });
        return lookup;
      }
      const outcome = await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents, currency: tx.currency, attemptRef: orderCode });
      // a payment that does not add up (or lands on a cancelled order) is the owner's to sort out: no "success" page, no secret link
      if (outcome !== 'paid' && outcome !== 'already_paid') return lookup;
      return NextResponse.redirect(`${siteUrl()}/order/${order.number}?t=${order.accessToken}&payment=success`);
    }
  } catch (err) {
    console.error('[viva] return verification failed', err);
  }
  return lookup;
}
