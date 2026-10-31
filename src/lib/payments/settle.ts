import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { unmatchedPayments } from '@/lib/db/schema';
import { recordPayment, type PaymentInfo, type PaymentOutcome } from '@/lib/orders';
import { recordUnmatchedPayment } from './attempts';
import { deliverPendingMail } from './mail-delivery';

/**
 * Single place where a verified gateway payment lands, whether it arrived via the buyer's browser
 * return or via a webhook. recordPayment() is idempotent and saves the mails this payment leads to (the buyer's confirmation,
 * the shop's notice or alert) in the same transaction; sending them happens here, afterwards. Anything that does not add up
 * (wrong amount, wrong currency, a cancelled order) goes to the owner instead of to the buyer (see mail-queue.ts).
 *
 * Mails are flushed on EVERY call, also when the payment was already recorded: a crash between the commit and the send, or a
 * mail service that was down, is repaired by the gateway's own retry or by the periodic sweep (instrumentation.ts).
 */
export async function settleCardPayment(order: { id: number; number: string }, info: PaymentInfo): Promise<PaymentOutcome> {
  const outcome = await recordPayment(order.id, info);
  await deliverPendingMail({ orderId: order.id });
  return outcome;
}

/**
 * A paid transaction for a checkout that belongs to no order. Kept in unmatched_payments (shown on the admin dashboard) and
 * mailed to the shop once; a repeated webhook, or the buyer's browser coming back as well, finds the row and stays quiet.
 */
export async function reportUnmatchedPayment(info: { provider: string; orderCode: string; transactionId: string; merchantTrns: string | null; amountCents: number; currency: string | null }): Promise<void> {
  if (await recordUnmatchedPayment(info)) {
    console.warn(`[${info.provider}] PAID transaction ${info.transactionId} for order code ${info.orderCode} (merchantTrns ${info.merchantTrns ?? '-'}) matches no order — saved to unmatched_payments`);
  }
  // also when the row already existed: the mail of an earlier call may not have gone out
  const [row] = await db.select({ id: unmatchedPayments.id }).from(unmatchedPayments).where(and(eq(unmatchedPayments.provider, info.provider), eq(unmatchedPayments.transactionId, info.transactionId)));
  if (row) await deliverPendingMail({ unmatchedId: row.id });
}
