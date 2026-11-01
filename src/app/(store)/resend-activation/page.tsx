import type { Metadata } from 'next';
import Link from 'next/link';
import { resendActivation } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { ACTIVATION_LINK_INVALID } from '@/lib/auth/activation';
import { requireOrderingOrHistory } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Νέος σύνδεσμος ενεργοποίησης', robots: { index: false, follow: false } };

export default async function ResendActivationPage({ searchParams }: { searchParams: Promise<{ email?: string; link?: string }> }) {
  await requireOrderingOrHistory();
  const { email, link } = await searchParams;
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Νέος σύνδεσμος ενεργοποίησης</h1>
      {link === 'invalid' && (
        <p role="alert" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {ACTIVATION_LINK_INVALID}
        </p>
      )}
      <p className="mt-2 text-ink-600">Γράψτε το e-mail με το οποίο κάνατε εγγραφή και θα σας στείλουμε νέο σύνδεσμο ενεργοποίησης.</p>
      <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
        <ActionForm action={resendActivation} submitLabel="Αποστολή συνδέσμου" variant="dark" fields={[{ name: 'email', label: 'E-mail', type: 'email', inputMode: 'email', autoComplete: 'email', required: true, defaultValue: (email ?? '').slice(0, 160) }]} />
      </div>
      <p className="mt-6 text-center"><Link href="/login" className="font-semibold text-ink-950 underline underline-offset-4">Πίσω στη σύνδεση</Link></p>
    </div>
  );
}
