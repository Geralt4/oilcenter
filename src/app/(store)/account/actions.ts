'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newActivationToken } from '@/lib/auth/activation';
import { hashPassword, randomToken, sha256, verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, getCustomer, requireCustomer, revokeAllSessions } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { customers } from '@/lib/db/schema';
import { accountActivationMail, passwordResetMail, registrationAttemptMail, sendMail } from '@/lib/email';
import { accountFailuresBlocked, clientIp, loginBudgets, rateLimit, recordAccountFailure } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { accountsAvailable, canOrderNow } from '@/lib/catalogue-mode';

/** `link`: a next step shown under the message (e.g. «send the activation mail again») */
export type FormState = { ok: boolean; message: string; fieldErrors?: Record<string, string>; link?: { href: string; label: string } } | null;

const email = z.string().trim().toLowerCase().email('Μη έγκυρο e-mail').max(160);
const password = z.string().min(8, 'Τουλάχιστον 8 χαρακτήρες').max(200);

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? 'form')] ??= issue.message;
  return out;
}

/**
 * Only same-site absolute paths are accepted as a post-login destination (no open redirect).
 * Browsers treat backslashes and stripped control characters (tab, newline) as slashes, so
 * "/\evil.com" or "/\t/evil.com" would navigate off-site — reject those, then forbid the
 * protocol-relative "//host" form.
 */
function safeNext(value: FormDataEntryValue | null): string {
  const next = String(value ?? '');
  if (next === '/') return next;
  if (!/^\/[^/\\]/.test(next)) return '/account';
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return '/account';
  return next;
}

