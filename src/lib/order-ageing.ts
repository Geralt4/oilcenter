/*
 * How long an order that nobody has acted on may wait.
 *
 *  - A bank-transfer order holds its stock until the money arrives. After BANK_TRANSFER_EXPIRY_DAYS without it, the order is
 *    cancelled and the stock goes back (lib/orders.ts, releaseExpiredBankTransferOrders; hourly in instrumentation.ts).
 *  - A cash-on-delivery or pay-in-store order is never cancelled by itself (the goods may be on their way, or the buyer may be
 *    coming to the shop), but one still «pending» after OPEN_ORDER_FLAG_DAYS is shown on the admin dashboard as waiting too long.
 *
 * Constants, not settings: the customer-facing sentence below and the sweep must always agree.
 */

export const BANK_TRANSFER_EXPIRY_DAYS = 5;
export const OPEN_ORDER_FLAG_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a bank-transfer order placed at `createdAt` expires if its transfer has not arrived. */
export const bankTransferDeadline = (createdAt: Date): Date => new Date(createdAt.getTime() + BANK_TRANSFER_EXPIRY_DAYS * DAY_MS);

/** For the pages that have no order yet in front of them (shipping and payments). */
export const BANK_TRANSFER_EXPIRY_GENERAL = `Αν η κατάθεση δεν εισπραχθεί μέσα σε ${BANK_TRANSFER_EXPIRY_DAYS} ημέρες από την παραγγελία, η παραγγελία ακυρώνεται αυτόματα και τα προϊόντα επιστρέφουν στο απόθεμα.`;

/** For the order page and the confirmation e-mail: the same promise with the day it falls due. */
export const bankTransferExpiryNotice = (createdAt: Date, formatDay: (d: Date) => string): string =>
  `Αν η κατάθεση δεν εισπραχθεί μέσα σε ${BANK_TRANSFER_EXPIRY_DAYS} ημέρες (έως ${formatDay(bankTransferDeadline(createdAt))}), η παραγγελία ακυρώνεται αυτόματα και τα προϊόντα επιστρέφουν στο απόθεμα.`;
