'use server';

import { z } from 'zod';
import { db } from '@/lib/db';
import { launchSignups } from '@/lib/db/schema';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { recordSignup } from '@/lib/stats';

const Schema = z.object({
  email: z.string().trim().toLowerCase().email('Γράψτε ένα έγκυρο e-mail').max(160),
  consent: z.literal('on', { message: 'Χρειαζόμαστε τη συγκατάθεσή σας για να σας γράψουμε.' }),
  // honeypot: real visitors never see or fill this field
  website: z.string().max(0).optional(),
});

export type SignupState = { ok: boolean; message: string } | null;

/** "Tell me when online orders open" — only while ordering is closed and the owner has the sign-up switched on. */
export async function signupForLaunch(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const limited = rateLimit(`launch-signup:${await clientIp()}`, 5, 15 * 60 * 1000);
  if (!limited.ok) return { ok: false, message: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.' };

  const { storefront } = await getSettings();
  if (storefront.ordersEnabled || !storefront.launchSignup) return { ok: false, message: 'Η εγγραφή δεν είναι διαθέσιμη αυτή τη στιγμή.' };

  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'website') return { ok: true, message: 'Ευχαριστούμε! Θα σας ειδοποιήσουμε.' }; // bot: pretend success
    return { ok: false, message: issue?.message ?? 'Ελέγξτε το e-mail σας.' };
  }

  const inserted = await db.insert(launchSignups).values({ email: parsed.data.email }).onConflictDoNothing().returning({ id: launchSignups.id });
  if (inserted.length) await recordSignup();
  // same answer whether or not the address was already on the list: the form must not reveal who has signed up
  return { ok: true, message: 'Ευχαριστούμε! Θα σας στείλουμε ένα e-mail μόλις ανοίξουν οι online παραγγελίες.' };
}
