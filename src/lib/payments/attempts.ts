import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { enqueueUnmatchedPaymentMail } from '@/lib/payments/mail-queue';
import { orders, paymentAttempts, unmatchedPayments, type Order, type PaymentAttemptStatus } from '@/lib/db/schema';

/** The shared client or the transaction a caller is inside: writes that must succeed or fail together take the latter. */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/*
 * Payment attempts. Each gateway checkout opened for an order is kept, so a payment made on an older checkout (a buyer
 * who retried, or has two tabs open) still finds its order. orders.paymentRef only ever holds the latest one.
 */

/** Remembers a freshly opened checkout and makes it the order's latest. */
export async function recordPaymentAttempt(orderId: number, attempt: { provider: string; ref: string }): Promise<void> {
  await db.insert(paymentAttempts).values({ orderId, provider: attempt.provider, ref: attempt.ref }).onConflictDoNothing();
  await db.update(orders).set({ paymentProvider: attempt.provider, paymentRef: attempt.ref }).where(eq(orders.id, orderId));
}

/**
 * The order a gateway payment belongs to. Only call this with a reference taken from a transaction that was just re-read
 * from the gateway's API: the lookups below trust it.
 *  1. the attempt table;
 *  2. orders.paymentRef (orders from before attempts were kept);
 *  3. Viva only: merchantTrns, which is the order number we sent when the checkout was created.
 */
export async function findOrderByPayment(provider: string, ref: string, merchantTrns?: string | null): Promise<Order | null> {
  const [byAttempt] = await db
    .select({ order: orders })
    .from(paymentAttempts)
    .innerJoin(orders, eq(paymentAttempts.orderId, orders.id))
    .where(and(eq(paymentAttempts.provider, provider), eq(paymentAttempts.ref, ref)));
  if (byAttempt) return byAttempt.order;

  const [byRef] = await db.select().from(orders).where(and(eq(orders.paymentProvider, provider), eq(orders.paymentRef, ref)));
  if (byRef) return byRef;

  if (provider === 'viva' && merchantTrns) {
    const [byNumber] = await db.select().from(orders).where(and(eq(orders.number, merchantTrns), eq(orders.paymentMethod, 'card')));
    if (byNumber) return byNumber;
  }
  return null;
}

/** A checkout the buyer finished whose money is still on its way (a delayed method): no second checkout may be opened and the order must not be released. */
export async function hasProcessingPayment(orderId: number, exec: Executor = db): Promise<boolean> {
  const [hit] = await exec.select({ id: paymentAttempts.id }).from(paymentAttempts).where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, 'processing'))).limit(1);
  return Boolean(hit);
}

/**
 * Like setAttemptStatus, but creates the attempt when it was never recorded (an order found through merchantTrns). True when
 * this call made the change, false when the attempt was already in a status outside `onlyFrom`: the "first to report it"
 * guard that keeps a repeated notification from raising the same alarm twice.
 */
export async function claimAttemptStatus(
  orderId: number,
  provider: string,
  ref: string,
  status: PaymentAttemptStatus,
  transactionId: string | null,
  onlyFrom: PaymentAttemptStatus[],
  exec: Executor = db,
): Promise<boolean> {
  const created = await exec.insert(paymentAttempts).values({ orderId, provider, ref, status, transactionId }).onConflictDoNothing().returning({ id: paymentAttempts.id });
  if (created.length > 0) return true;
  return setAttemptStatus(provider, ref, status, transactionId, onlyFrom, exec);
}

/**
 * Moves an attempt to a new status (optionally only from certain statuses) and reports whether it changed, which is how
 * callers avoid writing the same order event twice when a gateway repeats a notification.
 */
export async function setAttemptStatus(
  provider: string,
  ref: string,
  status: PaymentAttemptStatus,
  transactionId: string | null,
  onlyFrom?: PaymentAttemptStatus[],
  exec: Executor = db,
): Promise<boolean> {
  const where = and(eq(paymentAttempts.provider, provider), eq(paymentAttempts.ref, ref), onlyFrom ? inArray(paymentAttempts.status, onlyFrom) : undefined);
  const changed = await exec.update(paymentAttempts).set({ status, transactionId }).where(where).returning({ id: paymentAttempts.id });
  return changed.length > 0;
}

/**
 * Keeps a paid payment that matches no order. True only the first time this transaction is recorded, so the caller sends the
 * shop's e-mail once however many times the gateway (and the buyer's browser) report it.
 */
export async function recordUnmatchedPayment(info: {
  provider: string;
  orderCode: string;
  transactionId: string;
  merchantTrns: string | null;
  amountCents: number;
  currency: string | null;
}): Promise<boolean> {
  // the row and the mail to the shop are saved together, so a crash cannot leave a payment nobody was told about
  return db.transaction(async (tx) => {
    const created = await tx.insert(unmatchedPayments).values(info).onConflictDoNothing().returning({ id: unmatchedPayments.id });
    if (created.length === 0) return false;
    await enqueueUnmatchedPaymentMail(created[0].id, tx);
    return true;
  });
}
