import type { Metadata } from 'next';
import Link from 'next/link';
import { activateAccount } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { ACTIVATION_LINK_INVALID, activationTokenUsable } from '@/lib/auth/activation';
import { requireOrderingOrHistory } from '@/lib/catalogue-mode';
import { clientIp, rateLimit } from '@/lib/rate-limit';

// the token is in the address: no search engine, and no Referer to anything this page links to (the header is in next.config.ts)
export const metadata: Metadata = { title: 'Ενεργοποίηση λογαριασμού', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * Where the activation mail leads. Opening it only looks at the token: mail scanners open links before the customer does, so
 * the account is activated (and the customer signed in) by the button, a server action, never by the visit itself.
 */
export default async function ActivatePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await requireOrderingOrHistory();
  const token = String((await searchParams).token ?? '').slice(0, 200);
  // the page only reads, so the limit is loose; it keeps the page from being a free database probe
  const allowed = (await rateLimit(`activate-view:${await clientIp()}`, 60, 10 * 60 * 1000)).ok;
  const usable = allowed && (await activationTokenUsable(token));
  return (
    <div className="container-page max-w-md py-10 sm:py-14">
      <h1 className="display text-4xl">Ενεργοποίηση λογαριασμού</h1>
      {usable ? (
        <>
          <p className="mt-2 text-ink-600">Πατήστε το κουμπί για να ενεργοποιηθεί ο λογαριασμός σας. Θα συνδεθείτε αμέσως.</p>
          <div className="mt-7 rounded-3xl border border-line bg-white p-6 shadow-tile">
            <ActionForm action={activateAccount} fields={[]} hidden={{ token }} submitLabel="Ενεργοποίηση λογαριασμού" variant="dark" />
          </div>
        </>
      ) : (
        <>
          <p role="alert" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
            {allowed ? ACTIVATION_LINK_INVALID : 'Πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.'}
          </p>
          <p className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-center">
            <Link href="/resend-activation" className="font-semibold text-ink-950 underline underline-offset-4">Στείλτε μου νέο σύνδεσμο</Link>
            <Link href="/login" className="font-semibold text-ink-950 underline underline-offset-4">Σύνδεση</Link>
          </p>
        </>
      )}
    </div>
  );
}
