import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mailOutbox, orders, unmatchedPayments } from '@/lib/db/schema';
import { orderConfirmationMail, orderPaidNotificationMail, paymentAlertMail, sendMail, unmatchedPaymentMail } from '@/lib/email';
import { addOrderEvent, type PaymentOutcome } from '@/lib/orders';
import { getSettings } from '@/lib/settings.server';

/*
 * The sending half of the payment mail queue (rows are written by mail-queue.ts inside the payment transaction).
 *
 * At-least-once: a crash after the mail left but before the row is marked sent sends it once more. A row is claimed with one
 * conditional UPDATE, so the browser return, the webhook and the periodic sweep cannot all send the same mail.
 */

const MAX_ATTEMPTS = 8;
const CLAIM_TTL_MS = 10 * 60 * 1000;

const PROBLEMS: Partial<Record<PaymentOutcome, string>> = {
  amount_mismatch: 'Το ποσό που εισπράχθηκε δεν ταιριάζει με το σύνολο της παραγγελίας. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  currency_mismatch: 'Η πληρωμή έγινε σε νόμισμα διαφορετικό από το ευρώ. Η παραγγελία δεν σημειώθηκε ως πληρωμένη.',
  paid_after_manual: 'Ήρθε η πληρωμή του πάροχου για παραγγελία που είχατε σημειώσει εξοφλημένη χειροκίνητα. Πιθανότατα είναι τα ίδια χρήματα: αν είχατε εισπράξει και με άλλον τρόπο, επιστρέψτε το ένα από τα δύο.',
  paid_after_refund: 'Ήρθε η πληρωμή του πάροχου για παραγγελία που είχατε σημειώσει εξοφλημένη χειροκίνητα και μετά επιστραφείσα. Ελέγξτε στον πάροχο πληρωμών αν αυτή η πληρωμή έχει ήδη επιστραφεί· αν όχι, επιστρέψτε την.',
  duplicate_payment: 'Η παραγγελία πληρώθηκε δύο φορές, με δύο διαφορετικές πληρωμές. Επιστρέψτε τα χρήματα της δεύτερης στον πάροχο πληρωμών και πατήστε «Το χειρίστηκα» (όχι «Επιστροφή χρημάτων», που αφορά ολόκληρη την παραγγελία).',
  late_cancelled: 'Εισπράχθηκε πληρωμή για παραγγελία που είχε ήδη ακυρωθεί. Επιστρέψτε τα χρήματα στον πάροχο πληρωμών (ή επικοινωνήστε με τον πελάτη) και σημειώστε «Επιστροφή χρημάτων».',
};

const SHOP_FAILURE = 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης προς το κατάστημα για την πληρωμή.';

type Row = typeof mailOutbox.$inferSelect;

/** Builds and sends one claimed row. Returns whether the mail went out; the caller records the result. */
async function sendRow(row: Row): Promise<{ sent: boolean; successEvent?: string; failureEvent: string }> {
  const settings = await getSettings();
  if (row.kind === 'unmatched_payment') {
    const [u] = row.unmatchedId ? await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.id, row.unmatchedId)) : [];
    if (!u) return { sent: true, failureEvent: '' }; // the payment row is gone: nothing left to tell
    return { sent: await sendMail(unmatchedPaymentMail(u, settings)), failureEvent: '' };
  }
  const order = row.orderId ? await db.query.orders.findFirst({ where: eq(orders.id, row.orderId), with: { items: true, events: true } }) : undefined;
  if (!order) return { sent: true, failureEvent: '' };
  if (row.kind === 'order_confirmation') {
    return {
      sent: await sendMail(orderConfirmationMail(order, settings)),
      successEvent: `Στάλθηκε e-mail επιβεβαίωσης στο ${order.email}.`,
      failureEvent: `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${order.email}.`,
    };
  }
  if (row.kind === 'order_paid_notice') return { sent: await sendMail(orderPaidNotificationMail(order, settings)), failureEvent: SHOP_FAILURE };
  const problem = row.problem ?? '';
  return { sent: await sendMail(paymentAlertMail(order, PROBLEMS[problem as PaymentOutcome] ?? problem, settings)), failureEvent: SHOP_FAILURE };
}

async function deliverRow(id: number): Promise<boolean> {
  const now = new Date();
  // the claim: only one caller gets the row back
  const [row] = await db
    .update(mailOutbox)
    .set({ claimedAt: now })
    .where(and(eq(mailOutbox.id, id), isNull(mailOutbox.sentAt), isNull(mailOutbox.givenUpAt), or(isNull(mailOutbox.claimedAt), lt(mailOutbox.claimedAt, new Date(now.getTime() - CLAIM_TTL_MS)))))
    .returning();
  if (!row) return false;

  let result: Awaited<ReturnType<typeof sendRow>>;
  let error: string | null = null;
  try {
    result = await sendRow(row);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    result = { sent: false, failureEvent: row.kind === 'order_confirmation' ? 'ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης.' : SHOP_FAILURE };
  }

  if (result.sent) {
    await db.update(mailOutbox).set({ sentAt: new Date(), claimedAt: null, lastError: null }).where(eq(mailOutbox.id, id));
    if (row.orderId && result.successEvent) await addOrderEvent(row.orderId, 'email', result.successEvent);
    return true;
  }

  const attempts = row.attempts + 1;
  const final = attempts >= MAX_ATTEMPTS;
  await db
    .update(mailOutbox)
    .set({ attempts, claimedAt: null, lastError: error ?? 'not sent (see the mail log)', givenUpAt: final ? new Date() : null })
    .where(eq(mailOutbox.id, id));
  // the timeline says it at the first failure and again when the shop stops trying; the attempts in between stay quiet
  if (row.orderId && result.failureEvent && (attempts === 1 || final)) {
    await addOrderEvent(row.orderId, 'email', `${result.failureEvent} ${final ? 'Δεν θα ξαναδοκιμαστεί.' : 'Θα ξαναδοκιμαστεί.'}`);
  }
  if (final) console.error(`[mail] giving up on queued mail ${row.id} (${row.kind}) after ${attempts} attempts`);
  return false;
}

/** Sends the pending mails (of one order, of one unmatched payment, or all of them). Never throws. Returns how many went out. */
export async function deliverPendingMail(filter: { orderId?: number; unmatchedId?: number } = {}): Promise<number> {
  try {
    const stale = new Date(Date.now() - CLAIM_TTL_MS);
    const pending = await db
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(
        and(
          isNull(mailOutbox.sentAt),
          isNull(mailOutbox.givenUpAt),
          or(isNull(mailOutbox.claimedAt), lt(mailOutbox.claimedAt, stale)),
          filter.orderId !== undefined ? eq(mailOutbox.orderId, filter.orderId) : undefined,
          filter.unmatchedId !== undefined ? eq(mailOutbox.unmatchedId, filter.unmatchedId) : undefined,
        ),
      )
      .orderBy(mailOutbox.id)
      .limit(50);
    let sent = 0;
    for (const { id } of pending) {
      try {
        if (await deliverRow(id)) sent++;
      } catch (err) {
        console.error(`[mail] queued mail ${id} failed unexpectedly`, err);
      }
    }
    return sent;
  } catch (err) {
    console.error('[mail] delivery of queued mail failed', err);
    return 0;
  }
}
