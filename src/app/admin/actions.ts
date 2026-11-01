'use server';

import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AVAILABILITY, type Availability } from '@/lib/availability';
import { hashPassword, randomToken, verifyPassword } from '@/lib/auth/password';
import { newTotpSecret, totpStep } from '@/lib/auth/totp';
import { createSession, createSudoSession, destroySession, destroySudoSession, getAdmin, hasSudoSession, requireAdmin, revokeAllSessions } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { adminUsers, brands, categories, contactMessages, coupons, launchSignups, orderItems, orders, priceChanges, productImages, products, sales, unmatchedPayments, variants, type BaseType, type OrderStatus, type PaymentStatus } from '@/lib/db/schema';
import { orderStatusMail, sendMail } from '@/lib/email';
import { forgetTarget } from '@/lib/discount-cleanup';
import { cleanIds, hasTargets, type Targets } from '@/lib/discounts';
import { commerceEnabled } from '@/lib/commerce-flag';
import { buildHazard } from '@/lib/ghs';
import { isValidGtin, normalizeGtin } from '@/lib/gtin';
import { isValidIban, normalizeIban } from '@/lib/iban';
import { addOrderEvent, cancelOrder, flagForReview, getOrderByNumber, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@/lib/orders';
import { resendGivenUpMails } from '@/lib/payments/mail-delivery';
import { applyPriceChanges } from '@/lib/price-apply';
import { PRODUCT_HAS_HISTORY, productHasHistory } from '@/lib/product-history';
import { describePriceImport, MAX_PRICE_CENTS, parseCsv, planPriceImport } from '@/lib/price-csv';
import { accountFailuresBlocked, clientIp, loginBudgets, peekLimit, rateLimit, recordAccountFailure } from '@/lib/rate-limit';
import { DEFAULT_SETTINGS, SKROUTZ_AVAILABILITY, type BankAccount, type DayHours, type ShopSettings } from '@/lib/settings';
import { buildSearchText } from '@/lib/search-keywords';
import { rebuildSearchTexts } from '@/lib/search-text';
import { getSettings, saveSettingsGroup } from '@/lib/settings.server';
import { invalidateSkroutzFeed } from '@/lib/skroutz-feed-cache';
import { claimUpload, finishUpload, moveClaimed, readStagedText, releaseUpload } from '@/lib/uploads';
import { normalizeText, parseAthensDate, parsePriceToCents, parseVolumeMl, slugify } from '@/lib/utils';

/* Every action below starts with requireAdmin(): page-level protection alone would not cover direct action calls. */

export type AdminFormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

const str = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();
const bool = (fd: FormData, key: string) => fd.get(key) === 'on' || fd.get(key) === 'true';
const int = (fd: FormData, key: string, fallback = 0) => {
  const raw = str(fd, key).replace(',', '.');
  // an emptied field means "the default", not zero: Number('') is 0, and a cleared ΦΠΑ box used to save 0 %
  if (!raw) return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Verify a TOTP code AND burn its time step in one conditional UPDATE. Two requests presenting the
 * same code cannot both succeed, and a previously accepted code is refused for the rest of its window.
 */
async function consumeTotp(adminId: number, secret: string, email: string, token: string): Promise<boolean> {
  const step = totpStep(secret, email, token);
  if (step === null) return false;
  const result = await db
    .update(adminUsers)
    .set({ totpLastStep: step })
    .where(and(eq(adminUsers.id, adminId), or(isNull(adminUsers.totpLastStep), lt(adminUsers.totpLastStep, step))));
  return Number(result.rowsAffected ?? 0) > 0;
}

// ─── Session ─────────────────────────────────────────────────────────────────
export async function loginAdmin(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const email = str(fd, 'email').toLowerCase();
  const password = String(fd.get('password') ?? '');
  // Two budgets: per-IP+email (below) stops hammering one account; the IP-wide pool here stops password
  // spraying — a few tries against MANY e-mails — which the per-account key alone would never catch.
  const limited = await loginBudgets('admin-login', 20, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά.` };
  const perAccount = await rateLimit(`admin-login:${await clientIp()}:${email}`, 6, 15 * 60 * 1000);
  if (!perAccount.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(perAccount.retryAfterSec / 60)} λεπτά.` };
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
  // The account-wide failed-password ceiling (rate-limit.ts) is for accounts that a password alone can open. An admin with
  // two-step verification is left out: guessing the password gets nobody in without the code, the code has its own account-wide
  // cap below, and so strangers cannot use the ceiling to lock the owner out of the panel. An address with no account is
  // treated like an admin without 2FA, so the ceiling itself does not tell the two apart.
  const ceilingApplies = !admin?.totpConfirmedAt;
  if (ceilingApplies) {
    const blocked = await accountFailuresBlocked('admin-login', email);
    if (!blocked.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(blocked.retryAfterSec / 60)} λεπτά.` };
  }

  const valid = await verifyPassword(password, admin?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!admin || !valid) {
    if (ceilingApplies) await recordAccountFailure('admin-login', email);
    // The e-mail the visitor typed, never the password. Kept to one line: log floods hunt for noise.
    // At 6 tries/15 min per address this stays rare in normal use — 2+ logged failures in a window means
    // someone is knocking, and the platform log is where the owner (or an alert rule) will see it.
    const ip = await clientIp();
    console.warn(`[admin-login] FAILED attempt email=${JSON.stringify(email)} ip=${ip}`);
    return { ok: false, message: 'Λάθος e-mail ή κωδικός.' };
  }

  // Second factor. Checked after the password so a wrong code alone reveals nothing; a separate budget
  // stops someone who ALREADY knows the password from brute-forcing the 6-digit code.
  if (admin.totpConfirmedAt) {
    const attempted = str(fd, 'totp').replace(/\s/g, '');
    if (!admin.totpSecret) {
      // Fail closed: a confirmed factor with no secret cannot be verified by anyone.
      console.error('[admin-login] MFA confirmed but totp_secret is empty — refusing login');
      return { ok: false, message: 'Η επαλήθευση δύο βημάτων είναι ελλιπώς ρυθμισμένη. Χρειάζεται αποκατάσταση από τον διακομιστή.' };
    }
    if (!attempted) return { ok: false, message: 'Συμπληρώστε τον 6ψήφιο κωδικό από την εφαρμογή επαλήθευσης.', fieldErrors: { totp: 'Υποχρεωτικό πεδίο' } };
    const totpLimited = await rateLimit(`admin-totp:${await clientIp()}:${email}`, 5, 15 * 60 * 1000);
    if (!totpLimited.ok) return { ok: false, message: `Πολλές προσπάθειες με κωδικό. Δοκιμάστε ξανά σε ${Math.ceil(totpLimited.retryAfterSec / 60)} λεπτά.` };
    // Across all addresses, failed codes only, and only reachable with the right password, so nobody else can spend it: it keeps
    // the 6-digit code from being guessed by many machines at once (the old account-wide key did that for every attempt).
    const totpAccount = await peekLimit(`admin-totp-fail:account:${email}`, 10, 15 * 60 * 1000);
    if (!totpAccount.ok) return { ok: false, message: `Πολλές προσπάθειες με κωδικό. Δοκιμάστε ξανά σε ${Math.ceil(totpAccount.retryAfterSec / 60)} λεπτά.` };
    if (!(await consumeTotp(admin.id, admin.totpSecret, admin.email, attempted))) {
      await rateLimit(`admin-totp-fail:account:${email}`, 10, 15 * 60 * 1000);
      return { ok: false, message: 'Λάθος ή ήδη χρησιμοποιημένος κωδικός επαλήθευσης.' };
    }
  }

  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, admin.id));
  await createSession('admin', admin.id, admin.tokenVersion);
  redirect('/admin');
}

// ─── Admin second factor (TOTP) ─────────────────────────────────────────────
/**
 * Step 1: create (or replace) an unconfirmed secret. The owner scans the QR on the settings page.
 * Starting needs proof that the person at the keyboard is the account's owner, not just whoever holds the session cookie: the
 * current code while a factor is active, the current PASSWORD while there is none (the identity confirmation cannot be used
 * here: it needs a factor, and a factor is what is being created).
 */
export async function beginTotpEnrollment(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  // its own budget: wrong passwords here must not use up the attempts of confirmTotpEnrollment (key `mfa:`), or a few typos would
  // lock the owner out of confirming the code he has just scanned
  const limited = await rateLimit(`mfa-start:${await clientIp()}:${me.id}`, 8, 15 * 60 * 1000);
  if (!limited.ok) redirect('/admin/settings?mfa=rate');
  const [row] = await db.select({ secret: adminUsers.totpSecret, confirmedAt: adminUsers.totpConfirmedAt, passwordHash: adminUsers.passwordHash }).from(adminUsers).where(eq(adminUsers.id, me.id));
  if (row?.confirmedAt) {
    // Replacing an ACTIVE secret silently would let a stolen session swap in its own authenticator. Require a
    // current code first (the UI only offers "enable" when nothing is active; this guards direct action calls).
    if (!row.secret || !(await consumeTotp(me.id, row.secret, me.email, str(fd, 'totp')))) redirect('/admin/settings?mfa=wrong');
  } else if (!row || !(await verifyPassword(String(fd.get('currentPassword') ?? ''), row.passwordHash))) {
    // No factor yet: a stolen session must not be able to enrol its own authenticator without the password
    redirect('/admin/settings?mfa=password');
  }
  await db.update(adminUsers).set({ totpSecret: newTotpSecret(), totpConfirmedAt: null, totpLastStep: null }).where(eq(adminUsers.id, me.id));
  revalidatePath('/admin/settings');
}

/** Step 2: prove the authenticator works before the factor starts being required at login. */
export async function confirmTotpEnrollment(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const limited = await rateLimit(`mfa:${await clientIp()}:${me.id}`, 8, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγα λεπτά.' };
  const [row] = await db.select({ secret: adminUsers.totpSecret }).from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row?.secret) return { ok: false, message: 'Δεν υπάρχει εκκρεμής ρύθμιση. Πατήστε «Ενεργοποίηση» ξανά.' };
  if (!(await consumeTotp(me.id, row.secret, me.email, str(fd, 'totp')))) return { ok: false, message: 'Ο κωδικός δεν είναι σωστός ή έχει ήδη χρησιμοποιηθεί. Περιμένετε τον επόμενο και δοκιμάστε ξανά.' };
  // A factor that just became required must also invalidate sessions opened before it existed.
  const [updated] = await db
    .update(adminUsers)
    .set({ totpConfirmedAt: new Date(), tokenVersion: sql`${adminUsers.tokenVersion} + 1` })
    .where(eq(adminUsers.id, me.id))
    .returning({ ver: adminUsers.tokenVersion });
  if (updated) await createSession('admin', me.id, updated.ver);
  await destroySudoSession();
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Η επαλήθευση δύο βημάτων ενεργοποιήθηκε. Από την επόμενη σύνδεση θα ζητείται ο κωδικός της εφαρμογής.' };
}

/** Turning it OFF needs a current code: a stolen session alone must not be able to remove the factor. */
export async function disableTotp(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const limited = await rateLimit(`mfa:${await clientIp()}:${me.id}`, 8, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγα λεπτά.' };
  const [row] = await db.select({ secret: adminUsers.totpSecret, confirmedAt: adminUsers.totpConfirmedAt }).from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row?.secret) return { ok: false, message: 'Η επαλήθευση δύο βημάτων δεν είναι ενεργή.' };
  // A pending (never confirmed) enrollment can simply be cancelled; an active one needs proof of possession.
  if (row.confirmedAt && !(await consumeTotp(me.id, row.secret, me.email, str(fd, 'totp')))) return { ok: false, message: 'Λάθος ή ήδη χρησιμοποιημένος κωδικός επαλήθευσης.' };
  const [updated] = await db
    .update(adminUsers)
    .set({ totpSecret: null, totpConfirmedAt: null, totpLastStep: null, tokenVersion: sql`${adminUsers.tokenVersion} + 1` })
    .where(eq(adminUsers.id, me.id))
    .returning({ ver: adminUsers.tokenVersion });
  if (updated) await createSession('admin', me.id, updated.ver);
  await destroySudoSession();
  revalidatePath('/admin/settings');
  return { ok: true, message: row.confirmedAt ? 'Η επαλήθευση δύο βημάτων απενεργοποιήθηκε.' : 'Η εκκρεμής ρύθμιση ακυρώθηκε.' };
}

// ─── Re-authentication for administrator changes ────────────────────────────
/**
 * Proves the acting administrator's password AND current authenticator code, then leaves a signed,
 * five-minute sudo cookie. The password and code are not stored anywhere.
 */
export async function confirmAdminIdentity(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const limited = await rateLimit(`sudo:${await clientIp()}:${me.id}`, 5, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά.` };
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row || !(await verifyPassword(String(fd.get('currentPassword') ?? ''), row.passwordHash))) return { ok: false, message: 'Λάθος κωδικός.' };
  // Privileged actions (administrator changes, full database download) require BOTH factors. An account
  // that has not enrolled an authenticator cannot obtain the five-minute confirmation.
  if (!row.totpConfirmedAt || !row.totpSecret) return { ok: false, message: 'Ενεργοποιήστε πρώτα την επαλήθευση δύο βημάτων (2FA) από την παραπάνω ενότητα, μετά ξαναδοκιμάστε.' };
  if (!(await consumeTotp(me.id, row.totpSecret, me.email, str(fd, 'totp')))) return { ok: false, message: 'Λάθος ή ήδη χρησιμοποιημένος κωδικός επαλήθευσης. Περιμένετε τον επόμενο κωδικό.' };
  if (!(await createSudoSession())) return { ok: false, message: 'Η συνεδρία δεν υποστηρίζει επιβεβαίωση. Αποσυνδεθείτε και συνδεθείτε ξανά.' };
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Η ταυτότητα επιβεβαιώθηκε για 5 λεπτά (μόνο σε αυτή τη συνεδρία).' };
}

// ─── Administrators ──────────────────────────────────────────────────────────
/**
 * A second administrator (the developer/maintainer). Each account carries its own password and its own
 * authenticator, so the shop never depends on one person's phone — and the other admin can reset MFA
 * for a colleague who lost theirs. Passwords are never shared between accounts.
 */
export async function addAdmin(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  if (!(await hasSudoSession())) return { ok: false, message: 'Επιβεβαιώστε πρώτα την ταυτότητά σας (κωδικός + κωδικός εφαρμογής) στην ενότητα «Επιβεβαίωση ταυτότητας».' };
  const email = str(fd, 'email').toLowerCase();
  const name = str(fd, 'adminName');
  const password = String(fd.get('adminPassword') ?? '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, message: 'Γράψτε ένα έγκυρο e-mail.', fieldErrors: { email: 'Μη έγκυρο e-mail' } };
  if (password.length < 10) return { ok: false, message: 'Ο προσωρινός κωδικός χρειάζεται τουλάχιστον 10 χαρακτήρες.', fieldErrors: { adminPassword: 'Τουλάχιστον 10 χαρακτήρες' } };
  try {
    await db.insert(adminUsers).values({ email, passwordHash: await hashPassword(password), name: name.slice(0, 80) || 'Διαχειριστής' });
  } catch (err) {
    if (isUniqueViolation(err, 'admin_users.email')) return { ok: false, message: 'Υπάρχει ήδη διαχειριστής με αυτό το e-mail.' };
    throw err;
  }
  revalidatePath('/admin/settings');
  return { ok: true, message: `Ο διαχειριστής ${email} προστέθηκε. Συνδεθείτε μαζί του μία φορά, αλλάξτε τον κωδικό και ενεργοποιήστε τη δική σας εφαρμογή επαλήθευσης.` };
}

/** Removing the LAST administrator would lock the shop out of its own panel. */
export async function removeAdmin(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  if (!(await hasSudoSession())) redirect('/admin/settings?sudo=1');
  const id = int(fd, 'id');
  if (id === me.id) return; // never delete yourself; sign out is the way out
  // The count is part of the DELETE itself: two concurrent removals cannot both see "2 administrators".
  await db.delete(adminUsers).where(and(eq(adminUsers.id, id), sql`(select count(*) from admin_users) > 1`));
  revalidatePath('/admin/settings');
}

/**
 * Recovery for an administrator who lost their phone: clears the factor on ANOTHER account and signs that
 * account out. Your own account cannot be reset here — for yourself the code is still required, which keeps
 * a stolen session from stripping your own second factor. Locked out entirely? `npm run admin:reset-mfa`.
 */
export async function resetAdminMfa(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  if (!(await hasSudoSession())) redirect('/admin/settings?sudo=1');
  const id = int(fd, 'id');
  if (id === me.id) return;
  await db
    .update(adminUsers)
    .set({ totpSecret: null, totpConfirmedAt: null, totpLastStep: null, tokenVersion: sql`${adminUsers.tokenVersion} + 1` })
    .where(eq(adminUsers.id, id));
  revalidatePath('/admin/settings');
}

export async function logoutAdmin(): Promise<void> {
  // Revoke before the cookie goes: deleting the cookie alone would leave a stolen copy valid for up to 12 h.
  const admin = await getAdmin();
  if (admin) await revokeAllSessions('admin', admin.id);
  await destroySudoSession();
  await destroySession('admin');
  redirect('/admin/login');
}

export async function changeAdminPassword(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const next = String(fd.get('newPassword') ?? '');
  if (next.length < 10) return { ok: false, message: 'Ο νέος κωδικός πρέπει να έχει τουλάχιστον 10 χαρακτήρες.' };
  if (next !== String(fd.get('newPasswordRepeat') ?? '')) return { ok: false, message: 'Οι δύο νέοι κωδικοί δεν είναι ίδιοι.' };
  // the current-password check is a password check like the login: a stolen session must not be able to guess it freely
  const limited = await rateLimit(`admin-password:${await clientIp()}:${me.id}`, 5, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά.` };
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, me.id));
  if (!row || !(await verifyPassword(String(fd.get('currentPassword') ?? ''), row.passwordHash))) return { ok: false, message: 'Ο τρέχων κωδικός δεν είναι σωστός.' };
  // Bump the session version so other sessions are signed out; re-issue this one so the admin stays logged in here.
  const nextVersion = row.tokenVersion + 1;
  await db.update(adminUsers).set({ passwordHash: await hashPassword(next), tokenVersion: nextVersion }).where(eq(adminUsers.id, me.id));
  await createSession('admin', me.id, nextVersion);
  return { ok: true, message: 'Ο κωδικός άλλαξε.' };
}

// ─── Orders ──────────────────────────────────────────────────────────────────
const STATUSES = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];
const PAYMENT_STATUSES = Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatus[];

/** Thrown inside the order editor's transaction when the order moved on since the page was loaded: rolls everything back. */
class StaleOrder extends Error {}

export async function updateOrder(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const admin = await requireAdmin();
  const id = int(fd, 'id');
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return { ok: false, message: 'Η παραγγελία δεν βρέθηκε.' };

  const askedStatus = str(fd, 'status') as OrderStatus;
  if (!STATUSES.includes(askedStatus)) return { ok: false, message: 'Μη έγκυρη κατάσταση.' };
  // The form says what the order looked like when the page was opened. Only what the owner actually CHANGED from that is
  // applied: a stale tab that merely saves a tracking number must not undo a payment or a status that moved on meanwhile.
  // Without those fields (older callers) the form is compared with the row as it is now, as before.
  const loadedStatus = str(fd, 'loadedStatus') as OrderStatus;
  const loadedPayment = str(fd, 'loadedPayment') as PaymentStatus;
  const knowsStatus = STATUSES.includes(loadedStatus);
  const knowsPayment = PAYMENT_STATUSES.includes(loadedPayment);
  const staleMessage = 'Η παραγγελία άλλαξε στο μεταξύ (από άλλη καρτέλα ή από μια πληρωμή). Ανανεώστε τη σελίδα και δοκιμάστε ξανά.';
  const statusEdited = knowsStatus ? askedStatus !== loadedStatus : askedStatus !== order.status;
  if (statusEdited && knowsStatus && order.status !== loadedStatus) return { ok: false, message: staleMessage };
  const status = statusEdited ? askedStatus : order.status;
  const notify = bool(fd, 'notify');
  const trackingCarrier = str(fd, 'trackingCarrier') || null;
  const trackingNumber = str(fd, 'trackingNumber') || null;
  const actor = admin.name || admin.email;

  // The payment status is checked BEFORE anything is saved, so a refused change leaves the order exactly as it was.
  const asked = str(fd, 'paymentStatus') as PaymentStatus;
  const wanted: PaymentStatus = PAYMENT_STATUSES.includes(asked) ? asked : order.paymentStatus;
  const paymentEdited = knowsPayment ? wanted !== loadedPayment : wanted !== order.paymentStatus;
  if (paymentEdited && knowsPayment && order.paymentStatus !== loadedPayment) return { ok: false, message: staleMessage };
  const payment: PaymentStatus = paymentEdited ? wanted : order.paymentStatus;
  if (payment !== order.paymentStatus) {
    if (order.paymentStatus === 'refunded') return { ok: false, message: 'Η πληρωμή έχει επιστραφεί: δεν αλλάζει πια.' };
    if (payment === 'refunded' && order.paymentStatus !== 'paid') return { ok: false, message: 'Μόνο μια παραγγελία που έχει «Εξοφληθεί» μπορεί να σημειωθεί «Επιστροφή χρημάτων».' };
    if (order.paymentStatus === 'paid' && payment === 'failed') return { ok: false, message: 'Μια παραγγελία που έχει «Εξοφληθεί» δεν γίνεται «Απέτυχε». Αν επιστρέψατε τα χρήματα, επιλέξτε «Επιστροφή χρημάτων».' };
    if (order.paymentStatus === 'paid' && payment === 'pending' && order.paymentMethod === 'card' && order.paymentTransactionId) {
      return { ok: false, message: `Η πληρωμή έγινε με κάρτα (αναφορά ${order.paymentTransactionId}) και δεν αναιρείται από εδώ. Αν επιστρέψατε ΟΛΟΚΛΗΡΗ την πληρωμή στον πάροχο πληρωμών, επιλέξτε «Επιστροφή χρημάτων». Αν επιστρέψατε μόνο μια δεύτερη πληρωμή, πατήστε «Το χειρίστηκα» στο κόκκινο πλαίσιο της παραγγελίας.` };
    }
  }

  // refused up front, before anything is written: a cancelled order does not come back (its stock is already released)
  if (status !== order.status && order.status === 'cancelled') return { ok: false, message: 'Μια ακυρωμένη παραγγελία δεν επανέρχεται (το απόθεμα έχει ήδη αποδεσμευτεί). Δημιουργήστε νέα.' };

  // Tracking and notes follow the same rule as status and payment: only what the owner CHANGED from what the page showed is
  // written, and only if the row still holds what the page showed. (Not a version number: every payment webhook would bump
  // it and turn a harmless tracking-only save into an error.) A field the form does not carry is left alone; without the
  // «loaded…» copies (older callers) the asked value is written as before.
  const nl = (v: string) => v.replace(/\r\n/g, '\n'); // browsers send line breaks as CRLF, the row may hold either
  const textGuards: SQL[] = [];
  const textChanges: Partial<Pick<typeof orders.$inferInsert, 'trackingCarrier' | 'trackingNumber' | 'adminNotes'>> = {};
  const watch = (field: 'trackingCarrier' | 'trackingNumber' | 'adminNotes') => {
    if (!fd.has(field)) return;
    const asked = str(fd, field) || null;
    const loadedKey = `loaded${field[0].toUpperCase()}${field.slice(1)}`;
    if (!fd.has(loadedKey)) {
      textChanges[field] = asked;
      return;
    }
    const loaded = nl(String(fd.get(loadedKey) ?? '').trim()) || null;
    if ((asked === null ? null : nl(asked)) === loaded) return; // not edited
    textChanges[field] = asked;
    textGuards.push(loaded === null ? isNull(orders[field]) : sql`replace(${orders[field]}, char(13) || char(10), char(10)) = ${loaded}`);
  };
  watch('trackingCarrier');
  watch('trackingNumber');
  watch('adminNotes');

  // Everything that is written goes in ONE transaction: a refusal half-way (the order moved on while this was saved) undoes
  // what was written before it, instead of leaving a payment changed and a status not.
  try {
    await db.transaction(async (tx) => {
      // The payment is written first and only from the status that was read above: a payment that landed since (the webhook, the
      // buyer's return) must not be overwritten by this save, and a refused save changes nothing else on the order.
      if (payment !== order.paymentStatus) {
        const written = await tx
          .update(orders)
          .set({ paymentStatus: payment, paidAt: payment === 'paid' ? new Date() : payment === 'refunded' ? order.paidAt : null, ...(payment === 'refunded' ? { paymentFlag: null } : {}) })
          .where(and(eq(orders.id, id), eq(orders.paymentStatus, order.paymentStatus)))
          .returning({ id: orders.id });
        if (written.length === 0) throw new StaleOrder();
        const message = {
          paid: 'Σημειώθηκε ως εξοφλημένη.',
          pending: 'Η ένδειξη εξόφλησης αφαιρέθηκε.',
          failed: 'Σημειώθηκε ως αποτυχημένη πληρωμή.',
          refunded: 'Σημειώθηκε ως επιστραφείσα (χειροκίνητη επιστροφή από τον πάροχο πληρωμών).',
        }[payment];
        await addOrderEvent(id, 'payment', message, actor, tx);
        // Money marked as received for an order that is ALREADY cancelled (a bank transfer that arrived after the order expired, a
        // payment against a cancelled order): nothing is re-reserved and the status stays, because a cancelled order does not come
        // back. It goes on the owner's list (dashboard, order list) until he refunds it or places a new order for the customer.
        if (payment === 'paid' && order.status === 'cancelled') {
          await flagForReview(id, tx);
          await addOrderEvent(id, 'payment', 'ΠΡΟΣΟΧΗ: σημειώθηκε εξοφλημένη μια παραγγελία που είναι ήδη ακυρωμένη (π.χ. η κατάθεση ήρθε μετά τη λήξη της). Το απόθεμα δεν δεσμεύεται ξανά και η κατάσταση δεν αλλάζει. Επιστρέψτε τα χρήματα στον πελάτη και σημειώστε «Επιστροφή χρημάτων», ή δημιουργήστε νέα παραγγελία για τον πελάτη.', actor, tx);
        }
      }

      if (status === 'cancelled' && order.status !== 'cancelled') {
        await cancelOrder(id, actor, undefined, {}, tx); // restocks
        // Cancelling an order that ends up paid leaves money with the shop: put it on the owner's list until it is refunded. Where
        // the payment ends up: what this form asks for when it changes it, otherwise what the row holds NOW (read again here, so a
        // payment that landed after the order was loaded still counts). Someone who un-pays a hand-marked order and cancels it
        // together has not taken any money, so no refund alarm. The millisecond between the two reads cannot be driven from outside.
        const [now] = await tx.select({ paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, id));
        const finalPayment = payment !== order.paymentStatus ? payment : (now?.paymentStatus ?? order.paymentStatus);
        if (finalPayment === 'paid') {
          await flagForReview(id, tx);
          await addOrderEvent(id, 'payment', 'ΠΡΟΣΟΧΗ: ακυρώθηκε παραγγελία που είχε εξοφληθεί. Επιστρέψτε τα χρήματα στον πελάτη και σημειώστε «Επιστροφή χρημάτων».', actor, tx);
        }
      } else if (status !== order.status) {
        // only from the status read above: the automatic release may have cancelled (and restocked) the order since, and a
        // write without this condition would bring it back with its stock already returned
        const moved = await tx.update(orders).set({ status }).where(and(eq(orders.id, id), eq(orders.status, order.status))).returning({ id: orders.id });
        if (moved.length === 0) throw new StaleOrder();
        await addOrderEvent(id, 'status', `Κατάσταση: ${ORDER_STATUS_LABELS[order.status]} → ${ORDER_STATUS_LABELS[status]}.`, actor, tx);
      }

      if (Object.keys(textChanges).length > 0) {
        const saved = await tx.update(orders).set(textChanges).where(and(eq(orders.id, id), ...textGuards)).returning({ id: orders.id });
        if (saved.length === 0) throw new StaleOrder();
      }
      if (trackingNumber && trackingNumber !== order.trackingNumber && 'trackingNumber' in textChanges) {
        await addOrderEvent(id, 'shipping', `Αριθμός αποστολής: ${trackingNumber}${trackingCarrier ? ` (${trackingCarrier})` : ''}.`, actor, tx);
      }
    });
  } catch (err) {
    if (err instanceof StaleOrder) return { ok: false, message: staleMessage };
    throw err;
  }

  if (notify && status !== order.status) {
    const [full, settings] = await Promise.all([getOrderByNumber(order.number), getSettings()]);
    if (full) {
      const sent = await sendMail(orderStatusMail(full, settings));
      await addOrderEvent(id, 'email', sent ? `Στάλθηκε ενημέρωση «${ORDER_STATUS_LABELS[status]}» στο ${order.email}.` : 'ΑΠΟΤΥΧΙΑ αποστολής e-mail ενημέρωσης.', actor);
    }
  }
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: 'Η παραγγελία ενημερώθηκε.' };
}

/** «Το χειρίστηκα»: the owner has dealt with a payment problem on this order (refunded, phoned the customer, …). */
export async function resolvePaymentReview(fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = int(fd, 'id');
  const cleared = await db.update(orders).set({ paymentFlag: null }).where(and(eq(orders.id, id), eq(orders.paymentFlag, 'review'))).returning({ id: orders.id });
  if (cleared.length > 0) await addOrderEvent(id, 'payment', 'Έλεγχος πληρωμής: ολοκληρώθηκε.', admin.name || admin.email);
  revalidatePath('/admin');
  revalidatePath(`/admin/orders/${id}`);
}

/** Order page: the payment mails of this order that were given up are tried again now (after the mail service is fixed). */
export async function resendOrderMails(fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = int(fd, 'id');
  await resendGivenUpMails(id, admin.name || admin.email);
  revalidatePath('/admin');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

/** A paid payment that matched no order has been dealt with (refunded in the gateway, order created by hand, …). */
export async function resolveUnmatchedPayment(fd: FormData): Promise<void> {
  await requireAdmin();
  const note = str(fd, 'note').slice(0, 300) || null;
  await db.update(unmatchedPayments).set({ resolvedAt: new Date(), note }).where(and(eq(unmatchedPayments.id, int(fd, 'id')), isNull(unmatchedPayments.resolvedAt)));
  revalidatePath('/admin');
}

// ─── Products ────────────────────────────────────────────────────────────────
const VariantInput = z.object({
  id: z.number().int().positive().optional(),
  label: z.string().trim().min(1, 'Κενή συσκευασία').max(40),
  sku: z.string().trim().max(64),
  price: z.string().trim(),
  compareAt: z.string().trim().optional(),
  stock: z.number().int().min(0).max(100000),
  loadedStock: z.number().int().min(0).max(100000).optional(),
  trackStock: z.boolean(),
  availability: z.enum(AVAILABILITY).optional(),
  weightGrams: z.number().int().min(0).max(100000),
  barcode: z.string().trim().max(32).optional(),
  mpn: z.string().trim().max(80).optional(),
  imageUrl: z.string().trim().max(300).optional(),
  isActive: z.boolean(),
  priceVerified: z.boolean(),
});

async function uniqueSlug(base: string, ignoreId?: number): Promise<string> {
  let slug = base || `product-${randomToken(4).toLowerCase()}`;
  for (let i = 2; ; i++) {
    const [hit] = await db.select({ id: products.id }).from(products).where(and(eq(products.slug, slug), ne(products.id, ignoreId ?? -1)));
    if (!hit) return slug;
    slug = `${base}-${i}`;
  }
}

const MAX_PHOTOS = 12;

/** drizzle wraps the driver's error: SQLite's own message («UNIQUE constraint failed: variants.sku») sits on `.cause` */
function isUniqueViolation(err: unknown, column: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const text = e instanceof Error ? e.message : String(e);
    if (text.includes('UNIQUE') && text.includes(column)) return true;
  }
  return false;
}

/** A safety data sheet link is produced from a claimed upload; no File objects pass through actions any more. */
async function moveSds(file: string, slug: string): Promise<{ url: string; file: string }> {
  const dir = path.resolve(process.env.DATA_DIR || './data', 'uploads', 'sds');
  const name = `${slug.slice(0, 60)}-sds-${randomToken(5).toLowerCase()}.pdf`;
  const final = await moveClaimed(file, dir, name);
  return { url: `/media/sds/${name}`, file: final };
}

const uploadPath = (url: string) => path.resolve(process.env.DATA_DIR || './data', 'uploads', url.slice('/media/'.length));

export async function saveProduct(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (name.length < 2) return { ok: false, message: 'Συμπληρώστε ονομασία.', fieldErrors: { name: 'Υποχρεωτικό πεδίο' } };

  let variantRows: z.infer<typeof VariantInput>[];
  try {
    variantRows = z.array(VariantInput).min(1, 'Χρειάζεται τουλάχιστον μία συσκευασία').max(30).parse(JSON.parse(str(fd, 'variants') || '[]'));
  } catch (err) {
    return { ok: false, message: err instanceof z.ZodError ? (err.issues[0]?.message ?? 'Μη έγκυρες συσκευασίες') : 'Μη έγκυρες συσκευασίες.' };
  }
  // A saved size is removed only when the form names it here (the trash button). One that is merely missing from the form was
  // added from another tab or by another administrator, and is left alone.
  let removedIds: number[];
  try {
    removedIds = z.array(z.number().int().positive()).max(60).parse(JSON.parse(str(fd, 'removedVariantIds') || '[]'));
  } catch {
    return { ok: false, message: 'Η σελίδα είναι παλιά ή άκυρη: ανανεώστε τη και δοκιμάστε ξανά.' };
  }
  // The stock of a saved size is always applied as the owner's change on top of what is there now, which needs the figure the
  // page was loaded with. The editor always sends it; a request without it did not come from the current form.
  if (variantRows.some((v) => v.id !== undefined && v.loadedStock === undefined)) {
    return { ok: false, message: 'Η σελίδα είναι παλιά: ανανεώστε τη και κάντε ξανά τις αλλαγές.' };
  }
  const priced = variantRows.map((v) => ({ ...v, priceCents: parsePriceToCents(v.price), compareAtCents: v.compareAt ? parsePriceToCents(v.compareAt) : null }));
  if (priced.some((v) => v.priceCents === null || v.priceCents <= 0 || v.priceCents > MAX_PRICE_CENTS)) return { ok: false, message: 'Κάθε συσκευασία χρειάζεται έγκυρη τιμή (π.χ. 12,90· για χιλιάδες γράψτε 1250 ή 1.250,00).' };
  // an unreadable «Αρχική €» is refused like the price itself, never quietly saved as "no previous price"
  const badCompare = priced.find((v) => v.compareAt && (v.compareAtCents === null || v.compareAtCents <= 0 || v.compareAtCents > MAX_PRICE_CENTS));
  if (badCompare) return { ok: false, message: `Η αρχική τιμή «${badCompare.compareAt}» (${badCompare.label}) δεν διαβάζεται (π.χ. 14,90· για χιλιάδες 1250 ή 1.250,00). Αφήστε την κενή αν δεν υπάρχει.` };
  const badBarcode = priced.find((v) => v.barcode && !isValidGtin(v.barcode));
  if (badBarcode) return { ok: false, message: `Το barcode «${badBarcode.barcode}» (${badBarcode.label}) δεν είναι έγκυρο: χρειάζονται 8, 12 ή 13 ψηφία — πιθανότατα ένα ψηφίο είναι λάθος.` };

  const brandId = int(fd, 'brandId') || null;
  const categoryId = int(fd, 'categoryId') || null;
  const [brand] = brandId ? await db.select().from(brands).where(eq(brands.id, brandId)) : [];
  const [category] = categoryId ? await db.select().from(categories).where(eq(categories.id, categoryId)) : [];

  // An address is made up once, when the product is created. On an existing product an empty box means "leave it":
  // a rename must never move a page that Google and the Skroutz feed already point at. To change it, type the new one.
  const [current] = id ? await db.select({ slug: products.slug }).from(products).where(eq(products.id, id)) : [];
  const slug = await uniqueSlug(slugify(str(fd, 'slug') || current?.slug || (name.toLowerCase().startsWith((brand?.name ?? '\u0000').toLowerCase()) ? name : `${brand?.name ?? ''} ${name}`)), id ?? undefined);
  // the grade becomes an address (/viscosity/5w-30): «SAE 30» is stored as 30, and «80W/90» would be a broken link
  const viscosity = str(fd, 'viscosity').toUpperCase().replace(/\s/g, '').replace(/^SAE(?=\d)/, '') || null;
  if (viscosity && !/^[0-9A-Z][0-9A-Z.-]{0,15}$/.test(viscosity)) return { ok: false, message: `Το ιξώδες «${viscosity}» γράφεται με γράμματα, αριθμούς και παύλα: 5W-30, 75W-90, 46.`, fieldErrors: { viscosity: 'Π.χ. 5W-30' } };
  const specs = str(fd, 'specs').split(/\n|;/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
  const baseType = (['synthetic', 'synthetic-technology', 'semi-synthetic', 'mineral'] as const).find((b) => b === str(fd, 'baseType')) ?? null;

  const values = {
    slug, name, brandId, categoryId, viscosity, baseType: baseType as BaseType | null, specs,
    shortDescription: str(fd, 'shortDescription') || null,
    description: String(fd.get('description') ?? '').trim() || null,
    isActive: bool(fd, 'isActive'),
    isFeatured: bool(fd, 'isFeatured'),
    metaTitle: str(fd, 'metaTitle') || null,
    metaDescription: str(fd, 'metaDescription') || null,
    internalNotes: String(fd.get('internalNotes') ?? '').trim() || null,
    keywords: str(fd, 'keywords').slice(0, 400),
    searchText: buildSearchText({ brand: brand?.name, name, viscosity, specs, category: category?.name, keywords: str(fd, 'keywords').slice(0, 400), labels: priced.map((v) => v.label) }),
  };

  // Upload claims are tracked from the first claim onwards: a validation error, a failed file move
  // or a database failure must hand every claimed upload back so the form can be retried.
  const uploads: string[] = [];
  const photoClaims: Array<{ token: string; url: string }> = [];
  let sdsUpload: string | null = null;
  let sdsClaim: { token: string; file: string } | null = null;
  /** Returns false when at least one file could not be put back in staging. Every claim is still attempted. */
  const releaseAll = async (): Promise<boolean> => {
    const claims = [
      ...photoClaims.map((claim) => ({ token: claim.token, file: uploadPath(claim.url) })),
      ...(sdsClaim ? [sdsClaim] : []),
    ];
    let clean = true;
    for (const claim of claims) {
      try {
        await releaseUpload(claim.token, claim.file);
      } catch (err) {
        clean = false;
        console.error(`[upload] failed to return ${claim.token} to staging`, err);
      }
    }
    return clean;
  };
  const ROLLBACK_FAILED = 'Η αποθήκευση απέτυχε και κάποια αρχεία δεν μπόρεσαν να επιστραφούν. Ανεβάστε τα ξανά και δοκιμάστε ξανά.';
  const releaseOr = async (message: string): Promise<AdminFormState> => ((await releaseAll()) ? { ok: false, message } : { ok: false, message: ROLLBACK_FAILED });

  let productId: number;
  let hazard: ReturnType<typeof buildHazard> = null;
  let previousSdsUrl: string | null = null;
  try {
    // Hazard labelling & safety data sheet (lib/ghs.ts). A newly uploaded PDF replaces whatever link was there.
    const sdsToken = typeof fd.get('sds') === 'string' ? String(fd.get('sds')).trim() : '';
    if (sdsToken) {
      const claimed = await claimUpload(sdsToken, 'sds', me.id);
      if (!claimed) {
        return releaseOr('Το δελτίο δεδομένων ασφαλείας έληξε ή δεν είναι διαθέσιμο. Ανεβάστε το ξανά.');
      }
      try {
        const moved = await moveSds(claimed.file, slug);
        sdsUpload = moved.url;
        sdsClaim = { token: claimed.token, file: moved.file };
      } catch (err) {
        // The move itself failed: the file is still staged, so release the token without a file.
        await releaseUpload(claimed.token).catch((releaseErr) => console.error(`[upload] failed to return ${claimed.token} to staging`, releaseErr));
        throw err;
      }
    }
    const sdsLink = str(fd, 'sdsUrl');
    if (sdsLink && !sdsLink.startsWith('/media/sds/') && !/^https:\/\/[^\s]+$/i.test(sdsLink)) {
      return releaseOr('Ο σύνδεσμος του δελτίου δεδομένων ασφαλείας πρέπει να ξεκινά με https://');
    }
    hazard = buildHazard({
      none: bool(fd, 'hazardNone'), confirmed: bool(fd, 'hazardConfirmed'), signalWord: str(fd, 'hazardSignal'), pictograms: fd.getAll('hazardPictograms').map(String),
      statements: String(fd.get('hazardStatements') ?? ''), precautions: String(fd.get('hazardPrecautions') ?? ''), sdsUrl: sdsUpload ?? sdsLink,
    });
    const [previous] = id ? await db.select({ hazard: products.hazard }).from(products).where(eq(products.id, id)) : [];
    previousSdsUrl = previous?.hazard?.sdsUrl ?? null;

    // Photos were normalised to 1000×1000 WebP by the upload endpoint; here only the single-use tokens are claimed.
    const photoTokens = fd.getAll('images').filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (photoTokens.length > MAX_PHOTOS) {
      return releaseOr(`Έως ${MAX_PHOTOS} φωτογραφίες τη φορά.`);
    }
    const productsDir = path.resolve(process.env.DATA_DIR || './data', 'uploads', 'products');
    for (const token of photoTokens) {
      const claimed = await claimUpload(token, 'photo', me.id);
      if (!claimed) {
        return releaseOr('Μία φωτογραφία έληξε ή δεν είναι διαθέσιμη. Ανεβάστε την ξανά.');
      }
      const name = `${slug.slice(0, 60)}-${randomToken(5).toLowerCase()}.webp`;
      try {
        await moveClaimed(claimed.file, productsDir, name);
      } catch (err) {
        // This photo is still in staging (the rename failed), so release its token without a file.
        await releaseUpload(claimed.token).catch((releaseErr) => console.error(`[upload] failed to return ${claimed.token} to staging`, releaseErr));
        throw err;
      }
      uploads.push(`/media/products/${name}`);
      photoClaims.push({ token: claimed.token, url: `/media/products/${name}` });
    }

    // a size without a code gets one from the product and its label; two sizes must never end up with the same one
    const taken = new Set(priced.map((v) => v.sku.toUpperCase()).filter(Boolean));
    const skus = priced.map((v) => {
      if (v.sku) return v.sku;
      const base = `${slug}-${slugify(v.label)}`.toUpperCase().slice(0, 60);
      let sku = base;
      for (let n = 2; taken.has(sku); n++) sku = `${base.slice(0, 56)}-${n}`;
      taken.add(sku);
      return sku;
    });

    productId = await db.transaction(async (tx) => {
      let pid = id;
      if (pid) await tx.update(products).set({ ...values, hazard }).where(eq(products.id, pid));
      else pid = (await tx.insert(products).values({ ...values, hazard }).returning({ id: products.id }))[0].id;

      const keep = priced.flatMap((v) => (v.id ? [v.id] : []));
      // a size may only point at one of this product's own photos
      const ownImages = new Set([...(await tx.select({ url: productImages.url }).from(productImages).where(eq(productImages.productId, pid))).map((i) => i.url), ...uploads]);
      // one new photo and one size still on the main photo (of several): the photo is that size's
      const onMain = priced.flatMap((v, i) => (v.imageUrl && ownImages.has(v.imageUrl) ? [] : [i]));
      const lone = priced.length >= 2 && uploads.length === 1 && onMain.length === 1 ? onMain[0] : null;
      // archived sizes (below) are gone as far as this form is concerned
      const stored = await tx.select({ id: variants.id, priceCents: variants.priceCents, trackStock: variants.trackStock }).from(variants).where(and(eq(variants.productId, pid), isNull(variants.archivedAt)));
      const before = new Map(stored.map((v) => [v.id, v.priceCents]));
      const trackedNow = new Set(stored.filter((v) => v.trackStock).map((v) => v.id));

      // Only sizes the owner removed on purpose, of this product, and not sent back in the form. Before the writes below, so a new
      // size in the same save can take over the code of the one removed.
      const stillThere = new Set(keep);
      const removing = removedIds.filter((rid) => !stillThere.has(rid) && before.has(rid));
      if (removing.length) {
        // A size with price history or past orders is hidden instead of deleted, so its history stays. Its codes are freed: a size
        // added again later (the same SKU, the same barcode) must not be blocked by the hidden one.
        const withHistory = new Set([
          ...(await tx.select({ id: priceChanges.variantId }).from(priceChanges).where(inArray(priceChanges.variantId, removing))).map((r) => r.id),
          ...(await tx.select({ id: orderItems.variantId }).from(orderItems).where(inArray(orderItems.variantId, removing))).flatMap((r) => (r.id === null ? [] : [r.id])),
        ]);
        const archive = removing.filter((rid) => withHistory.has(rid));
        const drop = removing.filter((rid) => !withHistory.has(rid));
        if (drop.length) await tx.delete(variants).where(and(eq(variants.productId, pid), inArray(variants.id, drop)));
        if (archive.length) {
          await tx.update(variants)
            .set({ isActive: false, archivedAt: new Date(), sku: sql`${variants.sku} || '~archived-' || ${variants.id}`, barcode: null, mpn: null })
            .where(and(eq(variants.productId, pid), inArray(variants.id, archive)));
        }
      }

      for (const [sort, v] of priced.entries()) {
        const row = {
          productId: pid, label: v.label, volumeMl: parseVolumeMl(v.label), priceCents: v.priceCents!, compareAtCents: v.compareAtCents,
          stock: v.stock, trackStock: v.trackStock, availability: v.availability ?? 'in_stock', weightGrams: v.weightGrams, barcode: v.barcode ? normalizeGtin(v.barcode) : null, mpn: v.mpn || null, imageUrl: sort === lone ? uploads[0] : v.imageUrl && ownImages.has(v.imageUrl) ? v.imageUrl : null, isActive: v.isActive, priceVerified: v.priceVerified, sort,
          sku: skus[sort],
        };
        // Counted stock moves while the page is open (orders reserve, cancellations restock): for a saved size apply only what the
        // owner changed in the form on top of the stock as it is NOW, instead of writing back the number the page was loaded with.
        // The one exception is a size whose counting is being switched ON: the number typed is then a fresh count, and a size that
        // was not counting could not have been moved by orders. (A saved size always has loadedStock, checked above.)
        const startsCounting = v.trackStock && !(v.id !== undefined && trackedNow.has(v.id));
        const mine = v.id !== undefined ? and(eq(variants.id, v.id), eq(variants.productId, pid), isNull(variants.archivedAt)) : undefined;
        if (v.id !== undefined && !startsCounting) await tx.update(variants).set({ ...row, stock: sql`MAX(${variants.stock} + ${v.stock - v.loadedStock!}, 0)` }).where(mine);
        else if (v.id !== undefined) await tx.update(variants).set(row).where(mine);
        else await tx.insert(variants).values(row);
        const was = v.id ? before.get(v.id) : undefined;
        if (v.id && was !== undefined && was !== row.priceCents) await tx.insert(priceChanges).values({ variantId: v.id, oldCents: was, newCents: row.priceCents, source: 'product' });
      }

      if (uploads.length) {
        const existing = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, pid));
        await tx.insert(productImages).values(uploads.map((url, i) => ({ productId: pid!, url, alt: name, sort: existing.length + i })));
      }
      return pid;
    });
  } catch (err) {
    const clean = await releaseAll();
    if (!clean) {
      // Keep the original failure visible: a rollback problem must not hide why the save failed.
      console.error('[product] save failed after uploads were claimed', err);
      return { ok: false, message: ROLLBACK_FAILED };
    }
    if (isUniqueViolation(err, 'sku')) return { ok: false, message: 'Κάποιος κωδικός (SKU) χρησιμοποιείται ήδη — σε άλλο προϊόν ή δύο φορές εδώ.' };
    throw err;
  }

  // sizes kept from elsewhere (or hidden just now) change which pack labels the product is found by
  await rebuildSearchTexts({ productIds: [productId] });
  // the data sheet that was replaced or removed is no longer linked from anywhere
  if (previousSdsUrl && previousSdsUrl !== hazard?.sdsUrl) await removeUpload(previousSdsUrl);
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${productId}`);
  invalidateSkroutzFeed();
  // Reload after every save: the form's upload tokens have just been claimed, and a reload clears them.
  if (!id) redirect(`/admin/products/${productId}?created=1`);
  redirect(`/admin/products/${productId}?saved=1`);
}

/**
 * A product with past orders or price changes (on any size, archived ones too) is never deleted: its sizes would take the price
 * log with them and the order lines would point at nothing. The owner switches it off instead. The check runs inside the delete
 * transaction, so nothing is removed on a refusal; the disabled button on the page is only a hint.
 */
export async function deleteProduct(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id');
  const images = await db.select().from(productImages).where(eq(productImages.productId, id));
  const [row] = await db.select({ hazard: products.hazard }).from(products).where(eq(products.id, id));
  const deleted = await db.transaction(async (tx) => {
    if (await productHasHistory(id, tx)) return false;
    await tx.delete(variants).where(eq(variants.productId, id));
    await tx.delete(productImages).where(eq(productImages.productId, id));
    await tx.delete(products).where(eq(products.id, id));
    return true;
  });
  if (!deleted) return { ok: false, message: PRODUCT_HAS_HISTORY };
  await forgetTarget('product', id);
  await Promise.all([...images.map((i) => i.url), ...(row?.hazard?.sdsUrl ? [row.hazard.sdsUrl] : [])].map(removeUpload));
  invalidateSkroutzFeed();
  redirect('/admin/products?deleted=1');
}

async function removeUpload(url: string) {
  if (!url.startsWith('/media/')) return; // seeded images in /public/catalog are part of the repo
  // Still shown somewhere: past orders keep the photo they were placed with (order_items keeps the link), and one data
  // sheet can be linked from several products. Such a file stays; only a file nothing points at any more is deleted.
  const [used] = await db.all<{ n: number }>(sql`
    SELECT 1 AS n FROM order_items WHERE image_url = ${url}
    UNION ALL SELECT 1 FROM product_images WHERE url = ${url}
    UNION ALL SELECT 1 FROM variants WHERE image_url = ${url}
    UNION ALL SELECT 1 FROM products WHERE json_extract(hazard, '$.sdsUrl') = ${url}
    LIMIT 1`);
  if (used) return;
  const root = path.resolve(process.env.DATA_DIR || './data', 'uploads');
  const file = path.resolve(root, url.slice('/media/'.length));
  if (file.startsWith(root + path.sep)) await unlink(file).catch(() => undefined);
}

export async function imageAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const imageId = int(fd, 'imageId');
  const op = str(fd, 'op');
  const [image] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!image) return;
  if (op === 'delete') {
    await db.delete(productImages).where(eq(productImages.id, imageId));
    await db.update(variants).set({ imageUrl: null }).where(and(eq(variants.productId, image.productId), eq(variants.imageUrl, image.url)));
    await removeUpload(image.url);
  } else if (op === 'primary') {
    const all = await db.select().from(productImages).where(eq(productImages.productId, image.productId));
    const ordered = [image, ...all.filter((i) => i.id !== imageId).sort((a, b) => a.sort - b.sort)];
    for (const [sort, img] of ordered.entries()) await db.update(productImages).set({ sort }).where(eq(productImages.id, img.id));
  }
  revalidatePath(`/admin/products/${image.productId}`);
  invalidateSkroutzFeed();
}

