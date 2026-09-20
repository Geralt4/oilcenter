import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { Search } from 'lucide-react';
import { Breadcrumbs } from '@/components/store/product-listing';
import { buttonClass } from '@/components/ui/button';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const metadata: Metadata = { title: 'Η παραγγελία μου', robots: { index: false, follow: true } };

async function lookup(formData: FormData) {
  'use server';
  const number = String(formData.get('number') ?? '').trim().toUpperCase().replace(/\s/g, '');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  // Same answer for "no such order" and "wrong e-mail", and a rate limit: no way to probe order numbers.
  const limited = rateLimit(`lookup:${await clientIp()}`, 8, 10 * 60 * 1000);
  if (!limited.ok) redirect('/order-status?error=rate');
  const [order] = number && email ? await db.select({ number: orders.number, token: orders.accessToken }).from(orders).where(and(eq(orders.number, number), eq(orders.email, email))) : [];
  if (!order) redirect('/order-status?error=notfound');
  redirect(`/order/${order.number}?t=${order.token}`);
}

export default async function OrderStatusPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="container-page max-w-xl py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Η παραγγελία μου', href: '/order-status' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Η παραγγελία μου</h1>
      <p className="mt-3 text-ink-600">Συμπληρώστε τον αριθμό της παραγγελίας (θα τον βρείτε στο e-mail επιβεβαίωσης) και το e-mail με το οποίο την κάνατε.</p>

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
