import type { Metadata } from 'next';
import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { LogOut, Package } from 'lucide-react';
import { logoutCustomer, updateProfile } from '@/app/(store)/account/actions';
import { ActionForm } from '@/components/ui/action-form';
import { buttonClass } from '@/components/ui/button';
import { requireCustomer } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { ORDER_STATUS_LABELS } from '@/lib/orders';
import { cn, formatDate, formatPrice } from '@/lib/utils';

export const metadata: Metadata = { title: 'Ο λογαριασμός μου', robots: { index: false, follow: false } };

export default async function AccountPage() {
  const customer = await requireCustomer('/account');
  const myOrders = await db.select().from(orders).where(eq(orders.customerId, customer.id)).orderBy(desc(orders.createdAt)).limit(50);

  return (
    <div className="container-page py-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-ink-500">Ο λογαριασμός μου</p>
          <h1 className="display mt-1 text-4xl sm:text-5xl">Γεια σας, {customer.firstName || 'φίλε μας'}</h1>
          <p className="mt-1 text-ink-600">{customer.email}</p>
        </div>
        <form action={logoutCustomer}>
          <button type="submit" className={buttonClass({ variant: 'outline' })}><LogOut className="h-4 w-4" />Αποσύνδεση</button>
        </form>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.3fr_1fr] lg:items-start">
        <section aria-labelledby="orders">
          <h2 id="orders" className="display text-2xl">Οι παραγγελίες μου</h2>
          {myOrders.length === 0 ? (
            <div className="mt-4 rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center">
              <Package className="mx-auto h-9 w-9 text-ink-300" />
              <p className="mt-3 text-ink-600">Δεν έχετε κάνει ακόμη κάποια παραγγελία.</p>
              <Link href="/products" className={buttonClass({ variant: 'dark', className: 'mt-5' })}>Δείτε τα προϊόντα</Link>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-line overflow-hidden rounded-3xl border border-line bg-white shadow-tile">
              {myOrders.map((o) => (
                <li key={o.id}>
                  <Link href={`/order/${o.number}`} className="flex items-center justify-between gap-4 p-4 hover:bg-ink-50 sm:p-5">
                    <span>
                      <span className="tabular block font-display text-xl font-bold text-ink-950">{o.number}</span>
                      <span className="text-sm text-ink-500">{formatDate(o.createdAt)}</span>
                    </span>
                    <span className="text-right">
                      <span className="tabular block font-semibold text-ink-950">{formatPrice(o.totalCents)}</span>
                      <span className={cn('mt-1 inline-block rounded-full px-2.5 py-1 text-xs font-semibold', o.status === 'cancelled' ? 'bg-red-100 text-red-800' : o.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-700')}>{ORDER_STATUS_LABELS[o.status]}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="profile" className="rounded-3xl border border-line bg-white p-6 shadow-tile">
          <h2 id="profile" className="display text-2xl">Στοιχεία & διεύθυνση</h2>
          <p className="mt-1 mb-5 text-sm text-ink-500">Συμπληρώνονται αυτόματα στο ταμείο.</p>
          <ActionForm
            action={updateProfile}
            submitLabel="Αποθήκευση"
            variant="dark"
            stayOnSuccess
            fields={[
              { name: 'firstName', label: 'Όνομα', autoComplete: 'given-name', defaultValue: customer.firstName, required: true, wide: false },
              { name: 'lastName', label: 'Επώνυμο', autoComplete: 'family-name', defaultValue: customer.lastName, required: true, wide: false },
              { name: 'phone', label: 'Τηλέφωνο', type: 'tel', inputMode: 'tel', autoComplete: 'tel', defaultValue: customer.phone ?? '' },
              { name: 'street', label: 'Οδός & αριθμός', autoComplete: 'street-address', defaultValue: customer.street ?? '' },
              { name: 'city', label: 'Πόλη', autoComplete: 'address-level2', defaultValue: customer.city ?? '', wide: false },
              { name: 'postalCode', label: 'Τ.Κ.', inputMode: 'numeric', autoComplete: 'postal-code', defaultValue: customer.postalCode ?? '', wide: false },
              { name: 'region', label: 'Νομός', autoComplete: 'address-level1', defaultValue: customer.region ?? '' },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
