'use server';

import { redirect } from 'next/navigation';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword, randomToken, sha256, verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, requireCustomer } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { customers } from '@/lib/db/schema';
import { passwordResetMail, sendMail } from '@/lib/email';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { accountsAvailable, canOrderNow } from '@/lib/catalogue-mode';

export type FormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

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
  const limited = rateLimit(`register:${await clientIp()}`, 6, 30 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.' };

  const parsed = z
    .object({ firstName: z.string().trim().min(2, 'Συμπληρώστε το όνομά σας').max(80), lastName: z.string().trim().min(2, 'Συμπληρώστε το επώνυμό σας').max(80), email, password, acceptTerms: z.literal('on', { error: 'Πρέπει να αποδεχτείτε τους όρους' }) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors: fieldErrors(parsed.error) };

  const [existing] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, parsed.data.email));
  if (existing) return { ok: false, message: 'Υπάρχει ήδη λογαριασμός με αυτό το e-mail.', fieldErrors: { email: 'Συνδεθείτε ή κάντε επαναφορά κωδικού.' } };

  const [created] = await db
    .insert(customers)
    .values({ email: parsed.data.email, passwordHash: await hashPassword(parsed.data.password), firstName: parsed.data.firstName, lastName: parsed.data.lastName })
    .returning({ id: customers.id });
  // Deliberately NOT linking earlier guest orders by e-mail: registration does not prove ownership
  // of that address, so it must not surface another person's order history. Guest orders stay
  // reachable through the order lookup (number + e-mail) or the secret link in the confirmation e-mail.
  await createSession('customer', created.id, 0);
  redirect(safeNext(formData.get('next')));
}

export async function loginCustomer(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const parsed = z.object({ email, password: z.string().min(1).max(200) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Συμπληρώστε e-mail και κωδικό.' };

  const limited = rateLimit(`login:${await clientIp()}:${parsed.data.email}`, 8, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: `Πολλές αποτυχημένες προσπάθειες. Δοκιμάστε ξανά σε ${Math.ceil(limited.retryAfterSec / 60)} λεπτά.` };

  const [customer] = await db.select().from(customers).where(eq(customers.email, parsed.data.email));
  // Hash even when the account does not exist, so response time does not reveal which e-mails are registered.
  const valid = await verifyPassword(parsed.data.password, customer?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!customer || !valid) return { ok: false, message: 'Λάθος e-mail ή κωδικός.' };

  await createSession('customer', customer.id, customer.tokenVersion);
  redirect(safeNext(formData.get('next')));
}

export async function logoutCustomer(): Promise<void> {
  await destroySession('customer');
  redirect('/');
}

export async function requestPasswordReset(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const done: FormState = { ok: true, message: 'Αν υπάρχει λογαριασμός με αυτό το e-mail, σας στείλαμε οδηγίες επαναφοράς.' };
  const limited = rateLimit(`reset:${await clientIp()}`, 5, 30 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.' };
  const parsed = email.safeParse(formData.get('email'));
  if (!parsed.success) return { ok: false, message: 'Μη έγκυρο e-mail.' };

  const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, parsed.data));
  if (customer) {
    const token = randomToken();
    await db.update(customers).set({ resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 60 * 60 * 1000) }).where(eq(customers.id, customer.id));
    await sendMail(passwordResetMail(parsed.data, token, await getSettings()));
  }
  return done; // identical answer either way
}

export async function resetPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  // the pages are hidden in catalogue mode (lib/catalogue-mode.ts); the action must not be a way around that
  if (!(await accountsAvailable())) return { ok: false, message: 'Οι λογαριασμοί πελατών θα ανοίξουν μαζί με τις online παραγγελίες.' };
  const parsed = z.object({ token: z.string().min(20).max(200), password }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: 'Ελέγξτε τον κωδικό.', fieldErrors: fieldErrors(parsed.error) };

  const [customer] = await db
    .select({ id: customers.id, tokenVersion: customers.tokenVersion })
    .from(customers)
    .where(and(eq(customers.resetTokenHash, sha256(parsed.data.token)), gt(customers.resetTokenExpires, new Date())));
  if (!customer) return { ok: false, message: 'Ο σύνδεσμος επαναφοράς δεν ισχύει ή έχει λήξει. Ζητήστε νέο.' };

  // Bump the session version: every other session for this account (e.g. one an attacker opened with the
  // old password) is invalidated, and only this browser stays signed in.
  const nextVersion = customer.tokenVersion + 1;
  await db.update(customers).set({ passwordHash: await hashPassword(parsed.data.password), resetTokenHash: null, resetTokenExpires: null, tokenVersion: nextVersion }).where(eq(customers.id, customer.id));
  await createSession('customer', customer.id, nextVersion);
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
