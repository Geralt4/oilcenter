import { orderConfirmationMail, sendMail } from '@/lib/email';
import { addOrderEvent, getOrderByNumber, markOrderPaid } from '@/lib/orders';
import { getSettings } from '@/lib/settings.server';

/**
 * Single place where a verified gateway payment lands, whether it arrived via the buyer's browser
 * return or via a webhook. markOrderPaid() is idempotent, so the confirmation e-mail goes out once.
 */
export async function settleCardPayment(order: { id: number; number: string }, info: { provider: string; ref: string; amountCents: number }): Promise<void> {
  const firstTime = await markOrderPaid(order.id, info);
  if (!firstTime) return;
  const [full, settings] = await Promise.all([getOrderByNumber(order.number), getSettings()]);
  if (!full) return;
  const sent = await sendMail(orderConfirmationMail(full, settings));
  await addOrderEvent(order.id, 'email', sent ? `Στάλθηκε e-mail επιβεβαίωσης στο ${full.email}.` : `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${full.email}.`);
}
