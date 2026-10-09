import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loginCustomer } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { getCustomer } from '@/lib/auth/session';
import { requireOrderingOrHistory } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Σύνδεση', robots: { index: false, follow: true } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireOrderingOrHistory();
  const [{ next }, customer] = await Promise.all([searchParams, getCustomer()]);
  if (customer) redirect('/account');
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Σύνδεση</h1>
      <p className="mt-2 text-ink-600">Δείτε τις παραγγελίες σας και ολοκληρώστε τις αγορές σας πιο γρήγορα.</p>
      <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
        <ActionForm
          action={loginCustomer}
          submitLabel="Σύνδεση"
          variant="dark"
          hidden={{ next: next ?? '/account' }}
          fields={[
            { name: 'email', label: 'E-mail', type: 'email', inputMode: 'email', autoComplete: 'email', required: true },
            { name: 'password', label: 'Κωδικός', type: 'password', autoComplete: 'current-password', required: true },
          ]}
        />
        <p className="mt-4 text-center text-sm"><Link href="/forgot-password" className="font-semibold text-petrol-500 hover:text-petrol-700">Ξεχάσατε τον κωδικό σας;</Link></p>
      </div>
      <p className="mt-6 text-center text-ink-600">Δεν έχετε λογαριασμό; <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-semibold text-ink-950 underline underline-offset-4">Εγγραφή</Link></p>
      <p className="mt-2 text-center text-sm text-ink-500">Μπορείτε να παραγγείλετε και χωρίς λογαριασμό.</p>
    </div>
  );
}
