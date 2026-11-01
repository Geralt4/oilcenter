import { and, eq, gte, isNotNull, isNull, lt, lte, or, count } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mailOutbox, orders, unmatchedPayments, type MailKind } from '@/lib/db/schema';
import { orderCancelledNotificationMail, orderConfirmationMail, orderPaidNotificationMail, paymentAlertMail, sendMail, unmatchedPaymentMail } from '@/lib/email';
import { addOrderEvent, type PaymentOutcome } from '@/lib/orders';
import { getSettings } from '@/lib/settings.server';

/*
 * The sending half of the payment mail queue (rows are written by mail-queue.ts inside the payment transaction).
 *
 * At-least-once: a crash after the mail left but before the row is marked sent sends it once more. A row is claimed with one
 * conditional UPDATE, so the browser return, the webhook and the periodic sweep cannot all send the same mail.
 *
 * A failed attempt waits before the next one (back-off): 1, 5, 15 and 60 minutes, then every hour. A mail is given up at the
 * 27th failure: 23.4 hours of waiting after the first, plus up to 10 minutes per wait because a due retry is picked up by the
 * next sweep. So a mail outage or a rejected sender has about a day to be fixed before a confirmation or an alert is dropped.
 * Settle calls and the sweep both honour the wait, so a burst of gateway retries cannot use up the attempts.
 */

const MAX_ATTEMPTS = 27;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const BACKOFF_MINUTES = [1, 5, 15, 60];
/** how long to wait after the `attempts`-th failed attempt (1-based) */
export const retryDelayMs = (attempts: number) => (BACKOFF_MINUTES[attempts - 1] ?? 60) * 60 * 1000;
/** the dashboard counts mails given up within this many days */
export const GIVEN_UP_WINDOW_DAYS = 30;

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
  if (row.kind === 'order_cancelled_notice') {
    return { sent: await sendMail(orderCancelledNotificationMail(order, settings)), failureEvent: 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης ακύρωσης προς το κατάστημα.' };
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
    .where(
      and(
        eq(mailOutbox.id, id),
        isNull(mailOutbox.sentAt),
        isNull(mailOutbox.givenUpAt),
        or(isNull(mailOutbox.nextAttemptAt), lte(mailOutbox.nextAttemptAt, now)),
        or(isNull(mailOutbox.claimedAt), lt(mailOutbox.claimedAt, new Date(now.getTime() - CLAIM_TTL_MS))),
      ),
    )
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
    .set({
      attempts,
      claimedAt: null,
      lastError: error ?? 'not sent (see the mail log)',
      givenUpAt: final ? new Date() : null,
      nextAttemptAt: final ? null : new Date(Date.now() + retryDelayMs(attempts)),
    })
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
    const now = new Date();
    const stale = new Date(now.getTime() - CLAIM_TTL_MS);
    const pending = await db
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(
        and(
          isNull(mailOutbox.sentAt),
          isNull(mailOutbox.givenUpAt),
          or(isNull(mailOutbox.nextAttemptAt), lte(mailOutbox.nextAttemptAt, now)),
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

/** How many payment mails were given up in the last GIVEN_UP_WINDOW_DAYS days (shown on the admin dashboard checklist). */
export async function countGivenUpMails(): Promise<number> {
  const since = new Date(Date.now() - GIVEN_UP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db.select({ n: count() }).from(mailOutbox).where(and(isNotNull(mailOutbox.givenUpAt), gte(mailOutbox.givenUpAt, since)));
  return row?.n ?? 0;
}

/** What a queued mail is, in the admin's words. */
/**
 * What the order page may say about the buyer's confirmation mail of a CARD order (the mail is queued with the payment).
 * sent: it went out. pending: queued, still being tried (retried for about a day). failed: given up. none: no such mail was
 * queued for this order, so the page makes no claim about e-mail at all.
 */
export type ConfirmationMailState = 'sent' | 'pending' | 'failed' | 'none';
export async function confirmationMailState(orderId: number): Promise<ConfirmationMailState> {
  const rows = await db.select({ sentAt: mailOutbox.sentAt, givenUpAt: mailOutbox.givenUpAt }).from(mailOutbox).where(and(eq(mailOutbox.orderId, orderId), eq(mailOutbox.kind, 'order_confirmation')));
  if (rows.length === 0) return 'none';
  if (rows.some((r) => r.sentAt)) return 'sent';
  if (rows.some((r) => r.givenUpAt)) return 'failed';
  return 'pending';
}

export const MAIL_KIND_LABELS: Record<MailKind, string> = {
  order_confirmation: 'επιβεβαίωση πληρωμής προς τον πελάτη',
  order_paid_notice: 'ειδοποίηση πληρωμής προς το κατάστημα',
  payment_alert: 'ειδοποίηση ελέγχου πληρωμής προς το κατάστημα',
  unmatched_payment: 'ειδοποίηση για πληρωμή χωρίς παραγγελία',
  order_cancelled_notice: 'ειδοποίηση ακύρωσης (η πληρωμή δεν ξεκίνησε) προς το κατάστημα',
};

/** The mails of one order that were given up and never sent (the order page offers to send them again). */
export async function givenUpMailsOfOrder(orderId: number): Promise<Array<{ id: number; kind: MailKind; givenUpAt: Date | null; lastError: string | null }>> {
  return db
    .select({ id: mailOutbox.id, kind: mailOutbox.kind, givenUpAt: mailOutbox.givenUpAt, lastError: mailOutbox.lastError })
    .from(mailOutbox)
    .where(and(eq(mailOutbox.orderId, orderId), isNotNull(mailOutbox.givenUpAt), isNull(mailOutbox.sentAt)))
    .orderBy(mailOutbox.id);
}

/**
 * The admin's «send again» for one order: its given-up mails start over (attempts, wait and give-up cleared) and are tried at
 * once through the normal delivery, so a mail that fails again goes back on the usual back-off. An order without given-up
 * mails is left alone. Returns how many were reset and how many went out.
 */
export async function resendGivenUpMails(orderId: number, actor: string): Promise<{ reset: number; sent: number }> {
  const rows = await db
    .update(mailOutbox)
    .set({ givenUpAt: null, attempts: 0, nextAttemptAt: null, claimedAt: null })
    .where(and(eq(mailOutbox.orderId, orderId), isNotNull(mailOutbox.givenUpAt), isNull(mailOutbox.sentAt)))
    .returning({ id: mailOutbox.id });
  if (rows.length === 0) return { reset: 0, sent: 0 };
  let sent = 0;
  for (const { id } of rows) {
    try {
      if (await deliverRow(id)) sent++;
    } catch (err) {
      console.error(`[mail] resend of queued mail ${id} failed unexpectedly`, err);
    }
  }
  const rest = rows.length - sent;
  await addOrderEvent(orderId, 'email', `Επαναποστολή e-mail από διαχειριστή: στάλθηκαν ${sent} από ${rows.length}.${rest ? ' Όσα δεν στάλθηκαν θα ξαναδοκιμαστούν αυτόματα.' : ''}`, actor);
  return { reset: rows.length, sent };
}
