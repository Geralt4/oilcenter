import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { getSettings } from '@/lib/settings.server';

/*
 * Catalogue mode: while Admin → Ρυθμίσεις → «online παραγγελίες» is off, the site is the shop's website — products,
 * prices, how to reach us — and everything that belongs to buying online is hidden, not merely disabled: cart,
 * checkout, accounts, order look-up, the shipping/returns pages and every «παραγγείλετε online» sentence.
 * The logged-in owner is the exception: he still gets the whole shop, to place test orders before opening.
 * Server-only (reads the session cookie); client components use `useStoreConfig().canOrder`, which is the same answer.
 */

/** Can THIS visitor use the shop part of the site? */
export async function canOrderNow(): Promise<boolean> {
  const [{ storefront }, admin] = await Promise.all([getSettings(), getAdmin()]);
  return storefront.ordersEnabled || admin !== null;
}

/** For pages that only exist while ordering is open: anyone else lands on the home page. */
export async function requireOrdering(): Promise<void> {
  if (!(await canOrderNow())) redirect('/');
}

/**
 * For the pages of people who have ALREADY bought — sign-in, account, order look-up. Before the shop has ever taken
 * a real order they are part of what catalogue mode hides; afterwards they stay reachable by their address even if
 * the owner closes ordering for a while (holidays, stock-taking), so nobody is locked out of an order in progress.
 */
export async function requireOrderingOrHistory(): Promise<void> {
  if (!(await accountsAvailable())) redirect('/');
}

/** The same answer for server actions, which reply with a message instead of redirecting. */
export async function accountsAvailable(): Promise<boolean> {
  if (await canOrderNow()) return true;
  const [real] = await db.select({ id: orders.id }).from(orders).where(eq(orders.isTest, false)).limit(1);
  return Boolean(real);
}
