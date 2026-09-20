import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loginAdmin } from '@/app/admin/actions';
import { Logo } from '@/components/logo';
import { ActionForm } from '@/components/ui/action-form';
import { getAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Διαχείριση — σύνδεση', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
  if (await getAdmin()) redirect('/admin');
  return (
    <main className="steel flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-lift">
        <Logo />
        <h1 className="mt-6 text-xl font-bold text-ink-950">Διαχείριση καταστήματος</h1>
        <p className="mt-1 mb-6 text-sm text-ink-600">Συνδεθείτε για να διαχειριστείτε προϊόντα, τιμές και παραγγελίες.</p>
        <ActionForm
          action={loginAdmin}
          submitLabel="Σύνδεση"
          variant="dark"
          fields={[
            { name: 'email', label: 'E-mail', type: 'email', inputMode: 'email', autoComplete: 'username', required: true },
            { name: 'password', label: 'Κωδικός', type: 'password', autoComplete: 'current-password', required: true },
          ]}
        />
      </div>
    </main>
  );
}
