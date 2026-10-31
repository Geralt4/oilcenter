import { mailOutbox, type MailKind } from '@/lib/db/schema';
import type { Executor } from '@/lib/payments/attempts';

/*
 * The writing half of the payment mail queue (the sending half is mail-delivery.ts). It only inserts rows and imports no
 * mail templates, so lib/orders.ts can call it from inside the payment transaction without an import cycle.
 */

/** Which mails a payment outcome leads to: the same mapping settleCardPayment used when it sent them directly. */
const MAILS: Partial<Record<string, MailKind[]>> = {
  paid: ['order_confirmation', 'order_paid_notice'],
  // the buyer is told (marking it paid by hand never mailed them) and the owner is told too
  paid_after_manual: ['order_confirmation', 'payment_alert'],
  paid_after_refund: ['payment_alert'],
  duplicate_payment: ['payment_alert'],
  amount_mismatch: ['payment_alert'],
  currency_mismatch: ['payment_alert'],
  late_cancelled: ['payment_alert'],
};

/** Call inside the transaction that records the payment: the mails are saved together with it or not at all. */
export async function enqueuePaymentMails(orderId: number, outcome: string, exec: Executor): Promise<void> {
  const kinds = MAILS[outcome];
  if (!kinds) return; // already_paid, already_flagged, unknown_order: nothing new happened
  await exec.insert(mailOutbox).values(kinds.map((kind) => ({ kind, orderId, problem: kind === 'payment_alert' ? outcome : null })));
}

/** Call inside the transaction that saves an unmatched payment. */
export async function enqueueUnmatchedPaymentMail(unmatchedId: number, exec: Executor): Promise<void> {
  await exec.insert(mailOutbox).values({ kind: 'unmatched_payment', unmatchedId });
}
