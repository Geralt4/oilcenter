import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { settleCardPayment } from '@/lib/payments/settle';
import { vivaRetrieveTransaction, vivaWebhookVerificationKey } from '@/lib/payments/viva';

/** Viva verifies the endpoint once with a GET that must answer {"Key": "<verification key>"}. */
export async function GET() {
  try {
    return NextResponse.json({ Key: await vivaWebhookVerificationKey() });
  } catch (err) {
    console.error('[viva] webhook verification failed', err);
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
}

/**
 * "Transaction Payment Created" (EventTypeId 1796). The payload is treated as a hint only:
 * the transaction is re-read from Viva's API before anything is marked as paid, which also
 * makes a forged webhook harmless.
 */
export async function POST(request: Request) {
  const text = await request.text();
  let payload: { EventTypeId?: number; EventData?: { TransactionId?: string } };
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (payload.EventTypeId !== 1796) return NextResponse.json({ ok: true, ignored: true });

  const transactionId = payload.EventData?.TransactionId ?? '';
  // OrderCode exceeds Number.MAX_SAFE_INTEGER: take it from the raw text, never from the parsed number.
  const orderCode = text.match(/"OrderCode"\s*:\s*"?(\d{10,20})"?/)?.[1] ?? '';
  if (!transactionId || !orderCode) return NextResponse.json({ error: 'missing_fields' }, { status: 400 });

  try {
    const tx = await vivaRetrieveTransaction(transactionId);
    if (tx.paid && tx.orderCode === orderCode) {
      const [order] = await db.select().from(orders).where(and(eq(orders.paymentProvider, 'viva'), eq(orders.paymentRef, orderCode)));
      if (order) await settleCardPayment(order, { provider: 'viva', ref: transactionId, amountCents: tx.amountCents });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[viva] webhook processing failed', err);
    return NextResponse.json({ error: 'retry' }, { status: 500 }); // Viva retries on non-2xx
  }
}
