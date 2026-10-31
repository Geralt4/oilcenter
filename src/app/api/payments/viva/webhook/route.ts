import { NextResponse } from 'next/server';
import { commerceEnabled } from '@/lib/commerce-flag';
import { addOrderEvent } from '@/lib/orders';
import { findOrderByPayment, setAttemptStatus } from '@/lib/payments/attempts';
import { reportUnmatchedPayment, settleCardPayment } from '@/lib/payments/settle';
import { vivaRetrieveTransaction, vivaTransactionIsOurs, vivaWebhookIpAllowed, vivaWebhookVerificationKey } from '@/lib/payments/viva';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const EVENT_PAYMENT_CREATED = 1796;
const EVENT_PAYMENT_FAILED = 1798;

/** Viva verifies the endpoint once with a GET that must answer {"Key": "<verification key>"}. */
export async function GET() {
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
  try {
    return NextResponse.json({ Key: await vivaWebhookVerificationKey() });
  } catch (err) {
    console.error('[viva] webhook verification failed', err);
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
}

/**
 * "Transaction Payment Created" (EventTypeId 1796) and "Transaction Failed" (1798). The payload is treated as a hint only:
 * the transaction is re-read from Viva's API before anything is recorded, which also makes a forged webhook harmless.
 * Viva retries any non-2xx answer once an hour for a day, so every outcome here is safe to repeat.
 */
export async function POST(request: Request) {
  if (!commerceEnabled()) return NextResponse.json({ error: 'commerce_disabled' }, { status: 503 });
  const text = await request.text();
  let payload: { EventTypeId?: number; EventData?: { TransactionId?: string; StatusId?: string } };
  try {
    const parsed: unknown = JSON.parse(text);
    // "null", a number or an array parse fine but are not an event
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NextResponse.json({ error: 'bad_json' }, { status: 400 });
    payload = parsed;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  const ip = await clientIp();
  if (!vivaWebhookIpAllowed(ip)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const eventType = payload.EventTypeId;
  if (eventType !== EVENT_PAYMENT_CREATED && eventType !== EVENT_PAYMENT_FAILED) return NextResponse.json({ ok: true, ignored: true });

  const transactionId = typeof payload.EventData?.TransactionId === 'string' ? payload.EventData.TransactionId : '';
  // OrderCode exceeds Number.MAX_SAFE_INTEGER: take it from the raw text, never from the parsed number.
  const orderCode = text.match(/"OrderCode"\s*:\s*"?(\d{10,20})"?/)?.[1] ?? '';
  if (!transactionId || !orderCode) return NextResponse.json({ error: 'missing_fields' }, { status: 400 });

  // Every accepted event costs a call to Viva's API: a flood of well-formed ones must not turn into a flood of calls.
  const limited = await rateLimit(`viva-webhook:${ip}`, 60, 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });

  try {
    const tx = await vivaRetrieveTransaction(transactionId);
    // Money taken through another channel of the same Viva account is reported here too: it is not ours.
    if (!vivaTransactionIsOurs(tx)) {
      console.warn(`[viva] transaction ${transactionId} belongs to payment source ${tx.sourceCode}, not ours: ignored`);
      return NextResponse.json({ ok: true, ignored: true });
    }
    // Viva says the payment finished but the read-back does not: Viva's own data lags for a moment. Answering 200 would end
    // the retries and could lose the payment (a buyer who closed the tab is never settled), so ask for another delivery.
    if (eventType === EVENT_PAYMENT_CREATED && !tx.paid && payload.EventData?.StatusId === 'F') {
      console.warn(`[viva] webhook ${transactionId} reports a finished payment but the read-back says ${tx.statusId || 'nothing'}: asking Viva to retry`);
      return NextResponse.json({ error: 'retry' }, { status: 500 });
    }
    if (tx.orderCode !== orderCode) return NextResponse.json({ ok: true });
    const order = await findOrderByPayment('viva', orderCode, tx.merchantTrns);
    if (!order) {
      // Money for a checkout we cannot match to an order is kept and the shop is told; a failed one is only a log line.
      if (tx.paid) await reportUnmatchedPayment({ provider: 'viva', orderCode, transactionId, merchantTrns: tx.merchantTrns, amountCents: tx.amountCents, currency: tx.currency });
      else console.warn(`[viva] failed transaction ${transactionId} for order code ${orderCode} matches no order`);
      return NextResponse.json({ ok: true });
    }

    if (eventType === EVENT_PAYMENT_CREATED) {
      if (tx.paid) await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents, currency: tx.currency, attemptRef: orderCode });
    } else if (!tx.paid && order.paymentStatus !== 'paid') {
      // One event per checkout: the status move is the guard against Viva repeating the notification. The order itself is
      // left as it is: the buyer may retry, or still pay (a later 1796 settles it normally).
      if (await setAttemptStatus('viva', orderCode, 'failed', transactionId, ['created'])) {
        await addOrderEvent(order.id, 'payment', `Η πληρωμή με κάρτα απέτυχε (viva, αναφορά ${transactionId}).`);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[viva] webhook processing failed', err);
    return NextResponse.json({ error: 'retry' }, { status: 500 }); // Viva retries on non-2xx
  }
}
