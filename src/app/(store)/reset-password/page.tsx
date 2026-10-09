import type { Metadata } from 'next';
import Link from 'next/link';
import { resetPassword } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { requireOrderingOrHistory } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Νέος κωδικός', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await requireOrderingOrHistory();
  const { token } = await searchParams;
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Νέος κωδικός</h1>
      <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
        {token ? (
          <ActionForm action={resetPassword} submitLabel="Αποθήκευση κωδικού" variant="dark" hidden={{ token }} fields={[{ name: 'password', label: 'Νέος κωδικός', type: 'password', autoComplete: 'new-password', required: true, hint: 'Τουλάχιστον 8 χαρακτήρες.' }]} />
        ) : (
          <p className="text-ink-700">Ο σύνδεσμος δεν είναι έγκυρος. <Link href="/forgot-password" className="font-semibold text-petrol-500 underline underline-offset-2">Ζητήστε νέο σύνδεσμο</Link>.</p>
        )}
      </div>
    </div>
  );
}
