import { NextResponse } from 'next/server';
import { commerceEnabled } from '@/lib/commerce-flag';
import { siteUrl } from '@/lib/payments';
import { findOrderByPayment } from '@/lib/payments/attempts';
import { reportUnmatchedPayment, settleCardPayment } from '@/lib/payments/settle';
import { vivaRetrieveTransaction, vivaTransactionIsOurs } from '@/lib/payments/viva';
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
  // The lookup page, with a message that says what happened (src/app/(store)/order-status/page.tsx): the buyer has no order
  // number yet and no e-mail, so a bare lookup form would leave them guessing whether they were charged.
  //   failed  = the payment did not go through    pending = Viva is still processing it (e.g. IRIS)
  //   review  = money arrived but needs the owner (wrong amount, cancelled order, no matching order)
  const back = (state: 'failed' | 'pending' | 'review') => NextResponse.redirect(`${siteUrl()}/order-status?payment=${state}`);
  if (!/^\d{10,20}$/.test(orderCode)) return home;
  // a transaction id is a UUID: anything else is garbage, not a payment in trouble (and would only cost a call to Viva)
  if (transactionId && !/^[0-9a-f-]{36}$/i.test(transactionId)) return home;

  // A miss here re-reads the transaction from Viva, so throttle by IP to avoid hammering their API.
  if (!(await rateLimit(`viva-return:${await clientIp()}`, 20, 10 * 60 * 1000)).ok) return NextResponse.redirect(`${siteUrl()}/order-status`);
  if (!transactionId || url.searchParams.has('failed')) return back('failed');

  try {
    const tx = await vivaRetrieveTransaction(transactionId);
    // a transaction of another payment source of the same account is not ours (as in the webhook): not settled, not reported
    if (!vivaTransactionIsOurs(tx)) {
      console.warn(`[viva] return for transaction ${transactionId}: payment source ${tx.sourceCode} is not ours, ignored`);
      return back('failed');
    }
    if (tx.paid && tx.orderCode === orderCode) {
      // the checkout may be an older attempt (the buyer retried): the attempt table, then merchantTrns, find the order
      const order = await findOrderByPayment('viva', orderCode, tx.merchantTrns);
      if (!order) {
        await reportUnmatchedPayment({ provider: 'viva', orderCode, transactionId, merchantTrns: tx.merchantTrns, amountCents: tx.amountCents, currency: tx.currency });
        return back('review');
      }
      const outcome = await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents, currency: tx.currency, attemptRef: orderCode });
      // A payment that does not add up, or that belongs to a cancelled or refunded order, is the owner's to sort out: no "success" page and
      // no secret link, whichever of the browser return and the webhook got there first (hence the order's own status too).
      if (order.status === 'cancelled' || order.paymentStatus === 'refunded' || (outcome !== 'paid' && outcome !== 'already_paid' && outcome !== 'paid_after_manual')) return back('review');
      return NextResponse.redirect(`${siteUrl()}/order/${order.number}?t=${order.accessToken}&payment=success`);
    }
    // Viva sends the buyer to the Success URL for a payment that is still pending as well (status A): not a failure
    return back(tx.statusId === 'A' ? 'pending' : 'failed');
  } catch (err) {
    console.error('[viva] return verification failed', err);
    return back('pending'); // Viva could not be asked right now: the webhook may still settle it
  }
}