export async function registerCustomer(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await canOrderNow())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const parsed = z
    .object({ firstName: z.string().trim().min(2, 'Συμπληρώστε το όνομά σας').max(80), lastName: z.string().trim().min(2, 'Συμπληρώστε το επώνυμό σας').max(80), email, password, acceptTerms: z.literal('on', { error: 'Πρέπει να αποδεχτείτε τους όρους' }) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors: fieldErrors(parsed.error) };
  // counted only for a valid form (as the contact forms do): a typo or an unticked box must not use up the attempts
  const limited = await rateLimit(`register:${await clientIp()}`, 6, 30 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.' };

  // One answer for a new and for a known address, with the same work on both paths (a password hash, one statement, a mail sent
  // after the reply), so neither the message nor the time to answer tells whether the address has an account.
  const passwordHash = await hashPassword(parsed.data.password);
  const activation = newActivationToken();
  const [created] = await db
    .insert(customers)
    .values({ email: parsed.data.email, passwordHash, firstName: parsed.data.firstName, lastName: parsed.data.lastName, verifyTokenHash: activation.hash, verifyTokenExpires: activation.expires })
    .onConflictDoNothing({ target: customers.email })
    .returning({ id: customers.id });
  const settings = await getSettings();
  if (created) {
    // New address: the account exists but stays unverified (cannot sign in) until the link in this mail is followed.
    // Deliberately NOT linking earlier guest orders by e-mail: registration does not prove ownership
    // of that address, so it must not surface another person's order history. Guest orders stay
    // reachable through the order lookup (number + e-mail) or the secret link in the confirmation e-mail.
    const mail = accountActivationMail(parsed.data.email, activation.token, settings);
    after(() => sendMail(mail));
  } else {
    // Known address: the account is left exactly as it is; its owner is told and pointed to sign-in and password reset. At most a
    // few such notices an hour per address, so the form cannot be used to flood somebody's mailbox (the answer stays the same).
    const notices = await rateLimit(`register-notice:${parsed.data.email}`, 3, 60 * 60 * 1000);
    if (notices.ok) {
      const mail = registrationAttemptMail(parsed.data.email, settings);
      after(() => sendMail(mail));
    }
  }
  return { ok: true, message: REGISTERED };
}

const REGISTERED = 'Σας στείλαμε e-mail. Ακολουθήστε τον σύνδεσμο για να ολοκληρωθεί η εγγραφή.';
const NOT_ACTIVATED = 'Ο λογαριασμός σας δεν έχει ενεργοποιηθεί ακόμη. Ακολουθήστε τον σύνδεσμο στο e-mail που σας στείλαμε κατά την εγγραφή, ή ζητήστε νέο.';

export async function loginCustomer(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const parsed = z.object({ email, password: z.string().min(1).max(200) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Συμπληρώστε e-mail και κωδικό.' };

  // Limits that do not depend on knowing whose account it is: per address+e-mail stops one machine hammering one account, the
  // address-wide pool stops password spraying (a few tries against MANY e-mails). Neither can be used to lock somebody else out:
  // they only count the visitor's own address. The account-wide ceiling below counts failures only.
  const tooMany = (retryAfterSec: number): FormState => ({ ok: false, message: `Πολλές αποτυχημένες προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(retryAfterSec / 60)} λεπτά.` });
  const ip = await clientIp();
  const perAccount = await rateLimit(`login:${ip}:${parsed.data.email}`, 8, 15 * 60 * 1000);
  if (!perAccount.ok) return tooMany(perAccount.retryAfterSec);
  const limited = await loginBudgets('login', 20, 15 * 60 * 1000);
  if (!limited.ok) return tooMany(limited.retryAfterSec);
  const blocked = await accountFailuresBlocked('login', parsed.data.email);
  if (!blocked.ok) return tooMany(blocked.retryAfterSec); // the same answer as the limits above, whether or not the account exists

  const [customer] = await db.select().from(customers).where(eq(customers.email, parsed.data.email));
  // Hash even when the account does not exist, so response time does not reveal which e-mails are registered.
  const valid = await verifyPassword(parsed.data.password, customer?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!customer || !valid) {
    await recordAccountFailure('login', parsed.data.email);
    return { ok: false, message: 'Λάθος e-mail ή κωδικός.' };
  }

  // The right password, but the address was never confirmed: no session. Only someone who knows the password gets this far, so
  // the answer tells nothing new about who has an account. Not a failed attempt either, so nothing is counted.
  if (!customer.emailVerifiedAt) {
    return { ok: false, message: NOT_ACTIVATED, link: { href: `/resend-activation?email=${encodeURIComponent(parsed.data.email)}`, label: 'Στείλτε μου ξανά τον σύνδεσμο ενεργοποίησης' } };
  }

  await createSession('customer', customer.id, customer.tokenVersion);
  redirect(safeNext(formData.get('next')));
}

/**
 * «Send the activation link again». The same answer whatever the address (unknown, already active, waiting); a new link only for
 * an account that is waiting. Limited per address of the visitor and per e-mail, both counted before anything is looked up.
 */
export async function resendActivation(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const tooMany: FormState = { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.' };
  if (!(await rateLimit(`activation-resend:ip:${await clientIp()}`, 5, 30 * 60 * 1000)).ok) return tooMany;
  const parsed = email.safeParse(formData.get('email'));
  if (!parsed.success) return { ok: false, message: 'Μη έγκυρο e-mail.' };
  if (!(await rateLimit(`activation-resend:email:${parsed.data}`, 3, 60 * 60 * 1000)).ok) return tooMany;

  const activation = newActivationToken();
  const [waiting] = await db
    .update(customers)
    .set({ verifyTokenHash: activation.hash, verifyTokenExpires: activation.expires })
    .where(and(eq(customers.email, parsed.data), isNull(customers.emailVerifiedAt)))
    .returning({ id: customers.id });
  if (waiting) {
    const mail = accountActivationMail(parsed.data, activation.token, await getSettings());
    // sent after the reply: waiting for the mail server only for a waiting account would tell which ones exist
    after(() => sendMail(mail));
  }
  return { ok: true, message: 'Αν υπάρχει λογαριασμός που περιμένει ενεργοποίηση με αυτό το e-mail, σας στείλαμε νέο σύνδεσμο. Ισχύει για 24 ώρες.' };
}

export async function logoutCustomer(): Promise<void> {
  // Revoke before the cookie goes: deleting the cookie alone would leave a stolen copy valid for up to 30 days.
  const customer = await getCustomer();
  if (customer) await revokeAllSessions('customer', customer.id);
  await destroySession('customer');
  redirect('/');
}

export async function requestPasswordReset(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const done: FormState = { ok: true, message: 'Αν υπάρχει λογαριασμός με αυτό το e-mail, σας στείλαμε οδηγίες επαναφοράς.' };
  const limited = await rateLimit(`reset:${await clientIp()}`, 5, 30 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.' };
  const parsed = email.safeParse(formData.get('email'));
  if (!parsed.success) return { ok: false, message: 'Μη έγκυρο e-mail.' };

  const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, parsed.data));
  if (customer) {
    const token = randomToken();
    await db.update(customers).set({ resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 60 * 60 * 1000) }).where(eq(customers.id, customer.id));
    const mail = passwordResetMail(parsed.data, token, await getSettings());
    // sent after the reply: waiting for the mail server only when the account exists would tell who has one
    after(() => sendMail(mail));
  }
  return done; // identical answer either way
}

export async function resetPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const parsed = z.object({ token: z.string().min(20).max(200), password }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Ελέγξτε τον κωδικό.', fieldErrors: fieldErrors(parsed.error) };

  // The link is spent by the same UPDATE that uses it: its hash and expiry are part of the WHERE, so two requests carrying the
  // same link at once cannot both set a password and sign in (the loser matches no row).
  const tokenHash = sha256(parsed.data.token);
  // cheap look first, so a made-up link costs no password hash; the UPDATE below is what actually decides
  const [known] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.resetTokenHash, tokenHash), gt(customers.resetTokenExpires, new Date())));
  if (!known) return { ok: false, message: 'Ο σύνδεσμος επαναφοράς δεν ισχύει ή έχει λήξει. Ζητήστε νέο.' };
  const passwordHash = await hashPassword(parsed.data.password);
  // Bump the session version: every other session for this account (e.g. one an attacker opened with the
  // old password) is invalidated, and only this browser stays signed in.
  const [customer] = await db
    .update(customers)
    // the reset link reached the mailbox, which proves the address too: an account that was never activated is activated here
    .set({ passwordHash, resetTokenHash: null, resetTokenExpires: null, emailVerifiedAt: sql`coalesce(${customers.emailVerifiedAt}, ${Date.now()})`, verifyTokenHash: null, verifyTokenExpires: null, tokenVersion: sql`${customers.tokenVersion} + 1` })
    .where(and(eq(customers.resetTokenHash, tokenHash), gt(customers.resetTokenExpires, new Date())))
    .returning({ id: customers.id, tokenVersion: customers.tokenVersion });
  if (!customer) return { ok: false, message: 'Ο σύνδεσμος επαναφοράς δεν ισχύει ή έχει λήξει. Ζητήστε νέο.' };

  await createSession('customer', customer.id, customer.tokenVersion);
  redirect('/account');
}

export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireCustomer();
  const text = (max: number) => z.string().trim().max(max);
  const parsed = z
    .object({ firstName: text(80).min(2, 'Συμπληρώστε το όνομά σας'), lastName: text(80).min(2, 'Συμπληρώστε το επώνυμό σας'), phone: text(30), street: text(160), city: text(80), postalCode: text(10), region: text(80) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors: fieldErrors(parsed.error) };

  const d = parsed.data;
  await db.update(customers).set({ firstName: d.firstName, lastName: d.lastName, phone: d.phone || null, street: d.street || null, city: d.city || null, postalCode: d.postalCode || null, region: d.region || null }).where(eq(customers.id, me.id));
  return { ok: true, message: 'Τα στοιχεία σας αποθηκεύτηκαν.' };
}
