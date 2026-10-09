'use client';

import { CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { sendQuoteRequest, type QuoteState } from '@/app/(store)/professionals/actions';
import { buttonClass } from '@/components/ui/button';
import { useKeptForm } from '@/components/ui/use-kept-form';
import { BUSINESS_TYPES } from '@/lib/quote';

const optional = <span className="font-normal text-ink-400">(προαιρετικό)</span>;

export function QuoteForm() {
  const { state, pending, formRef, formAction, onSubmit } = useKeptForm<QuoteState>(sendQuoteRequest, null);

  if (state?.ok) {
    return (
      <div role="status" className="rounded-3xl bg-emerald-50 p-8 text-center">
        <CircleCheck className="mx-auto h-10 w-10 text-emerald-600" />
        <p className="mt-3 font-semibold text-emerald-950">{state.message}</p>
      </div>
    );
  }

  const err = (name: string) => state?.fieldErrors?.[name];
  // without JavaScript the page reloads with the errors: echo what was typed (with it, useKeptForm keeps the fields as they are)
  const was = (name: string, fallback = '') => state?.values?.[name] ?? fallback;
  const error = (name: string) => err(name) && <p className="mt-1.5 text-sm font-medium text-red-600">{err(name)}</p>;

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {state && !state.ok && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800 sm:col-span-2">{state.message}</p>}

      <div>
        <label htmlFor="q-business" className="label">Επωνυμία επιχείρησης</label>
        <input id="q-business" name="business" defaultValue={was('business')} required autoComplete="organization" aria-invalid={Boolean(err('business'))} className="field" />
        {error('business')}
      </div>
      <div>
        <label htmlFor="q-type" className="label">Δραστηριότητα</label>
        <select id="q-type" name="type" defaultValue={was('type', 'garage')} className="field cursor-pointer">
          {Object.entries(BUSINESS_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="q-name" className="label">Υπεύθυνος επικοινωνίας</label>
        <input id="q-name" name="name" defaultValue={was('name')} required autoComplete="name" aria-invalid={Boolean(err('name'))} className="field" />
        {error('name')}
      </div>
      <div>
        <label htmlFor="q-afm" className="label">ΑΦΜ {optional}</label>
        <input id="q-afm" name="afm" defaultValue={was('afm')} inputMode="numeric" maxLength={11} autoComplete="off" aria-invalid={Boolean(err('afm'))} className="field tabular" />
        {error('afm')}
      </div>

      <div>
        <label htmlFor="q-phone" className="label">Τηλέφωνο</label>
        <input id="q-phone" name="phone" defaultValue={was('phone')} type="tel" inputMode="tel" autoComplete="tel" required aria-invalid={Boolean(err('phone'))} className="field tabular" />
        {error('phone')}
      </div>
      <div>
        <label htmlFor="q-email" className="label">E-mail</label>
        <input id="q-email" name="email" defaultValue={was('email')} type="email" inputMode="email" autoComplete="email" required aria-invalid={Boolean(err('email'))} className="field" />
        {error('email')}
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="q-message" className="label">Τι χρειάζεστε;</label>
        <textarea id="q-message" name="message" defaultValue={was('message')} rows={6} required aria-invalid={Boolean(err('message'))} placeholder="Προϊόντα ή προδιαγραφές, συσκευασίες (1 L, 5 L, 20 L, βαρέλι) και περίπου πόσα το μήνα. π.χ. 5W-30 C3 σε 20 L, 10W-40 σε βαρέλι 208 L, αντιψυκτικό G12 σε 5 L." className="field resize-y" />
        {error('message')}
      </div>

      {/* honeypot */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass({ variant: 'dark', size: 'lg' })}>
          {pending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-4 w-4" />}
          Ζητήστε προσφορά
        </button>
      </div>
    </form>
  );
}
