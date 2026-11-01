import { orderConfirmationMail, sendMail } from '@/lib/email';
import { addOrderEvent, type OrderWithItems } from '@/lib/orders';
import type { ShopSettings } from '@/lib/settings';

/**
 * The buyer's confirmation of an order that was just placed without a card payment (a card order's mails are queued with its
 * payment instead), and the note about it on the order's timeline. `true` only when the mail went out. When the order could not
 * be read back there is nothing to send: nothing was attempted, so the answer is `false` (the order page then does not claim a
 * confirmation was sent).
 */
export async function sendPlacedOrderConfirmation(order: { id: number; email: string }, full: OrderWithItems | null | undefined, settings: ShopSettings): Promise<boolean> {
  if (!full) return false;
  const sent = await sendMail(orderConfirmationMail(full, settings));
  await addOrderEvent(order.id, 'email', sent ? `Στάλθηκε e-mail επιβεβαίωσης στο ${order.email}.` : `ΑΠΟΤΥΧΙΑ αποστολής e-mail επιβεβαίωσης στο ${order.email}.`);
  return sent;
}