// ─── Bulk prices ─────────────────────────────────────────────────────────────
export type PriceUpdate = { id: number; price: string; verified?: boolean; availability?: Availability };
export type PriceUpdateResult = {
  ok: boolean;
  message: string;
  /** rows as they now stand in the database, so the editor can reset its baseline */
  saved: Array<{ id: number; priceCents: number; previousCents: number | null; previousVerified?: boolean; changedAt: number | null; verified: boolean; availability: Availability }>;
  /** ids whose price could not be read (left untouched) */
  failed: number[];
};

const PriceUpdates = z.array(z.object({ id: z.number().int().positive(), price: z.string().trim().max(20), verified: z.boolean().optional(), availability: z.enum(AVAILABILITY).optional() })).min(1).max(2000);

/** The quick price editor sends only the rows the owner touched. Every real change is logged in price_changes. */
export async function updatePrices(input: PriceUpdate[]): Promise<PriceUpdateResult> {
  await requireAdmin();
  const parsed = PriceUpdates.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Δεν υπάρχουν αλλαγές προς αποθήκευση.', saved: [], failed: [] };

  const wanted = new Map(parsed.data.map((u) => [u.id, u]));
  // a size that was removed (archived) after this page was loaded is skipped; the rest of the batch still saves
  const rows = await db.select().from(variants).where(and(inArray(variants.id, [...wanted.keys()]), isNull(variants.archivedAt)));
  const skipped = wanted.size - rows.length;
  const skippedNote = skipped > 0 ? ` ${skipped === 1 ? 'Μία συσκευασία δεν υπάρχει πια και αγνοήθηκε' : `${skipped} συσκευασίες δεν υπάρχουν πια και αγνοήθηκαν`}.` : '';
  const saved: PriceUpdateResult['saved'] = [];
  const failed: number[] = [];
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const v of rows) {
      const update = wanted.get(v.id)!;
      const cents = parsePriceToCents(update.price);
      if (cents === null || cents <= 0 || cents > MAX_PRICE_CENTS) {
        failed.push(v.id);
        continue;
      }
      // availability travels with the price because this is the screen the owner lives in: "ran out of the 4 L" is one click here
      const availability = update.availability ?? v.availability;
      if (cents !== v.priceCents) {
        // typing a new price is itself a confirmation; an undo says what the confirmation was before
        const verified = update.verified ?? true;
        await tx.update(variants).set({ priceCents: cents, priceVerified: verified, availability }).where(eq(variants.id, v.id));
        await tx.insert(priceChanges).values({ variantId: v.id, oldCents: v.priceCents, newCents: cents, source: 'editor', createdAt: now });
        saved.push({ id: v.id, priceCents: cents, previousCents: v.priceCents, previousVerified: v.priceVerified, changedAt: now.getTime(), verified, availability });
      } else if ((update.verified !== undefined && update.verified !== v.priceVerified) || availability !== v.availability) {
        const verified = update.verified ?? v.priceVerified;
        await tx.update(variants).set({ priceVerified: verified, availability }).where(eq(variants.id, v.id));
        saved.push({ id: v.id, priceCents: cents, previousCents: null, changedAt: null, verified, availability });
      }
    }
  });

  revalidatePath('/admin/prices');
  invalidateSkroutzFeed();
  const count = saved.length === 1 ? 'Αποθηκεύτηκε 1 αλλαγή' : `Αποθηκεύτηκαν ${saved.length} αλλαγές`;
  if (failed.length) return { ok: false, message: `${count}. ${failed.length === 1 ? 'Μία τιμή δεν είναι έγκυρη' : `${failed.length} τιμές δεν είναι έγκυρες`} (σημειωμένες με κόκκινο).${skippedNote}`, saved, failed };
  return { ok: true, message: `${saved.length ? `${count}. ${saved.length === 1 ? 'Ισχύει' : 'Ισχύουν'} ήδη στο κατάστημα.` : 'Καμία αλλαγή.'}${skippedNote}`, saved, failed };
}

