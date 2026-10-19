import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { Search } from 'lucide-react';
import { Breadcrumbs } from '@/components/store/product-listing';
import { buttonClass } from '@/components/ui/button';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings.server';
import { accountsAvailable, requireOrderingOrHistory } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Η παραγγελία μου', robots: { index: false, follow: true } };

async function lookup(formData: FormData) {
  'use server';
  // The page redirects in catalogue mode, but a direct action call must be refused here too.
  if (!(await accountsAvailable())) redirect('/');
  const number = String(formData.get('number') ?? '').trim().toUpperCase().replace(/\s/g, '');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  // Same answer for "no such order" and "wrong e-mail", and a rate limit: no way to probe order numbers.
  const limited = await rateLimit(`lookup:${await clientIp()}`, 8, 10 * 60 * 1000);
  if (!limited.ok) redirect('/order-status?error=rate');
  const [order] = number && email ? await db.select({ number: orders.number, token: orders.accessToken }).from(orders).where(and(eq(orders.number, number), eq(orders.email, email))) : [];
  if (!order) redirect('/order-status?error=notfound');
  redirect(`/order/${order.number}?t=${order.token}`);
}

/** What the buyer is told when the card payment sends them back here (see api/payments/viva/return/route.ts). */
function paymentNotice(state: string | undefined, phone: string): { title: string; text: string; tone: 'amber' | 'red' } | null {
  const call = phone ? ` Αν δεν έχετε τον αριθμό της παραγγελίας ή χρειάζεστε βοήθεια, καλέστε μας στο ${phone}.` : '';
  if (state === 'failed') {
    return { title: 'Η πληρωμή δεν ολοκληρώθηκε', text: `Η παραγγελία σας δεν έχει εξοφληθεί. Για να δοκιμάσετε ξανά με κάρτα, βρείτε την παραγγελία σας παρακάτω και πατήστε «Πληρωμή με κάρτα».${call}`, tone: 'red' };
  }
  if (state === 'pending') {
    return { title: 'Η πληρωμή σας βρίσκεται σε επεξεργασία', text: `Μην πληρώσετε ξανά: η παραγγελία θα ενημερωθεί μόλις ολοκληρωθεί η πληρωμή (για παράδειγμα, μέσω IRIS μπορεί να χρειαστούν λίγα λεπτά). Μπορείτε να τη βρείτε παρακάτω.${call}`, tone: 'amber' };
  }
  if (state === 'review') {
    return { title: 'Λάβαμε την πληρωμή σας', text: `Η παραγγελία σας χρειάζεται έλεγχο από εμάς. Μην πληρώσετε ξανά: θα επικοινωνήσουμε μαζί σας το συντομότερο.${call}`, tone: 'amber' };
  }
  return null;
}

export default async function OrderStatusPage({ searchParams }: { searchParams: Promise<{ error?: string; payment?: string }> }) {
  await requireOrderingOrHistory();
  const { error, payment } = await searchParams;
  const notice = paymentNotice(payment, (await getSettings()).shop.phone);
  return (
    <div className="container-page max-w-xl py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Η παραγγελία μου', href: '/order-status' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Η παραγγελία μου</h1>
      {notice && (
        <div role="status" className={notice.tone === 'red' ? 'mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900' : 'mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900'}>
          <p className="font-bold">{notice.title}</p>
          <p className="mt-1 text-sm">{notice.text}</p>
        </div>
      )}
      <p className="mt-3 text-ink-600">Συμπληρώστε τον αριθμό της παραγγελίας (τον βρίσκετε στο e-mail επιβεβαίωσης ή στη σελίδα της παραγγελίας) και το e-mail με το οποίο την κάνατε.</p>

      <form action={lookup} className="mt-7 space-y-4 rounded-3xl border border-line bg-white p-6 shadow-tile">
        {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">{error === 'rate' ? 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγα λεπτά.' : 'Δεν βρέθηκε παραγγελία με αυτά τα στοιχεία.'}</p>}
        <div>
          <label htmlFor="number" className="label">Αριθμός παραγγελίας</label>
          <input id="number" name="number" required placeholder="OC-10001" autoCapitalize="characters" className="field tabular uppercase placeholder:normal-case" />
        </div>
        <div>
          <label htmlFor="email" className="label">E-mail</label>
          <input id="email" name="email" type="email" inputMode="email" autoComplete="email" required className="field" />
        </div>
        <button type="submit" className={buttonClass({ variant: 'dark', size: 'lg', full: true })}><Search className="h-4 w-4" />Αναζήτηση παραγγελίας</button>
      </form>
    </div>
  );
}
