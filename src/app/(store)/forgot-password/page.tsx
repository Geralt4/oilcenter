import type { Metadata } from 'next';
import Link from 'next/link';
import { requestPasswordReset } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { requireOrderingOrHistory } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Επαναφορά κωδικού', robots: { index: false, follow: false } };

export default async function ForgotPasswordPage() {
  await requireOrderingOrHistory();
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Επαναφορά κωδικού</h1>
      <p className="mt-2 text-ink-600">Γράψτε το e-mail του λογαριασμού σας και θα σας στείλουμε σύνδεσμο για να ορίσετε νέο κωδικό.</p>
      <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
        <ActionForm action={requestPasswordReset} submitLabel="Αποστολή συνδέσμου" variant="dark" fields={[{ name: 'email', label: 'E-mail', type: 'email', inputMode: 'email', autoComplete: 'email', required: true }]} />
      </div>
      <p className="mt-6 text-center"><Link href="/login" className="font-semibold text-ink-950 underline underline-offset-4">Πίσω στη σύνδεση</Link></p>
    </div>
  );
}
