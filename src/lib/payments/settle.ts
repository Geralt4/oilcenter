import { orderConfirmationMail, paymentAlertMail, sendMail } from '@/lib/email';
import { addOrderEvent, getOrderByNumber, recordPayment, type PaymentInfo, type PaymentOutcome } from '@/lib/orders';
import { getSettings } from '@/lib/settings.server';

const PROBLEMS: Partial<Record<PaymentOutcome, string>> = {
  amount_mismatch: 'Το ποσό που εισπράχθηκε δεν ταιριάζει με το σύνολο της παραγγελίας. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  currency_mismatch: 'Η πληρωμή έγινε σε νόμισμα διαφορετικό από το ευρώ. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  duplicate_payment: 'Η παραγγελία πληρώθηκε δύο φορές, με δύο διαφορετικές πληρωμές. Επιστρέψτε τα χρήματα της δεύτερης.',
  late_cancelled: 'Εισπράχθηκε πληρωμή για παραγγελία που είχε ήδη ακυρωθεί. Επιστρέψτε τα χρήματα ή ξανανοίξτε την παραγγελία.',
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

  if (outcome === 'paid') {
    const sent = await sendMail(orderConfirmationMail(full, settings));
    await addOrderEvent(order.id, 'email', sent ? `Στάλθηκε e-mail επιβεβαίωσης στο ${full.email}.` : `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${full.email}.`);
    return outcome;
  }
  const alerted = await sendMail(paymentAlertMail(full, PROBLEMS[outcome] ?? outcome, settings));
  if (!alerted) await addOrderEvent(order.id, 'email', 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης προς το κατάστημα για την πληρωμή.');
  return outcome;
}