/**
 * CSV columns: sku;price[;stock][;verified][;availability] — separator ; or , — decimal comma or point (lib/price-csv.ts).
 * Unknown SKUs are reported, never created. An empty cell changes nothing: the file that was just exported can be uploaded as it is.
 */
export async function importPricesCsv(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const token = typeof fd.get('file') === 'string' ? String(fd.get('file')) : '';
  if (!token) return { ok: false, message: 'Επιλέξτε αρχείο CSV.' };
  const claimed = await claimUpload(token, 'price-csv', me.id);
  if (!claimed) return { ok: false, message: 'Το αρχείο έληξε ή δεν είναι διαθέσιμο. Ανεβάστε το ξανά.' };
  const releaseOnFailure = async () => {
    try {
      await releaseUpload(token);
    } catch (releaseErr) {
      console.error(`[upload] failed to return ${token} to staging`, releaseErr);
    }
  };
  try {
    const text = await readStagedText(claimed.file).catch(() => null);
    if (text === null) {
      await releaseOnFailure();
      return { ok: false, message: 'Το αρχείο δεν διαβάζεται. Ανεβάστε το ξανά.' };
    }

    const rows = await db.select({ id: variants.id, sku: variants.sku, priceCents: variants.priceCents, priceVerified: variants.priceVerified, stock: variants.stock, trackStock: variants.trackStock, availability: variants.availability }).from(variants);
    const plan = planPriceImport(text, new Map(rows.map(({ sku, ...v }) => [sku, v])));
    if (plan.error !== undefined) {
      await releaseOnFailure();
      return { ok: false, message: plan.error };
    }

    // all or nothing: half a price list is worse than none
    await db.transaction((tx) => applyPriceChanges(tx, plan.changes));
    await finishUpload(token);
    revalidatePath('/admin/prices');
    invalidateSkroutzFeed();
    // Completed even when some rows were skipped: returning ok:false here would keep the form-looking
    // failure and leave an already-consumed token in the UI. The message reports what changed.
    return { ok: true, message: describePriceImport(plan) };
  } catch (err) {
    // Also covers the database read before the plan: a failed import must not strand its upload.
    await releaseOnFailure();
    throw err;
  }
}

