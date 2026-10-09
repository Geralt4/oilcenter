'use client';

import Link from 'next/link';
import { BellRing, Check, LoaderCircle } from 'lucide-react';
import { signupForLaunch, type SignupState } from '@/app/(store)/checkout/signup-actions';
import { buttonClass } from '@/components/ui/button';
import { useKeptForm } from '@/components/ui/use-kept-form';

/** "Tell me when online orders open". Shown on the closed checkout when the owner has it switched on. */
export function LaunchSignupForm() {
  const { state, pending, formRef, formAction, onSubmit } = useKeptForm<SignupState>(signupForLaunch, null);

  if (state?.ok) {
    return (
      <p role="status" className="mt-6 flex items-start gap-2.5 rounded-xl bg-white p-4 text-sm font-medium text-emerald-700">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        {state.message}
      </p>
    );
  }

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="mt-6 rounded-xl bg-white p-4 sm:p-5">
      <p className="flex items-center gap-2 font-semibold text-ink-950">
        <BellRing className="h-4 w-4 text-oil-600" />
        Θέλετε να μάθετε πότε ανοίγουν;
      </p>
      <p className="mt-1 text-sm text-ink-600">Αφήστε το e-mail σας και θα σας γράψουμε μία φορά, την ημέρα που θα ανοίξουν οι online παραγγελίες.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="sr-only">E-mail</span>
          <input type="email" name="email" required autoComplete="email" placeholder="το e-mail σας" className="field h-12 w-full text-base" />
        </label>
        {/* honeypot */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
        <button type="submit" disabled={pending} className={buttonClass({ variant: 'dark', size: 'lg', className: 'shrink-0' })}>
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
          Ειδοποιήστε με
        </button>
      </div>
      <label className="mt-3 flex items-start gap-2.5 text-xs text-ink-600">
        <input type="checkbox" name="consent" required className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-ink-900" />
        <span>
          Συμφωνώ να χρησιμοποιηθεί το e-mail μου μόνο για αυτή την ειδοποίηση. Μπορώ να ζητήσω τη διαγραφή του όποτε θέλω.{' '}
          <Link href="/privacy" className="underline underline-offset-2">Πολιτική απορρήτου</Link>
        </span>
      </label>
      {state && !state.ok && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{state.message}</p>}
    </form>
  );
}
