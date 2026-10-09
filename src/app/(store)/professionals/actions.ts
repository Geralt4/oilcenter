'use server';

import { z } from 'zod';
import { looksLikePhone, saveEnquiry } from '@/lib/enquiries';
import { BUSINESS_TYPES, isValidAfm, type BusinessType } from '@/lib/quote';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const Schema = z.object({
  business: z.string().trim().min(2, 'Συμπληρώστε την επωνυμία').max(160),
  type: z.enum(keys(BUSINESS_TYPES)).catch('garage'),
  afm: z.string().trim().max(14).refine((v) => v === '' || isValidAfm(v), 'Το ΑΦΜ δεν είναι έγκυρο — ελέγξτε τα ψηφία ή αφήστε το κενό').optional(),
  name: z.string().trim().min(2, 'Συμπληρώστε το όνομά σας').max(120),
  phone: z.string().trim().max(30).refine(looksLikePhone, 'Συμπληρώστε ένα τηλέφωνο επικοινωνίας'),
  email: z.string().trim().toLowerCase().email('Συμπληρώστε ένα e-mail για να σας στείλουμε την προσφορά').max(160),
  message: z.string().trim().min(10, 'Γράψτε μας τι χρειάζεστε: προϊόντα, συσκευασίες, ποσότητες').max(4000),
  // honeypot: real visitors never see or fill this field
  website: z.string().max(0).optional(),
});

/** `values`: what was typed, sent back with the errors so the form can show it again (React resets a form after its action) */
export type QuoteState = { ok: boolean; message: string; fieldErrors?: Record<string, string>; values?: Record<string, string> } | null;

export async function sendQuoteRequest(_prev: QuoteState, formData: FormData): Promise<QuoteState> {
  // the page can be switched off (Admin → Ρυθμίσεις): its action goes with it
  if (!(await getSettings()).storefront.b2bPage) return { ok: false, message: 'Η φόρμα δεν είναι διαθέσιμη. Καλέστε μας.' };

  // A mistake is not a message: attempts get a loose budget here, and only a message that is about to be stored
  // counts against the strict one below — four typos used to lock a visitor out with nothing sent.
  const ip = await clientIp();
  const tooMany = { ok: false, message: 'Λάβαμε ήδη αρκετά μηνύματα από εσάς. Δοκιμάστε ξανά αργότερα ή καλέστε μας.' };
  if (!rateLimit(`quote-try:${ip}`, 20, 15 * 60 * 1000).ok) return tooMany;

  const thanks = 'Ευχαριστούμε! Λάβαμε το αίτημά σας και θα επικοινωνήσουμε μαζί σας με προσφορά.';
  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    if (fieldErrors.website) return { ok: true, message: thanks }; // bot: pretend success
    const values = Object.fromEntries([...formData].flatMap(([k, v]) => (typeof v === 'string' && !k.startsWith('$') ? [[k, v.slice(0, 4000)]] : [])));
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors, values };
  }

  const d = parsed.data;
  if (!rateLimit(`quote:${ip}`, 4, 15 * 60 * 1000).ok) return tooMany;
  await saveEnquiry({
    kind: 'quote',
    name: d.name,
    phone: d.phone,
    email: d.email,
    subject: d.business,
    message: d.message,
    details: [
      ['Επιχείρηση', d.business],
      ['Δραστηριότητα', BUSINESS_TYPES[d.type as BusinessType]],
      ['ΑΦΜ', d.afm],
    ],
  });
  return { ok: true, message: thanks };
}