// ─── Brands, categories, coupons, messages ───────────────────────────────────
export async function saveBrand(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (!name) return { ok: false, message: 'Συμπληρώστε όνομα.' };
  // on an existing brand an empty slug box means "leave the address as it is" (see saveProduct)
  const [storedBrand] = id ? await db.select({ slug: brands.slug }).from(brands).where(eq(brands.id, id)) : [];
  const values = { name, slug: slugify(str(fd, 'slug') || storedBrand?.slug || name), country: str(fd, 'country') || null, description: str(fd, 'description') || null, isFeatured: bool(fd, 'isFeatured'), sort: int(fd, 'sort') };
  const [storedName] = id ? await db.select({ name: brands.name }).from(brands).where(eq(brands.id, id)) : [];
  try {
    if (id) await db.update(brands).set(values).where(eq(brands.id, id));
    else await db.insert(brands).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη μάρκα με αυτό το slug.' };
  }
  // the brand's name is part of what its products are found by
  if (id && storedName && storedName.name !== name) await rebuildSearchTexts({ brandId: id });
  revalidatePath('/admin/brands');
  invalidateSkroutzFeed();
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function saveCategory(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name');
  if (!name) return { ok: false, message: 'Συμπληρώστε όνομα.' };
  const parentId = int(fd, 'parentId') || null;
  if (id && parentId === id) return { ok: false, message: 'Μια κατηγορία δεν μπορεί να είναι γονέας του εαυτού της.' };
  // Two levels only (the admin list and the shop menu show no deeper): a subcategory under a subcategory, or a cycle,
  // would vanish from both.
  if (parentId) {
    const [parent] = await db.select({ parentId: categories.parentId }).from(categories).where(eq(categories.id, parentId));
    if (!parent) return { ok: false, message: 'Η κατηγορία-γονέας δεν υπάρχει πια. Ανανεώστε τη σελίδα.' };
    if (parent.parentId !== null) return { ok: false, message: 'Η κατηγορία-γονέας είναι ήδη υποκατηγορία. Επιλέξτε κύρια κατηγορία.' };
    if (id) {
      const [child] = await db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, id)).limit(1);
      if (child) return { ok: false, message: 'Η κατηγορία έχει υποκατηγορίες, άρα δεν μπορεί να γίνει υποκατηγορία η ίδια. Μετακινήστε πρώτα τις υποκατηγορίες της.' };
    }
  }
  // on an existing category an empty slug box means "leave the address as it is" (see saveProduct)
  const [storedCategory] = id ? await db.select({ slug: categories.slug, name: categories.name }).from(categories).where(eq(categories.id, id)) : [];
  const values = { name, slug: slugify(str(fd, 'slug') || storedCategory?.slug || name), parentId, icon: str(fd, 'icon') || null, description: str(fd, 'description') || null, isActive: bool(fd, 'isActive'), sort: int(fd, 'sort') };
  try {
    if (id) await db.update(categories).set(values).where(eq(categories.id, id));
    else await db.insert(categories).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη κατηγορία με αυτό το slug.' };
  }
  if (id && storedCategory && storedCategory.name !== name) await rebuildSearchTexts({ categoryId: id });
  revalidatePath('/admin/categories');
  invalidateSkroutzFeed();
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function deleteTaxon(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (str(fd, 'kind') === 'brand') {
    const affected = (await db.select({ id: products.id }).from(products).where(eq(products.brandId, id))).map((p) => p.id);
    await db.update(products).set({ brandId: null }).where(eq(products.brandId, id));
    await db.delete(brands).where(eq(brands.id, id));
    // the deleted brand's name must stop finding the products that carried it
    await rebuildSearchTexts({ productIds: affected });
    await forgetTarget('brand', id);
    revalidatePath('/admin/brands');
    invalidateSkroutzFeed();
  } else {
    const affected = (await db.select({ id: products.id }).from(products).where(eq(products.categoryId, id))).map((p) => p.id);
    await db.update(products).set({ categoryId: null }).where(eq(products.categoryId, id));
    await db.update(categories).set({ parentId: null }).where(eq(categories.parentId, id));
    await db.delete(categories).where(eq(categories.id, id));
    await rebuildSearchTexts({ productIds: affected });
    await forgetTarget('category', id);
    revalidatePath('/admin/categories');
    invalidateSkroutzFeed();
  }
}

