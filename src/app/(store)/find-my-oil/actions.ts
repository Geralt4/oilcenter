'use server';

import { z } from 'zod';
import { getProductBySlug } from '@/lib/catalog';
import { looksLikePhone, saveEnquiry } from '@/lib/enquiries';
import { FUELS, NEEDS, VEHICLE_TYPES, type Fuel, type Need, type VehicleType } from '@/lib/oil-finder';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const Schema = z.object({
  vehicle: z.enum(keys(VEHICLE_TYPES)).catch('car'),
  make: z.string().trim().min(2, 'Συμπληρώστε τη μάρκα').max(60),
  model: z.string().trim().min(1, 'Συμπληρώστε το μοντέλο').max(80),
  year: z.coerce.number({ error: 'Συμπληρώστε το έτος, π.χ. 2016' }).int('Συμπληρώστε το έτος, π.χ. 2016').min(1950, 'Συμπληρώστε το έτος, π.χ. 2016').max(new Date().getFullYear() + 1, 'Ελέγξτε το έτος'),
  fuel: z.enum(keys(FUELS)).catch('unsure'),
  engine: z.string().trim().max(80).optional(),
  km: z.string().trim().max(20).optional(),
  need: z.enum(keys(NEEDS)).catch('engine-oil'),
  notes: z.string().trim().max(2000).optional(),
  name: z.string().trim().min(2, 'Συμπληρώστε το όνομά σας').max(120),
  phone: z.string().trim().max(30).refine(looksLikePhone, 'Συμπληρώστε ένα τηλέφωνο για να σας καλέσουμε'),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Μη έγκυρο e-mail').max(160)]).optional(),
  product: z.string().trim().max(120).optional(),
  // honeypot: real visitors never see or fill this field
  website: z.string().max(0).optional(),
});

/** `values`: what was typed, sent back with the errors so the form can show it again (React resets a form after its action) */
export type OilFinderState = { ok: boolean; message: string; fieldErrors?: Record<string, string>; values?: Record<string, string> } | null;

export async function sendVehicleEnquiry(_prev: OilFinderState, formData: FormData): Promise<OilFinderState> {
  // A mistake is not a message: attempts get a loose budget here, and only a message that is about to be stored
  // counts against the strict one below — four typos used to lock a visitor out with nothing sent.
  const ip = await clientIp();
  const tooMany = { ok: false, message: 'Λάβαμε ήδη αρκετά μηνύματα από εσάς. Δοκιμάστε ξανά αργότερα ή καλέστε μας.' };
  if (!rateLimit(`oil-finder-try:${ip}`, 20, 15 * 60 * 1000).ok) return tooMany;

  const thanks = 'Ευχαριστούμε! Θα σας καλέσουμε με το λιπαντικό που ζητά ο κατασκευαστής του οχήματός σας.';
  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    if (fieldErrors.website) return { ok: true, message: thanks }; // bot: pretend success
    const values = Object.fromEntries([...formData].flatMap(([k, v]) => (typeof v === 'string' && !k.startsWith('$') ? [[k, v.slice(0, 2000)]] : [])));
    return { ok: false, message: 'Ελέγξτε τα σημειωμένα πεδία.', fieldErrors, values };
  }

  const d = parsed.data;
  // the product page passes its slug along: «ταιριάζει αυτό στο όχημά μου;»
  const product = d.product ? await getProductBySlug(d.product) : null;
  const productName = product ? [product.brand?.name, product.name].filter(Boolean).join(' ') : null;

  if (!rateLimit(`oil-finder:${ip}`, 4, 15 * 60 * 1000).ok) return tooMany;
  await saveEnquiry({
    kind: 'oil-finder',
    name: d.name,
    phone: d.phone,
    email: d.email,
    subject: `${d.make} ${d.model} ${d.year}`,
    message: d.notes,
    details: [
      ['Όχημα', VEHICLE_TYPES[d.vehicle as VehicleType]],
      ['Μάρκα', d.make],
      ['Μοντέλο', d.model],
      ['Έτος', String(d.year)],
      ['Καύσιμο', FUELS[d.fuel as Fuel]],
      ['Κινητήρας', d.engine],
      ['Χιλιόμετρα', d.km],
      ['Χρειάζεται', NEEDS[d.need as Need]],
      ['Ρωτά για', productName],
    ],
  });
  return { ok: true, message: thanks };
}
