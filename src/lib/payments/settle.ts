import { orderConfirmationMail, orderPaidNotificationMail, paymentAlertMail, sendMail, unmatchedPaymentMail } from '@/lib/email';
import { addOrderEvent, getOrderByNumber, recordPayment, type PaymentInfo, type PaymentOutcome } from '@/lib/orders';
import { getSettings } from '@/lib/settings.server';
import { recordUnmatchedPayment } from './attempts';

const PROBLEMS: Partial<Record<PaymentOutcome, string>> = {
  amount_mismatch: 'Το ποσό που εισπράχθηκε δεν ταιριάζει με το σύνολο της παραγγελίας. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  currency_mismatch: 'Η πληρωμή έγινε σε νόμισμα διαφορετικό από το ευρώ. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  paid_after_manual: 'Ήρθε η πληρωμή του πάροχου για παραγγελία που είχατε σημειώσει εξοφλημένη χειροκίνητα. Πιθανότατα είναι τα ίδια χρήματα: αν είχατε εισπράξει και με άλλον τρόπο, επιστρέψτε το ένα από τα δύο.',
  paid_after_refund: 'Ήρθε η πληρωμή του πάροχου για παραγγελία που είχατε σημειώσει εξοφλημένη χειροκίνητα και μετά επιστραφείσα. Ελέγξτε στον πάροχο πληρωμών αν αυτή η πληρωμή έχει ήδη επιστραφεί· αν όχι, επιστρέψτε την.',
  duplicate_payment: 'Η παραγγελία πληρώθηκε δύο φορές, με δύο διαφορετικές πληρωμές. Επιστρέψτε τα χρήματα της δεύτερης στον πάροχο πληρωμών και πατήστε «Το χειρίστηκα» (όχι «Επιστροφή χρημάτων», που αφορά ολόκληρη την παραγγελία).',
  late_cancelled: 'Εισπράχθηκε πληρωμή για παραγγελία που είχε ήδη ακυρωθεί. Επιστρέψτε τα χρήματα στον πάροχο πληρωμών (ή επικοινωνήστε με τον πελάτη) και σημειώστε «Επιστροφή χρημάτων».',
};

/**
 * Single place where a verified gateway payment lands, whether it arrived via the buyer's browser
 * return or via a webhook. recordPayment() is idempotent, so the confirmation e-mail goes out once, and anything that
 * does not add up (wrong amount, wrong currency, a cancelled order) goes to the owner instead of to the buyer.
 */
export async function settleCardPayment(order: { id: number; number: string }, info: PaymentInfo): Promise<PaymentOutcome> {
  const outcome = await recordPayment(order.id, info);
  if (outcome === 'already_paid' || outcome === 'unknown_order' || outcome === 'already_flagged') return outcome;
  const [full, settings] = await Promise.all([getOrderByNumber(order.number), getSettings()]);
  if (!full) return outcome;

  // The buyer paid online and sees the success page: they get the confirmation. This includes the payment that finally arrives for
  // an order the owner had already marked paid by hand (marking it never mailed the customer); the owner is still told below.
  if (outcome === 'paid' || outcome === 'paid_after_manual') {
    const sent = await sendMail(orderConfirmationMail(full, settings));
    await addOrderEvent(order.id, 'email', sent ? `Στάλθηκε e-mail επιβεβαίωσης στο ${full.email}.` : `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${full.email}.`);
  }
  if (outcome === 'paid') {
    // the shop was told at checkout that this order awaited payment: now it is told that it was paid
    if (!(await sendMail(orderPaidNotificationMail(full, settings)))) await addOrderEvent(order.id, 'email', 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης προς το κατάστημα για την πληρωμή.');
    return outcome;
  }
  const alerted = await sendMail(paymentAlertMail(full, PROBLEMS[outcome] ?? outcome, settings));
  if (!alerted) await addOrderEvent(order.id, 'email', 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης προς το κατάστημα για την πληρωμή.');
  return outcome;
}

/**
 * A paid transaction for a checkout that belongs to no order. Kept in unmatched_payments (shown on the admin dashboard) and
 * mailed to the shop once; a repeated webhook, or the buyer's browser coming back as well, finds the row and stays quiet.
 */
export async function reportUnmatchedPayment(info: { provider: string; orderCode: string; transactionId: string; merchantTrns: string | null; amountCents: number; currency: string | null }): Promise<void> {
  if (!(await recordUnmatchedPayment(info))) return;
  console.warn(`[${info.provider}] PAID transaction ${info.transactionId} for order code ${info.orderCode} (merchantTrns ${info.merchantTrns ?? '-'}) matches no order — saved to unmatched_payments`);
  await sendMail(unmatchedPaymentMail(info, await getSettings()));
}