/** The «Ισχύει για» picker: ids that still exist, nothing else. Empty lists = everything. */
async function readTargets(fd: FormData): Promise<Targets> {
  const pick = async (key: string, table: typeof products | typeof brands | typeof categories) => {
    const ids = cleanIds(fd.getAll(key));
    if (!ids.length) return [];
    const rows = await db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
    return rows.map((r) => r.id);
  };
  return { productIds: await pick('productIds', products), brandIds: await pick('brandIds', brands), categoryIds: await pick('categoryIds', categories) };
}

/** A typed percent, refused (not rounded or clamped) when it is not a whole number in range: «12,5» must not quietly become 13. */
function readPercent(fd: FormData, max: number): number | string {
  const raw = str(fd, 'value');
  if (!/^\d+$/.test(raw)) return raw ? 'Το ποσοστό πρέπει να είναι ακέραιος αριθμός.' : 'Συμπληρώστε αξία έκπτωσης.';
  const n = Number(raw);
  if (n < 1) return 'Συμπληρώστε αξία έκπτωσης.';
  if (n > max) return `Μέγιστο ${max}%.`;
  return n;
}

/** «από» / «έως» as Athens calendar days; the last day counts all the way to midnight. */
function readDateRange(fd: FormData): { ok: true; startsAt: Date | null; endsAt: Date | null } | { ok: false; message: string } {
  const startsAt = str(fd, 'startsAt') ? parseAthensDate(str(fd, 'startsAt'), 'start') : null;
  const endsAt = str(fd, 'endsAt') ? parseAthensDate(str(fd, 'endsAt'), 'end') : null;
  if ((str(fd, 'startsAt') && !startsAt) || (str(fd, 'endsAt') && !endsAt)) return { ok: false, message: 'Μη έγκυρη ημερομηνία.' };
  if (startsAt && endsAt && endsAt < startsAt) return { ok: false, message: 'Η ημερομηνία λήξης είναι πριν από την έναρξη.' };
  return { ok: true, startsAt, endsAt };
}

