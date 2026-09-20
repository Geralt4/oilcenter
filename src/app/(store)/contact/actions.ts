'use server';

import { z } from 'zod';
import { db } from '@/lib/db';
import { contactMessages } from '@/lib/db/schema';
import { contactMail, sendMail } from '@/lib/email';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';

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
  const limited = rateLimit(`contact:${await clientIp()}`, 4, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Λάβαμε ήδη αρκετά μηνύματα από εσάς. Δοκιμάστε ξανά αργότερα ή καλέστε μας.' };

  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    if (fieldErrors.website) return { ok: true, message: 'Ευχαριστούμε! Θα επικοινωνήσουμε σύντομα μαζί σας.' }; // bot: pretend success
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors };
  }

  const { website: _w, ...data } = parsed.data;
  await db.insert(contactMessages).values({ name: data.name, email: data.email, phone: data.phone || null, subject: data.subject || null, message: data.message });
  await sendMail(contactMail(data, await getSettings()));
  return { ok: true, message: 'Ευχαριστούμε! Λάβαμε το μήνυμά σας και θα επικοινωνήσουμε σύντομα μαζί σας.' };
}
