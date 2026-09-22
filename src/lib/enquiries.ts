import { db } from '@/lib/db';
import { contactMessages, type EnquiryKind } from '@/lib/db/schema';
import { contactMail, sendMail } from '@/lib/email';
import { getSettings } from '@/lib/settings.server';

/*
 * Everything a visitor sends through a form lands in one inbox (Admin → Μηνύματα) and in the shop's e-mail.
 * Server-only: never import this from a client component (it opens the database).
 */

export const ENQUIRY_KINDS: EnquiryKind[] = ['contact', 'oil-finder', 'quote'];

export const ENQUIRY_KIND_LABELS: Record<EnquiryKind, string> = {
  contact: 'Επικοινωνία',
  'oil-finder': 'Ποιο λάδι;',
  quote: 'Επαγγελματίες',
};

const MAIL_HEADINGS: Record<EnquiryKind, string | undefined> = {
  contact: undefined,
  'oil-finder': 'Ερώτηση για όχημα',
  quote: 'Αίτημα προσφοράς',
};

export type EnquiryInput = {
  kind: EnquiryKind;
  name: string;
  email?: string | null;
  phone?: string | null;
  subject?: string | null;
  message?: string | null;
  /** the form's structured answers, in the order they should be read; empty values are dropped */
  details?: Array<[string, string | null | undefined]>;
};

export async function saveEnquiry(input: EnquiryInput): Promise<void> {
  const details = (input.details ?? []).filter((d): d is [string, string] => Boolean(d[1]?.trim())).map(([k, v]) => [k, v.trim()] as [string, string]);
  const row = { kind: input.kind, name: input.name, email: input.email || '', phone: input.phone || null, subject: input.subject || null, message: input.message || '', details: details.length ? details : null };
  await db.insert(contactMessages).values(row);
  await sendMail(contactMail({ ...row, heading: MAIL_HEADINGS[input.kind] }, await getSettings()));
}

/** Greek numbers are 10 digits; +30 and spaces are forgiven. Used by the forms that ask to be called back. */
export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 && /^[\d\s+().-]+$/.test(value);
}