export async function saveCoupon(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const code = str(fd, 'code').toUpperCase().replace(/\s+/g, '');
  // refuse, do not clean: stripping «ΦΘΙΝΟΠΩΡΟ2026» down to «2026» saved a different code than the owner typed
  if (/[^A-Z0-9_-]/.test(code)) return { ok: false, message: 'Ο κωδικός μπορεί να έχει μόνο λατινικά γράμματα, αριθμούς, - και _ (όχι ελληνικά ή σύμβολα).' };
  const type = (['percent', 'fixed', 'free_shipping'] as const).find((t) => t === str(fd, 'type'));
  if (code.length < 3 || !type) return { ok: false, message: 'Συμπληρώστε κωδικό (τουλάχιστον 3 χαρακτήρες) και τύπο.' };
  let value = 0;
  if (type === 'percent') {
    const percent = readPercent(fd, 100);
    if (typeof percent === 'string') return { ok: false, message: percent };
    value = percent;
  } else if (type === 'fixed') {
    value = parsePriceToCents(str(fd, 'value')) ?? 0;
    if (value <= 0) return { ok: false, message: 'Συμπληρώστε αξία έκπτωσης.' };
  }
  // filled-in numbers are read strictly: «abc» as «Μέγιστες χρήσεις» used to save 0 (every customer told «εξαντλήθηκε»)
  // and an unreadable minimum («1.250») used to save no minimum at all
  const rawMax = str(fd, 'maxUses');
  if (rawMax && !/^[1-9]\d{0,8}$/.test(rawMax)) return { ok: false, message: 'Οι μέγιστες χρήσεις πρέπει να είναι θετικός ακέραιος αριθμός (ή αφήστε το κενό για απεριόριστες).' };
  const rawMin = str(fd, 'minSubtotal');
  const minSubtotalCents = rawMin ? parsePriceToCents(rawMin) : 0;
  if (minSubtotalCents === null) return { ok: false, message: 'Η ελάχιστη αγορά δεν είναι έγκυρο ποσό (π.χ. 30 ή 30,50).' };
  const range = readDateRange(fd);
  if (!range.ok) return { ok: false, message: range.message };
  const targets = await readTargets(fd);
  const values = {
    code, type, value, minSubtotalCents, maxUses: rawMax ? Number(rawMax) : null,
    startsAt: range.startsAt, endsAt: range.endsAt, isActive: bool(fd, 'isActive'),
    // free shipping takes nothing off a price, so "skip sale items" would only make it refuse a cart of sale items
    excludeSaleItems: type !== 'free_shipping' && bool(fd, 'excludeSaleItems'), ...targets,
  };
  try {
    if (id) await db.update(coupons).set(values).where(eq(coupons.id, id));
    else await db.insert(coupons).values(values);
  } catch {
    return { ok: false, message: 'Υπάρχει ήδη κουπόνι με αυτόν τον κωδικό.' };
  }
  revalidatePath('/admin/coupons');
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function deleteCoupon(fd: FormData): Promise<void> {
  await requireAdmin();
  await db.delete(coupons).where(eq(coupons.id, int(fd, 'id')));
  revalidatePath('/admin/coupons');
}

export async function saveSale(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const id = int(fd, 'id') || null;
  const name = str(fd, 'name').slice(0, 120);
  const type = (['percent', 'fixed'] as const).find((t) => t === str(fd, 'type'));
  if (name.length < 2 || !type) return { ok: false, message: 'Συμπληρώστε όνομα και τύπο έκπτωσης.' };
  let value: number;
  if (type === 'percent') {
    const percent = readPercent(fd, 90);
    if (typeof percent === 'string') return { ok: false, message: percent };
    value = percent;
  } else {
    value = parsePriceToCents(str(fd, 'value')) ?? 0;
    if (value <= 0) return { ok: false, message: 'Συμπληρώστε αξία έκπτωσης.' };
  }
  const targets = await readTargets(fd);
  if (!hasTargets(targets)) return { ok: false, message: 'Επιλέξτε τουλάχιστον ένα προϊόν, μάρκα ή κατηγορία.' };
  const range = readDateRange(fd);
  if (!range.ok) return { ok: false, message: range.message };
  const values = { name, type, value, ...targets, startsAt: range.startsAt, endsAt: range.endsAt, isActive: bool(fd, 'isActive') };
  if (id) await db.update(sales).set(values).where(eq(sales.id, id));
  else await db.insert(sales).values(values);
  // every storefront page reads prices per request, so the new price shows on the next load
  revalidatePath('/admin/sales');
  invalidateSkroutzFeed();
  return { ok: true, message: 'Αποθηκεύτηκε.' };
}

export async function deleteSale(fd: FormData): Promise<void> {
  await requireAdmin();
  await db.delete(sales).where(eq(sales.id, int(fd, 'id')));
  revalidatePath('/admin/sales');
  invalidateSkroutzFeed();
}

/** Product search for the «Ισχύει για» picker: at most 50 hits, so a form never carries the whole catalogue. */
export async function searchAdminProducts(query: string): Promise<{ id: number; name: string }[]> {
  await requireAdmin();
  const normalized = normalizeText(String(query ?? '').slice(0, 80));
  if (normalized.length < 2) return [];
  const terms = normalized.split(' ').filter(Boolean);
  const rows = await db
    .select({ id: products.id, name: products.name, brand: brands.name, searchText: products.searchText })
    .from(products)
    .leftJoin(brands, eq(products.brandId, brands.id));
  return rows
    .filter((r) => {
      const hay = normalizeText(`${r.brand ?? ''} ${r.name} ${r.searchText}`);
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, 50)
    .map((r) => ({ id: r.id, name: [r.brand, r.name].filter(Boolean).join(' ') }));
}

export async function messageAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (str(fd, 'op') === 'delete') await db.delete(contactMessages).where(eq(contactMessages.id, id));
  else await db.update(contactMessages).set({ isRead: str(fd, 'op') === 'read' }).where(eq(contactMessages.id, id));
  revalidatePath('/admin/messages');
}

/** A visitor who asked for the "orders are open" e-mail wants off the list (their right under GDPR). */
export async function deleteSignup(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = int(fd, 'id');
  if (id) await db.delete(launchSignups).where(eq(launchSignups.id, id));
  revalidatePath('/admin/stats');
}

// ─── Settings ────────────────────────────────────────────────────────────────
const TIME =/^([01]\d|2[0-3]):[0-5]\d$/;

/** Links pasted by the owner end up in <a href>: accept https only, and forgive a missing "https://". */
function cleanUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.includes('.') ? url.toString() : '';
  } catch {
    return '';
  }
}

