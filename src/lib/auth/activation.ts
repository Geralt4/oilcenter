import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '@/lib/auth/password';
import { db } from '@/lib/db';
import { customers } from '@/lib/db/schema';

/*
 * Activation of a new customer account. Registration answers the same for a new and a known address, so it cannot sign the
 * visitor in: the account starts unverified and only the owner of the mailbox can activate it, through a single-use link.
 * The link's token is stored hashed (like the reset tokens) and stops working after 24 hours or once used.
 */

export const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** A fresh link token: the raw value goes into the mail, the hash and the expiry into the customer row. */
export function newActivationToken(): { token: string; hash: string; expires: Date } {
  const token = randomToken();
  return { token, hash: sha256(token), expires: new Date(Date.now() + ACTIVATION_TTL_MS) };
}

/**
 * Spends an activation link. One conditional UPDATE: the hash, the expiry and "not yet verified" are in the WHERE, so a link
 * that is used twice at once, or after it expired, matches no row. Returns the account to sign in, or null.
 */
export async function activateByToken(token: string): Promise<{ id: number; tokenVersion: number } | null> {
  if (token.length < 20 || token.length > 200) return null;
  const hash = sha256(token);
  const [row] = await db
    .update(customers)
    .set({ emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpires: null })
    .where(and(eq(customers.verifyTokenHash, hash), gt(customers.verifyTokenExpires, new Date()), isNull(customers.emailVerifiedAt)))
    .returning({ id: customers.id, tokenVersion: customers.tokenVersion });
  return row ?? null;
}
