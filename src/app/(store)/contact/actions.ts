'use server';

import { z } from 'zod';
import { saveEnquiry } from '@/lib/enquiries';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const Schema = z.object({
  name: z.string().trim().min(2, 'Συμπληρώστε το όνομά σας').max(120),
  email: z.string().trim().toLowerCase().email('Μη έγκυρο e-mail').max(160),
  phone: z.string().trim().max(30).optional(),
  subject: z.string().trim().max(160).optional(),
  message: z.string().trim().min(10, 'Γράψτε μας λίγα περισσότερα').max(4000),
  // honeypot: real visitors never see or fill this field
  website: z.string().max(0).optional(),
});

export type ContactState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

export async function sendContactMessage(_prev: ContactState, formData: FormData): Promise<ContactState> {
  // A mistake is not a message: attempts get a loose budget here, and only a message that is about to be stored
  // counts against the strict one below — four typos used to lock a visitor out with nothing sent.
  const ip = await clientIp();
  const tooMany = { ok: false, message: 'Λάβαμε ήδη αρκετά μηνύματα από εσάς. Δοκιμάστε ξανά αργότερα ή καλέστε μας.' };
  if (!rateLimit(`contact-try:${ip}`, 20, 15 * 60 * 1000).ok) return tooMany;

  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    if (fieldErrors.website) return { ok: true, message: 'Ευχαριστούμε! Θα επικοινωνήσουμε σύντομα μαζί σας.' }; // bot: pretend success
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors };
  }

  const { website: _w, ...data } = parsed.data;
  if (!rateLimit(`contact:${ip}`, 4, 15 * 60 * 1000).ok) return tooMany;
  await saveEnquiry({ kind: 'contact', ...data });
  return { ok: true, message: 'Ευχαριστούμε! Λάβαμε το μήνυμά σας και θα επικοινωνήσουμε σύντομα μαζί σας.' };
}
