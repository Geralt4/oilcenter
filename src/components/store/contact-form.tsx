'use client';

import { CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { sendContactMessage, type ContactState } from '@/app/(store)/contact/actions';
import { buttonClass } from '@/components/ui/button';
import { useKeptForm } from '@/components/ui/use-kept-form';

export function ContactForm() {
  const { state, pending, formRef, formAction, onSubmit } = useKeptForm<ContactState>(sendContactMessage, null);

  if (state?.ok) {
    return (
      <div role="status" className="rounded-3xl bg-emerald-50 p-8 text-center">
        <CircleCheck className="mx-auto h-10 w-10 text-emerald-600" />
        <p className="mt-3 font-semibold text-emerald-950">{state.message}</p>
      </div>
    );
  }

  const err = (name: string) => state?.fieldErrors?.[name];
  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {state && !state.ok && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800 sm:col-span-2">{state.message}</p>}
      <div>
        <label htmlFor="c-name" className="label">Ονοματεπώνυμο</label>
        <input id="c-name" name="name" autoComplete="name" required aria-invalid={Boolean(err('name'))} className="field" />
        {err('name') && <p className="mt-1.5 text-sm font-medium text-red-600">{err('name')}</p>}
      </div>
      <div>
        <label htmlFor="c-phone" className="label">Τηλέφωνο <span className="font-normal text-ink-400">(προαιρετικό)</span></label>
        <input id="c-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" className="field" />
      </div>
      <div>
        <label htmlFor="c-email" className="label">E-mail</label>
        <input id="c-email" name="email" type="email" inputMode="email" autoComplete="email" required aria-invalid={Boolean(err('email'))} className="field" />
        {err('email') && <p className="mt-1.5 text-sm font-medium text-red-600">{err('email')}</p>}
      </div>
      <div>
        <label htmlFor="c-subject" className="label">Θέμα <span className="font-normal text-ink-400">(προαιρετικό)</span></label>
        <input id="c-subject" name="subject" placeholder="π.χ. Λάδι για Toyota Yaris 2018" className="field" />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="c-message" className="label">Μήνυμα</label>
        <textarea id="c-message" name="message" rows={5} required aria-invalid={Boolean(err('message'))} placeholder="Πείτε μας μάρκα, μοντέλο, έτος και κινητήρα του οχήματος για να σας προτείνουμε το σωστό προϊόν." className="field resize-y" />
        {err('message') && <p className="mt-1.5 text-sm font-medium text-red-600">{err('message')}</p>}
      </div>
      {/* honeypot */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass({ variant: 'dark', size: 'lg' })}>
          {pending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-4 w-4" />}
          Αποστολή μηνύματος
        </button>
      </div>
    </form>
  );
}
