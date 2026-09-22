'use client';

import { useActionState } from 'react';
import { CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { sendVehicleEnquiry, type OilFinderState } from '@/app/(store)/find-my-oil/actions';
import { buttonClass } from '@/components/ui/button';
import { COMMON_MAKES, FUELS, NEEDS, VEHICLE_TYPES } from '@/lib/oil-finder';

const optional = <span className="font-normal text-ink-400">(προαιρετικό)</span>;

/** `product`: set when the visitor came from a product page asking «ταιριάζει αυτό στο όχημά μου;» */
export function OilFinderForm({ product }: { product?: { slug: string; name: string } | null }) {
  const [state, action, pending] = useActionState<OilFinderState, FormData>(sendVehicleEnquiry, null);

  if (state?.ok) {
    return (
      <div role="status" className="rounded-3xl bg-emerald-50 p-8 text-center">
        <CircleCheck className="mx-auto h-10 w-10 text-emerald-600" />
        <p className="mt-3 font-semibold text-emerald-950">{state.message}</p>
      </div>
    );
  }

  const err = (name: string) => state?.fieldErrors?.[name];
  // React resets a form to its default values once the action returns: echo what was typed, or a mistake in one field wipes the other eleven
  const was = (name: string, fallback = '') => state?.values?.[name] ?? fallback;
  const error = (name: string) => err(name) && <p className="mt-1.5 text-sm font-medium text-red-600">{err(name)}</p>;

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" noValidate>
      {state && !state.ok && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800 sm:col-span-2">{state.message}</p>}
      {product && (
        <p className="rounded-2xl border border-line bg-ink-50 p-3 text-sm text-ink-700 sm:col-span-2">
          Ρωτάτε αν ταιριάζει το <strong className="font-semibold text-ink-950">{product.name}</strong>.
          <input type="hidden" name="product" value={product.slug} />
        </p>
      )}

      <div>
        <label htmlFor="of-vehicle" className="label">Τι οδηγείτε;</label>
        <select id="of-vehicle" name="vehicle" defaultValue={was('vehicle', 'car')} className="field cursor-pointer">
          {Object.entries(VEHICLE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="of-need" className="label">Τι χρειάζεστε;</label>
        <select id="of-need" name="need" defaultValue={was('need', 'engine-oil')} className="field cursor-pointer">
          {Object.entries(NEEDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="of-make" className="label">Μάρκα</label>
        <input id="of-make" name="make" defaultValue={was('make')} list="of-makes" required autoComplete="off" placeholder="π.χ. Toyota" aria-invalid={Boolean(err('make'))} className="field" />
        <datalist id="of-makes">{COMMON_MAKES.map((m) => <option key={m} value={m} />)}</datalist>
        {error('make')}
      </div>
      <div>
        <label htmlFor="of-model" className="label">Μοντέλο</label>
        <input id="of-model" name="model" defaultValue={was('model')} required autoComplete="off" placeholder="π.χ. Yaris" aria-invalid={Boolean(err('model'))} className="field" />
        {error('model')}
      </div>

      <div>
        <label htmlFor="of-year" className="label">Έτος</label>
        <input id="of-year" name="year" defaultValue={was('year')} required inputMode="numeric" maxLength={4} autoComplete="off" placeholder="π.χ. 2016" aria-invalid={Boolean(err('year'))} className="field tabular" />
        {error('year')}
      </div>
      <div>
        <label htmlFor="of-fuel" className="label">Καύσιμο</label>
        <select id="of-fuel" name="fuel" defaultValue={was('fuel', 'petrol')} className="field cursor-pointer">
          {Object.entries(FUELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="of-engine" className="label">Κινητήρας {optional}</label>
        <input id="of-engine" name="engine" defaultValue={was('engine')} autoComplete="off" placeholder="π.χ. 1.4 D-4D 90 PS" className="field" />
      </div>
      <div>
        <label htmlFor="of-km" className="label">Χιλιόμετρα {optional}</label>
        <input id="of-km" name="km" defaultValue={was('km')} inputMode="numeric" autoComplete="off" placeholder="π.χ. 145.000" className="field tabular" />
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="of-notes" className="label">Κάτι ακόμη που πρέπει να ξέρουμε; {optional}</label>
        <textarea id="of-notes" name="notes" defaultValue={was('notes')} rows={3} placeholder="π.χ. καίει λίγο λάδι, έχει φίλτρο μικροσωματιδίων (DPF), τι λάδι έβαζα μέχρι τώρα…" className="field resize-y" />
      </div>

      <div>
        <label htmlFor="of-name" className="label">Ονοματεπώνυμο</label>
        <input id="of-name" name="name" defaultValue={was('name')} autoComplete="name" required aria-invalid={Boolean(err('name'))} className="field" />
        {error('name')}
      </div>
      <div>
        <label htmlFor="of-phone" className="label">Τηλέφωνο</label>
        <input id="of-phone" name="phone" defaultValue={was('phone')} type="tel" inputMode="tel" autoComplete="tel" required aria-invalid={Boolean(err('phone'))} className="field tabular" />
        {error('phone')}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="of-email" className="label">E-mail {optional}</label>
        <input id="of-email" name="email" defaultValue={was('email')} type="email" inputMode="email" autoComplete="email" aria-invalid={Boolean(err('email'))} className="field" />
        {error('email')}
      </div>

      {/* honeypot */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass({ variant: 'dark', size: 'lg' })}>
          {pending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-4 w-4" />}
          Πείτε μου ποιο λάδι θέλει
        </button>
      </div>
    </form>
  );
}
