import { and, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { randomToken, sha256 } from '@/lib/auth/password';
import { db } from '@/lib/db';
import { customers } from '@/lib/db/schema';

/*
 * Activation of a new customer account. Registration answers the same for a new and a known address, so it cannot sign the
 * visitor in: the account starts unverified and only the owner of the mailbox can activate it, through a single-use link.
 * The link's token is stored hashed (like the reset tokens) and stops working after 24 hours or once used.
 *
 * Opening the link only shows a page with a button; pressing the button spends the token. Mail scanners (Outlook Safe Links
 * and others) open links before the customer does, and a link that worked on opening would be used up by them.
 */

export const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;

export const ACTIVATION_LINK_INVALID = 'Ο σύνδεσμος ενεργοποίησης δεν ισχύει, έχει ήδη χρησιμοποιηθεί ή έχει λήξει. Αν ο λογαριασμός σας είναι ήδη ενεργός, απλώς συνδεθείτε· αλλιώς ζητήστε νέο σύνδεσμο.';

/** A fresh link token: the raw value goes into the mail, the hash and the expiry into the customer row. */
export function newActivationToken(): { token: string; hash: string; expires: Date } {
  const token = randomToken();
  return { token, hash: sha256(token), expires: new Date(Date.now() + ACTIVATION_TTL_MS) };
}

/** The one definition of «this link still works», shared by the page (which only looks) and the button (which spends it). */
function usableToken(token: string): SQL | null {
  if (token.length < 20 || token.length > 200) return null;
  return and(eq(customers.verifyTokenHash, sha256(token)), gt(customers.verifyTokenExpires, new Date()), isNull(customers.emailVerifiedAt))!;
}

/** Whether the link would activate an account, without spending it. A read only: opening the page twice changes nothing. */
export async function activationTokenUsable(token: string): Promise<boolean> {
  const where = usableToken(token);
  if (!where) return false;
  const [row] = await db.select({ id: customers.id }).from(customers).where(where).limit(1);
  return !!row;
}

/**
 * Spends an activation link. One conditional UPDATE with the same conditions as above in the WHERE, so a link that is used twice
 * at once, or after it expired, matches no row. Returns the account to sign in, or null.
 */
export async function activateByToken(token: string): Promise<{ id: number; tokenVersion: number } | null> {
  const where = usableToken(token);
  if (!where) return null;
  const [row] = await db
    .update(customers)
    .set({ emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpires: null })
    .where(where)
    .returning({ id: customers.id, tokenVersion: customers.tokenVersion });
  return row ?? null;
}