/** Owners often type "@handle" instead of the profile link. */
function instagramUrl(raw: string): string {
  const handle = /^@?([a-z0-9._]{1,30})$/i.exec(raw)?.[1];
  return cleanUrl(handle && !/instagram\.com/i.test(raw) ? `https://www.instagram.com/${handle}/` : raw);
}

export async function saveSettings(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const current = await getSettings();
  // Whatever cannot be saved as typed is refused with a reason (the form keeps what was typed) — never quietly turned
  // into "closed", zero or an empty link while the screen says «αποθηκεύτηκαν».
  const problems: string[] = [];
  const euro = (key: string, fallback: number, label: string) => {
    const raw = str(fd, key);
    if (!raw) return fallback;
    const cents = parsePriceToCents(raw);
    if (cents === null) problems.push(`${label}: «${raw}» δεν είναι ποσό`);
    return cents ?? fallback;
  };
  const num = (key: string, fallback: number, label: string) => {
    const raw = str(fd, key);
    if (!raw) return fallback;
    const n = Number(raw.replace(',', '.'));
    if (Number.isFinite(n) && n >= 0) return n;
    problems.push(`${label}: «${raw}» δεν είναι αριθμός (γράψτε μόνο ψηφία)`);
    return fallback;
  };
  const link = (key: string, label: string, clean: (raw: string) => string = cleanUrl) => {
    const raw = str(fd, key);
    const url = clean(raw);
    if (raw && !url) problems.push(`Ο σύνδεσμος ${label} δεν είναι έγκυρος`);
    return url;
  };

  const DAY_NAMES = ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο', 'Κυριακή'];
  const hours: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const raw = (k: string) => str(fd, `h${day}-${k}`);
    const open = raw('open'), close = raw('close'), open2 = raw('open2'), close2 = raw('close2');
    const closed = bool(fd, `h${day}-closed`) || (!open && !close);
    if (closed) return { day, closed: true, open: TIME.test(open) ? open : '', close: TIME.test(close) ? close : '' };
    const name = DAY_NAMES[day - 1];
    if (!open || !close) problems.push(`${name}: συμπληρώστε και άνοιγμα και κλείσιμο, ή σημειώστε «κλειστά»`);
    else if (!TIME.test(open) || !TIME.test(close)) problems.push(`${name}: οι ώρες γράφονται ως 08:30`);
    else if (close <= open) problems.push(`${name}: το κλείσιμο (${close}) είναι πριν το άνοιγμα (${open})`);
    else if (open2 || close2) {
      if (!TIME.test(open2) || !TIME.test(close2)) problems.push(`${name}: συμπληρώστε και τις δύο ώρες του απογεύματος, ή αφήστε τες κενές`);
      else if (open2 < close || close2 <= open2) problems.push(`${name}: το απογευματινό ωράριο πρέπει να ξεκινά μετά το πρωινό και να κλείνει μετά το άνοιγμά του`);
    }
    return { day, closed: false, open, close, ...(open2 && close2 ? { open2, close2 } : {}) };
  });

  // The IBAN is shown to customers who pay by transfer: stored without spaces, and only if its country, length and check digits add up.
  let badIban = false;
  const bankAccounts: BankAccount[] = [0, 1, 2, 3]
    .map((i) => ({ bank: str(fd, `bank${i}-name`), iban: normalizeIban(str(fd, `bank${i}-iban`)), holder: str(fd, `bank${i}-holder`) }))
    .filter((a, i) => {
      if (a.iban && !a.bank) problems.push(`Τραπεζικός λογαριασμός ${i + 1}: συμπληρώστε και το όνομα της τράπεζας`);
      if (a.bank && !a.iban) problems.push(`Τραπεζικός λογαριασμός ${i + 1}: λείπει το IBAN`);
      if (a.iban && !isValidIban(a.iban)) {
        badIban = true;
        problems.push(`Τραπεζικός λογαριασμός ${i + 1}: Μη έγκυρο IBAN (έλεγξτε τα ψηφία)`);
      }
      return a.bank && a.iban;
    });
  // Only while ordering is open: the website-only site keeps the transfer box ticked by default with no account, and a refusal
  // there would block every other setting from being saved.
  if (!badIban && bool(fd, 'bankTransfer') && bool(fd, 'ordersEnabled') && commerceEnabled() && !bankAccounts.some((a) => isValidIban(a.iban))) {
    problems.push('Η τραπεζική κατάθεση είναι ενεργή, αλλά δεν υπάρχει έγκυρο IBAN. Προσθέστε IBAN ή απενεργοποιήστε την κατάθεση');
  }

  const shop: ShopSettings['shop'] = {
    ...current.shop,
    name: str(fd, 'name') || DEFAULT_SETTINGS.shop.name, legalName: str(fd, 'legalName'), tagline: str(fd, 'tagline'), phone: str(fd, 'phone'), mobile: str(fd, 'mobile'), fax: str(fd, 'fax'),
    email: str(fd, 'email'), street: str(fd, 'street'), city: str(fd, 'city'), postalCode: str(fd, 'postalCode'), region: str(fd, 'region'),
    lat: num('lat', current.shop.lat, 'Γεωγραφικό πλάτος'), lng: num('lng', current.shop.lng, 'Γεωγραφικό μήκος'),
    instagramUrl: link('instagramUrl', 'Instagram', instagramUrl), skroutzUrl: link('skroutzUrl', 'Skroutz'),
    vatNumber: str(fd, 'vatNumber'), taxOffice: str(fd, 'taxOffice'), gemi: str(fd, 'gemi'), hours, hoursVerified: bool(fd, 'hoursVerified'),
    foundedYear: ((raw) => {
      if (!raw) return 0;
      const y = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
      if (y >= 1900 && y <= new Date().getFullYear()) return y;
      problems.push(`Έτος ίδρυσης: «${raw}» — γράψτε το με τέσσερα ψηφία (π.χ. 1992)`);
      return current.shop.foundedYear;
    })(str(fd, 'foundedYear')),
    accelerateDealer: bool(fd, 'accelerateDealer'),
  };
  if (!shop.phone || !shop.street || !shop.city) return { ok: false, message: 'Τηλέφωνο, οδός και πόλη είναι υποχρεωτικά.' };
  if (shop.lat > 90 || shop.lng > 180) problems.push('Οι συντεταγμένες του χάρτη δεν είναι έγκυρες');

  // a rating is only worth showing if it is exactly what the platform shows: anything outside 1–5 is a typo, not a rating
  const rating = (key: string, label: string) => {
    const raw = str(fd, key);
    if (!raw) return 0;
    const n = Number(raw.replace(',', '.'));
    if (Number.isFinite(n) && n >= 1 && n <= 5) return Math.round(n * 10) / 10;
    problems.push(`${label}: «${raw}» — γράψτε μόνο τον αριθμό, από 1 έως 5 (π.χ. 4,8)`);
    return 0;
  };
  const googleRating = rating('googleRating', 'Βαθμολογία στο Google'), skroutzRating = rating('skroutzRating', 'Βαθμολογία στο Skroutz');

  const googleUrl = link('googleUrl', 'των κριτικών Google');
  const shipping = {
    courierEnabled: bool(fd, 'courierEnabled'), pickupEnabled: bool(fd, 'pickupEnabled'), carrierName: str(fd, 'carrierName') || 'Courier', deliveryEstimate: str(fd, 'deliveryEstimate'),
    baseCents: euro('baseCents', current.shipping.baseCents, 'Βασικά μεταφορικά'), baseWeightKg: num('baseWeightKg', current.shipping.baseWeightKg, 'Βάρος που καλύπτει η βασική χρέωση (kg)'), perExtraKgCents: euro('perExtraKgCents', current.shipping.perExtraKgCents, 'Χρέωση ανά επιπλέον κιλό'),
    freeOverCents: euro('freeOverCents', 0, 'Όριο δωρεάν μεταφορικών'), freeMaxWeightKg: num('freeMaxWeightKg', 0, 'Όριο βάρους για δωρεάν μεταφορικά (kg)'), codFeeCents: euro('codFeeCents', 0, 'Χρέωση αντικαταβολής'),
  };
  const vatRaw = str(fd, 'vatRate');
  const vatRate = int(fd, 'vatRate', current.tax.vatRate);
  // whole percentages only (orders store the rate as an integer): «13,5» is refused, never quietly saved as 14
  if (vatRaw && (!/^\d{1,2}([.,]0+)?$/.test(vatRaw) || vatRate > 50)) problems.push(`ΦΠΑ: «${vatRaw}» δεν είναι ακέραιο ποσοστό`);
  if (problems.length) return { ok: false, message: `Δεν αποθηκεύτηκε τίποτα. ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` · και ${problems.length - 3} ακόμη` : ''}.` };

  // Two settings decide where customers' money goes and whether they can order at all: the bank accounts shown for transfers and
  // the online-orders switch. A stolen session alone must not change them (an IBAN swapped in the middle of the night), so they
  // need the identity confirmation (password + authenticator code, five minutes) like the administrator changes. Everything else in
  // this form saves without it. Nothing is saved when the confirmation is missing, as with every other refusal here.
  const accountKey = (list: BankAccount[]) => JSON.stringify(list.map((a) => [a.bank.trim(), normalizeIban(a.iban), a.holder.trim()]));
  const guarded: string[] = [];
  if (accountKey(bankAccounts) !== accountKey(current.payments.bankAccounts)) guarded.push('τους τραπεζικούς λογαριασμούς');
  if (bool(fd, 'ordersEnabled') !== current.storefront.ordersEnabled) guarded.push('το άνοιγμα ή το κλείσιμο των online παραγγελιών');
  if (guarded.length && !(await hasSudoSession())) {
    return { ok: false, message: `Δεν αποθηκεύτηκε τίποτα. Για να αλλάξετε ${guarded.join(' και ')} χρειάζεται πρώτα επιβεβαίωση ταυτότητας (κωδικός και κωδικός εφαρμογής) στην ενότητα «Επιβεβαίωση ταυτότητας» στην κορυφή της σελίδας.` };
  }

  await saveSettingsGroup('shop', shop);
  await saveSettingsGroup('storefront', { demoMode: bool(fd, 'demoMode'), ordersEnabled: bool(fd, 'ordersEnabled'), launchSignup: bool(fd, 'launchSignup'), announcement: str(fd, 'announcement'), lowStockThreshold: int(fd, 'lowStockThreshold', 3), b2bPage: bool(fd, 'b2bPage') });
  await saveSettingsGroup('reviews', {
    googleUrl,
    googleRating, googleCount: googleRating ? int(fd, 'googleCount') : 0,
    skroutzRating, skroutzCount: skroutzRating ? int(fd, 'skroutzCount') : 0,
  });
  await saveSettingsGroup('shipping', shipping);
  await saveSettingsGroup('payments', { cod: bool(fd, 'cod'), bankTransfer: bool(fd, 'bankTransfer'), payInStore: bool(fd, 'payInStore'), card: bool(fd, 'card'), bankAccounts });
  await saveSettingsGroup('tax', { vatRate });

  revalidatePath('/', 'layout');
  invalidateSkroutzFeed();
  return { ok: true, message: 'Οι ρυθμίσεις αποθηκεύτηκαν.' };
}

