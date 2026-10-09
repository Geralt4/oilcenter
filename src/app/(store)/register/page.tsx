import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { registerCustomer } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { getCustomer } from '@/lib/auth/session';
import { requireOrdering } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Εγγραφή', robots: { index: false, follow: true } };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireOrdering();
  const [{ next }, customer] = await Promise.all([searchParams, getCustomer()]);
  if (customer) redirect('/account');
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Δημιουργία λογαριασμού</h1>
      <p className="mt-2 text-ink-600">Ιστορικό παραγγελιών και αποθηκευμένη διεύθυνση για ταχύτερες αγορές.</p>
      <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
        <ActionForm
          action={registerCustomer}
          submitLabel="Εγγραφή"
          variant="dark"
          hidden={{ next: next ?? '/account' }}
          fields={[
            { name: 'firstName', label: 'Όνομα', autoComplete: 'given-name', required: true, wide: false },
            { name: 'lastName', label: 'Επώνυμο', autoComplete: 'family-name', required: true, wide: false },
            { name: 'email', label: 'E-mail', type: 'email', inputMode: 'email', autoComplete: 'email', required: true },
            { name: 'password', label: 'Κωδικός', type: 'password', autoComplete: 'new-password', required: true, hint: 'Τουλάχιστον 8 χαρακτήρες.' },
          ]}
        >
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-700">
            <input type="checkbox" name="acceptTerms" className="mt-0.5 h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
            <span>Αποδέχομαι τους <Link href="/terms" target="_blank" className="font-semibold text-petrol-500 underline underline-offset-2">όρους χρήσης</Link> και την <Link href="/privacy" target="_blank" className="font-semibold text-petrol-500 underline underline-offset-2">πολιτική απορρήτου</Link>.</span>
          </label>
        </ActionForm>
      </div>
      <p className="mt-6 text-center text-ink-600">Έχετε ήδη λογαριασμό; <Link href="/login" className="font-semibold text-ink-950 underline underline-offset-4">Σύνδεση</Link></p>
    </div>
  );
}
