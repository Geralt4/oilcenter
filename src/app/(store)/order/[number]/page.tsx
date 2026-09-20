import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, CircleAlert, CircleCheck, Navigation, Phone } from 'lucide-react';
import { RetryPayment } from '@/components/store/retry-payment';
import { buttonClass } from '@/components/ui/button';
import { getCustomer } from '@/lib/auth/session';
import type { OrderStatus } from '@/lib/db/schema';
import { getOrderByNumber, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@/lib/orders';
import { cardProvider } from '@/lib/payments';
import { PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/pricing';
import { fullAddress, mapsDirectionsUrl } from '@/lib/settings';
import { getSettings } from '@/lib/settings.server';
import { cn, formatDateTime, formatPrice, telHref } from '@/lib/utils';

export const metadata: Metadata = { title: 'Η παραγγελία σας', robots: { index: false, follow: false } };

type Props = { params: Promise<{ number: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OrderPage({ params, searchParams }: Props) {
  const [{ number }, sp] = await Promise.all([params, searchParams]);
  const token = typeof sp.t === 'string' ? sp.t : '';
  const [order, settings, customer] = await Promise.all([getOrderByNumber(number.toUpperCase()), getSettings(), getCustomer()]);

  // Knowing an order number is not enough: either hold its secret link or be its logged-in owner.
  const allowed = order && ((token.length > 10 && token === order.accessToken) || (customer && order.customerId === customer.id));
  if (!order || !allowed) notFound();

  const { shop, payments } = settings;
  const pickup = order.shippingMethod === 'pickup';
  const steps: Array<{ key: OrderStatus; label: string }> = [
    { key: 'pending', label: 'Καταχωρήθηκε' },
    { key: 'confirmed', label: 'Επιβεβαιώθηκε' },
    pickup ? { key: 'ready_for_pickup', label: 'Έτοιμη για παραλαβή' } : { key: 'shipped', label: 'Απεστάλη' },
    { key: 'completed', label: 'Ολοκληρώθηκε' },
  ];
  const rank: Record<OrderStatus, number> = { pending: 0, confirmed: 1, processing: 1, shipped: 2, ready_for_pickup: 2, completed: 3, cancelled: -1 };
  const current = rank[order.status];

  const justPlaced = sp.placed === '1' || sp.payment === 'success';
  const paymentProblem = sp.payment === 'failed' || sp.payment === 'cancelled';
  const awaitingCard = order.paymentMethod === 'card' && order.paymentStatus !== 'paid' && order.status !== 'cancelled';

  return (
    <div className="container-page max-w-4xl py-8 sm:py-12">
      {justPlaced && !awaitingCard && (
        <div className="mb-8 rounded-3xl bg-emerald-50 p-6 text-center sm:p-8">
          <CircleCheck className="mx-auto h-12 w-12 text-emerald-600" />
          <h1 className="display mt-3 text-3xl text-emerald-950 sm:text-4xl">Ευχαριστούμε, {order.firstName}!</h1>
          <p className="mx-auto mt-2 max-w-xl text-emerald-900">Λάβαμε την παραγγελία σας και στείλαμε επιβεβαίωση στο <strong>{order.email}</strong>.</p>
        </div>
      )}

      {awaitingCard && (
        <div role="alert" className="mb-8 rounded-3xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="flex items-center gap-2 font-bold text-amber-950"><CircleAlert className="h-5 w-5" />{paymentProblem ? 'Η πληρωμή δεν ολοκληρώθηκε' : 'Εκκρεμεί η πληρωμή με κάρτα'}</h2>
          <p className="mt-1.5 text-sm text-amber-900">Η παραγγελία σας έχει καταχωρηθεί αλλά δεν έχει εξοφληθεί. Δοκιμάστε ξανά ή καλέστε μας για να την ολοκληρώσουμε με άλλο τρόπο.</p>
          <div className="mt-4 flex flex-wrap items-start gap-3">
            {cardProvider() && <RetryPayment number={order.number} token={order.accessToken} />}
            <a href={telHref(shop.phone)} className={buttonClass({ variant: 'outline', className: 'tabular' })}><Phone className="h-4 w-4" />{shop.phone}</a>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-ink-500">Παραγγελία</p>
          <h2 className="tabular font-display text-4xl font-extrabold tracking-tight">{order.number}</h2>
          <p className="mt-1 text-sm text-ink-500">{formatDateTime(order.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {order.isTest && <span className="rounded-full bg-petrol-100 px-3 py-1.5 text-xs font-semibold text-petrol-700">Δοκιμαστική</span>}
          <span className={cn('rounded-full px-3 py-1.5 text-xs font-semibold', order.status === 'cancelled' ? 'bg-red-100 text-red-800' : 'bg-ink-900 text-white')}>{ORDER_STATUS_LABELS[order.status]}</span>
          <span className={cn('rounded-full px-3 py-1.5 text-xs font-semibold', order.paymentStatus === 'paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-700')}>Πληρωμή: {PAYMENT_STATUS_LABELS[order.paymentStatus]}</span>
        </div>
      </div>

      {order.status !== 'cancelled' && (
        <ol className="mt-8 grid grid-cols-4 gap-2" aria-label="Πορεία παραγγελίας">
          {steps.map((step, i) => {
            const done = current >= i;
            return (
              <li key={step.key} className="text-center">
                <div className="flex items-center">
                  <span className={cn('h-1 flex-1 rounded-full', i === 0 ? 'opacity-0' : done ? 'bg-oil-500' : 'bg-ink-200')} />
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', done ? 'bg-oil-500 text-ink-950' : 'bg-ink-200 text-ink-500')}>{done ? <Check className="h-4 w-4" /> : i + 1}</span>
                  <span className={cn('h-1 flex-1 rounded-full', i === steps.length - 1 ? 'opacity-0' : current > i ? 'bg-oil-500' : 'bg-ink-200')} />
                </div>
                <p className={cn('mt-2 text-xs sm:text-sm', done ? 'font-semibold text-ink-950' : 'text-ink-500')}>{step.label}</p>
              </li>
            );
          })}
        </ol>
      )}

      {order.trackingNumber && (
        <p className="mt-6 rounded-2xl bg-ink-900 p-4 text-sm text-white">Αριθμός αποστολής{order.trackingCarrier ? ` (${order.trackingCarrier})` : ''}: <strong className="tabular text-oil-300">{order.trackingNumber}</strong></p>
      )}

      {order.paymentMethod === 'bank_transfer' && order.paymentStatus !== 'paid' && order.status !== 'cancelled' && (
        <section className="mt-6 rounded-3xl border border-oil-200 bg-oil-50 p-6">
          <h3 className="font-bold text-ink-950">Πληρωμή με τραπεζική κατάθεση</h3>
          <p className="mt-1 text-sm text-ink-700">Καταθέστε <strong className="tabular">{formatPrice(order.totalCents)}</strong> με αιτιολογία <strong className="tabular">{order.number}</strong>. Η παραγγελία αποστέλλεται μόλις επιβεβαιωθεί η κατάθεση.</p>
          {payments.bankAccounts.length > 0 ? (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {payments.bankAccounts.map((a) => (
                <li key={a.iban} className="rounded-2xl bg-white p-4 text-sm">
                  <p className="font-semibold text-ink-950">{a.bank}</p>
                  <p className="tabular mt-1 break-all text-ink-800">{a.iban}</p>
                  <p className="text-ink-500">{a.holder}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-700">Θα επικοινωνήσουμε μαζί σας με τα στοιχεία του λογαριασμού.</p>
          )}
        </section>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <section className="overflow-hidden rounded-3xl border border-line bg-white shadow-tile">
          <ul className="divide-y divide-line">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-center gap-4 p-4">
                <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-line bg-white">{item.imageUrl && <Image src={item.imageUrl} alt="" fill sizes="64px" className="object-contain p-1" />}</span>
                <span className="min-w-0 flex-1 text-sm">
                  {item.slug ? <Link href={`/product/${item.slug}`} className="font-semibold text-ink-950 hover:text-oil-700">{item.name}</Link> : <span className="font-semibold text-ink-950">{item.name}</span>}
                  <span className="block text-ink-500">{item.variantLabel} · {item.quantity} × <span className="tabular">{formatPrice(item.unitPriceCents)}</span></span>
                </span>
                <span className="tabular shrink-0 font-semibold text-ink-950">{formatPrice(item.lineTotalCents)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-2 border-t border-line bg-ink-50 p-5 text-[0.9375rem]">
            <div className="flex justify-between"><dt className="text-ink-600">Υποσύνολο</dt><dd className="tabular">{formatPrice(order.subtotalCents)}</dd></div>
            {order.discountCents > 0 && <div className="flex justify-between text-emerald-700"><dt>Έκπτωση{order.couponCode ? ` (${order.couponCode})` : ''}</dt><dd className="tabular">−{formatPrice(order.discountCents)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-600">Μεταφορικά</dt><dd className="tabular">{pickup ? 'Παραλαβή' : order.shippingCents ? formatPrice(order.shippingCents) : 'Δωρεάν'}</dd></div>
            {order.codFeeCents > 0 && <div className="flex justify-between"><dt className="text-ink-600">Αντικαταβολή</dt><dd className="tabular">{formatPrice(order.codFeeCents)}</dd></div>}
            <div className="flex items-baseline justify-between border-t border-line pt-3"><dt className="font-bold">Σύνολο με ΦΠΑ</dt><dd className="tabular text-2xl font-bold">{formatPrice(order.totalCents)}</dd></div>
          </dl>
        </section>

        <div className="space-y-4 text-sm">
          <section className="rounded-3xl border border-line bg-white p-5 shadow-tile">
            <h3 className="eyebrow text-ink-500">{SHIPPING_LABELS[order.shippingMethod]}</h3>
            <p className="mt-2 leading-relaxed text-ink-800">
              {order.firstName} {order.lastName}<br />
              {pickup ? <>{fullAddress(shop)}</> : <>{order.street}<br />{order.postalCode} {order.city}{order.region ? `, ${order.region}` : ''}</>}<br />
              <span className="tabular">{order.phone}</span>
            </p>
            {pickup && <a href={mapsDirectionsUrl(shop)} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: 'dark', size: 'sm', className: 'mt-3' })}><Navigation className="h-4 w-4" />Οδηγίες προς το κατάστημα</a>}
          </section>
          <section className="rounded-3xl border border-line bg-white p-5 shadow-tile">
            <h3 className="eyebrow text-ink-500">Πληρωμή & παραστατικό</h3>
            <p className="mt-2 leading-relaxed text-ink-800">{PAYMENT_LABELS[order.paymentMethod]}<br />{order.docType === 'invoice' ? <>Τιμολόγιο: {order.companyName} · ΑΦΜ <span className="tabular">{order.vatNumber}</span> · ΔΟΥ {order.taxOffice}</> : 'Απόδειξη λιανικής'}</p>
            {order.notes && <p className="mt-3 border-t border-line pt-3 text-ink-600"><strong className="text-ink-800">Σχόλια:</strong> {order.notes}</p>}
          </section>
          <a href={telHref(shop.phone)} className="flex items-center gap-3 rounded-3xl bg-ink-900 p-5 text-white hover:bg-ink-800">
            <Phone className="h-5 w-5 text-oil-400" />
            <span>Ερώτηση για την παραγγελία; <strong className="tabular text-oil-300">{shop.phone}</strong></span>
          </a>
        </div>
      </div>
    </div>
  );
}