// ─── Skroutz feed ────────────────────────────────────────────────────────────
export async function saveSkroutzSettings(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  await requireAdmin();
  const feedEnabled = bool(fd, 'feedEnabled');
  await saveSettingsGroup('skroutz', {
    feedEnabled,
    // what is declared for a size that is on the shelf: only the first two phrases describe that
    availability: SKROUTZ_AVAILABILITY.slice(0, 2).find((a) => a === str(fd, 'availability')) ?? DEFAULT_SETTINGS.skroutz.availability,
    // 0 would tell Skroutz that every size whose stock is not counted is sold out
    defaultQuantity: Math.min(1000, Math.max(1, int(fd, 'defaultQuantity', DEFAULT_SETTINGS.skroutz.defaultQuantity))),
  });
  revalidatePath('/admin/skroutz');
  invalidateSkroutzFeed();
  return { ok: true, message: feedEnabled ? 'Αποθηκεύτηκε. Το αρχείο είναι ανοιχτό για το Skroutz.' : 'Αποθηκεύτηκε. Το αρχείο παραμένει κλειστό: το βλέπετε μόνο εσείς.' };
}

export type CodeUpdate = { id: number; barcode: string; mpn: string };
export type CodeUpdateResult = {
  ok: boolean;
  message: string;
  saved: CodeUpdate[];
  /** rows left untouched, and why */
  failed: Array<{ id: number; reason: 'invalid' | 'duplicate' }>;
};

const CodeUpdates = z.array(z.object({ id: z.number().int().positive(), barcode: z.string().trim().max(32), mpn: z.string().trim().max(80) })).min(1).max(2000);

/** Barcode + manufacturer code per pack size, from the quick editor in Admin → Skroutz. An empty value clears the field. */
export async function updateCodes(input: CodeUpdate[]): Promise<CodeUpdateResult> {
  await requireAdmin();
  const parsed = CodeUpdates.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Δεν υπάρχουν αλλαγές προς αποθήκευση.', saved: [], failed: [] };

  // archived sizes are not editable: an id from a stale page is skipped, the rest of the batch still saves
  const all = await db.select({ id: variants.id, barcode: variants.barcode }).from(variants).where(isNull(variants.archivedAt));
  const known = new Set(all.map((v) => v.id));
  const skipped = new Set(parsed.data.map((u) => u.id)).size - parsed.data.filter((u) => known.has(u.id)).length;
  const skippedNote = skipped > 0 ? ` ${skipped === 1 ? 'Μία συσκευασία δεν υπάρχει πια και αγνοήθηκε' : `${skipped} συσκευασίες δεν υπάρχουν πια και αγνοήθηκαν`}.` : '';
  // every pack size has its own barcode: the same one twice means the same bottle was scanned twice
  const owner = new Map(all.flatMap((v) => (v.barcode ? [[v.barcode, v.id] as const] : [])));
  const saved: CodeUpdate[] = [];
  const failed: CodeUpdateResult['failed'] = [];

  await db.transaction(async (tx) => {
    for (const u of parsed.data) {
      if (!known.has(u.id)) continue;
      const barcode = normalizeGtin(u.barcode);
      if (barcode && !isValidGtin(barcode)) {
        failed.push({ id: u.id, reason: 'invalid' });
        continue;
      }
      if (barcode && owner.has(barcode) && owner.get(barcode) !== u.id) {
        failed.push({ id: u.id, reason: 'duplicate' });
        continue;
      }
      await tx.update(variants).set({ barcode: barcode || null, mpn: u.mpn || null }).where(and(eq(variants.id, u.id), isNull(variants.archivedAt)));
      for (const [code, id] of owner) if (id === u.id) owner.delete(code);
      if (barcode) owner.set(barcode, u.id);
      saved.push({ id: u.id, barcode, mpn: u.mpn });
    }
  });

  revalidatePath('/admin/skroutz');
  invalidateSkroutzFeed();
  const count = saved.length === 1 ? 'Αποθηκεύτηκε 1 συσκευασία' : `Αποθηκεύτηκαν ${saved.length} συσκευασίες`;
  if (failed.length) return { ok: false, message: `${count}. ${failed.length === 1 ? 'Ένα barcode δεν έγινε δεκτό' : `${failed.length} barcodes δεν έγιναν δεκτά`} (σημειωμένα με κόκκινο).${skippedNote}`, saved, failed };
  return { ok: true, message: `${saved.length ? `${count}.` : 'Καμία αλλαγή.'}${skippedNote}`, saved, failed };
}

/** CSV columns: sku;ean;mpn (either of the last two may be missing) — for a list sent by a distributor. Empty cells change nothing. */
export async function importCodesCsv(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const me = await requireAdmin();
  const token = typeof fd.get('file') === 'string' ? String(fd.get('file')) : '';
  if (!token) return { ok: false, message: 'Επιλέξτε αρχείο CSV.' };
  const claimed = await claimUpload(token, 'code-csv', me.id);
  if (!claimed) return { ok: false, message: 'Το αρχείο έληξε ή δεν είναι διαθέσιμο. Ανεβάστε το ξανά.' };
  const releaseOnFailure = async () => {
    try {
      await releaseUpload(token);
    } catch (releaseErr) {
      console.error(`[upload] failed to return ${token} to staging`, releaseErr);
    }
  };
  try {
    const text = await readStagedText(claimed.file).catch(() => null);
    if (text === null) {
      await releaseOnFailure();
      return { ok: false, message: 'Το αρχείο δεν διαβάζεται. Ανεβάστε το ξανά.' };
    }
    const { header, rows: lines } = parseCsv(text);
    const col = { sku: header.indexOf('sku'), ean: header.findIndex((h) => h === 'ean' || h.startsWith('barcode') || h === 'gtin'), mpn: header.findIndex((h) => h === 'mpn' || h.startsWith('κωδ')) };
    if (col.sku < 0 || (col.ean < 0 && col.mpn < 0)) {
      await releaseOnFailure();
      return { ok: false, message: 'Η πρώτη γραμμή πρέπει να έχει στήλη «sku» και τουλάχιστον μία από τις «ean», «mpn».' };
    }

    const rows = await db.select({ id: variants.id, sku: variants.sku, barcode: variants.barcode }).from(variants);
    const bySku = new Map(rows.map((v) => [v.sku, v]));
    const owner = new Map(rows.flatMap((v) => (v.barcode ? [[v.barcode, v.id] as const] : [])));
    let updated = 0;
    const unknown: string[] = [];
    const rejected: string[] = [];
    // all or nothing: a failure halfway through the file must not leave half the barcodes applied
    await db.transaction(async (tx) => {
      for (const { cells } of lines) {
        // a code typed by hand in the product editor keeps its case, so the cell is tried as written first
        const typed = cells[col.sku] ?? '';
        const sku = bySku.has(typed) ? typed : typed.toUpperCase();
        if (!sku) continue;
        const current = bySku.get(sku);
        if (!current) {
          unknown.push(sku);
          continue;
        }
        const patch: { barcode?: string; mpn?: string } = {};
        const ean = col.ean >= 0 ? normalizeGtin(cells[col.ean] ?? '') : '';
        if (ean) {
          // a rejected row is left alone entirely, so it is not reported as both updated and rejected
          if (!isValidGtin(ean) || (owner.has(ean) && owner.get(ean) !== current.id)) {
            rejected.push(sku);
            continue;
          }
          patch.barcode = ean;
        }
        const mpn = col.mpn >= 0 ? (cells[col.mpn] ?? '').slice(0, 80) : '';
        if (mpn) patch.mpn = mpn;
        if (!patch.barcode && !patch.mpn) continue;
        await tx.update(variants).set(patch).where(eq(variants.id, current.id));
        if (patch.barcode) {
          // the pack's previous barcode is free again: a later row of the same file may give it to another pack
          for (const [code, id] of owner) if (id === current.id) owner.delete(code);
          owner.set(patch.barcode, current.id);
        }
        updated++;
      }
    });

    revalidatePath('/admin/skroutz');
    invalidateSkroutzFeed();
    await finishUpload(token);
    const list = (label: string, skus: string[]) => (skus.length ? ` ${label}: ${skus.slice(0, 6).join(', ')}${skus.length > 6 ? '…' : ''}.` : '');
    // Completed even with unknown/rejected codes; the message names them.
    return { ok: true, message: `${updated === 1 ? 'Ενημερώθηκε 1 συσκευασία' : `Ενημερώθηκαν ${updated} συσκευασίες`}.${list('Μη έγκυρο ή διπλό barcode', rejected)}${list('Άγνωστοι κωδικοί', unknown)}` };
  } catch (err) {
    // A database failure mid-import must leave the CSV claimable for a retry.
    await releaseOnFailure();
    throw err;
  }
}
