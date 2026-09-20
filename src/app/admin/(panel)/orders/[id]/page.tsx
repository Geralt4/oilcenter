import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { ExternalLink, Mail, Phone } from 'lucide-react';
import { updateOrder } from '@/app/admin/actions';
import { AdminForm } from '@/components/admin/admin-form';
import { PrintButton } from '@/components/admin/print-button';
import { Card, Check, Field, PageHeader, PaymentBadge, StatusBadge } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { orderEvents, orders, type OrderStatus } from '@/lib/db/schema';
import { ORDER_STATUS_LABELS } from '@/lib/orders';
import { PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/pricing';
import { formatDateTime, formatPrice, formatWeight, vatPortion } from '@/lib/utils';

export const metadata = { title: 'Παραγγελία' };

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), with: { items: true, events: { orderBy: [asc(orderEvents.id)] } } });
  if (!order) notFound();

  const pickup = order.shippingMethod === 'pickup';
  // offer only the statuses that make sense for how this order is delivered
  const statuses = (Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).filter((s) => (pickup ? s !== 'shipped' : s !== 'ready_for_pickup'));

  return (
    <>
      <PageHeader title={`Παραγγελία ${order.number}`} description={`${formatDateTime(order.createdAt)}${order.isTest ? ' · ΔΟΚΙΜΑΣΤΙΚΗ (καταχωρήθηκε σε δοκιμαστική λειτουργία)' : ''}`}>
        <StatusBadge status={order.status} />
        <PaymentBadge status={order.paymentStatus} />
        <PrintButton />
        <Link href={`/order/${order.number}?t=${order.accessToken}`} target="_blank" className="flex h-10 items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50 print:hidden"><ExternalLink className="h-4 w-4" />Όπως τη βλέπει ο πελάτης</Link>
      </PageHeader>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr] xl:items-start">
        <div className="space-y-6">
          <Card title="Προϊόντα">
            <ul className="divide-y divide-line">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-center gap-4 py-3">
                  <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-line bg-white print:hidden">{item.imageUrl && <Image src={item.imageUrl} alt="" fill sizes="56px" className="object-contain p-1" />}</span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-semibold text-ink-950">{item.name}</span> <span className="tabular rounded bg-ink-900 px-1.5 py-0.5 text-xs font-bold text-oil-300">{item.variantLabel}</span>
                    <span className="tabular block text-xs text-ink-500">{item.sku}</span>
                  </span>
                  <span className="tabular shrink-0 text-right text-sm"><strong className="text-base">{item.quantity}</strong> × {formatPrice(item.unitPriceCents)}<span className="block font-semibold text-ink-950">{formatPrice(item.lineTotalCents)}</span></span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1.5 border-t border-line pt-4 text-sm">
              <div className="flex justify-between"><dt className="text-ink-600">Υποσύνολο</dt><dd className="tabular">{formatPrice(order.subtotalCents)}</dd></div>
              {order.discountCents > 0 && <div className="flex justify-between text-emerald-700"><dt>Έκπτωση {order.couponCode && `(${order.couponCode})`}</dt><dd className="tabular">−{formatPrice(order.discountCents)}</dd></div>}
              <div className="flex justify-between"><dt className="text-ink-600">Μεταφορικά · {formatWeight(order.totalWeightGrams)}</dt><dd className="tabular">{pickup ? '—' : formatPrice(order.shippingCents)}</dd></div>
              {order.codFeeCents > 0 && <div className="flex justify-between"><dt className="text-ink-600">Αντικαταβολή</dt><dd className="tabular">{formatPrice(order.codFeeCents)}</dd></div>}
              <div className="flex items-baseline justify-between border-t border-line pt-2"><dt className="font-bold">Σύνολο</dt><dd className="tabular text-xl font-bold">{formatPrice(order.totalCents)}</dd></div>
              <div className="flex justify-between text-xs text-ink-500"><dt>εκ των οποίων ΦΠΑ {order.vatRate}%</dt><dd className="tabular">{formatPrice(vatPortion(order.totalCents, order.vatRate))}</dd></div>
            </dl>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card title="Πελάτης">
              <p className="text-sm leading-relaxed text-ink-800">
                <strong>{order.firstName} {order.lastName}</strong><br />
                <a href={`tel:${order.phone}`} className="tabular inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Phone className="h-3.5 w-3.5" />{order.phone}</a><br />
                <a href={`mailto:${order.email}`} className="inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Mail className="h-3.5 w-3.5" />{order.email}</a>
              </p>
              {order.notes && <p className="mt-3 rounded-xl bg-oil-50 p-3 text-sm text-ink-800"><strong>Σχόλια πελάτη:</strong> {order.notes}</p>}
            </Card>
            <Card title={SHIPPING_LABELS[order.shippingMethod]}>
              <p className="text-sm leading-relaxed text-ink-800">
                {pickup ? 'Ο πελάτης θα παραλάβει από το κατάστημα.' : <>{order.street}<br />{order.postalCode} {order.city}{order.region ? `, ${order.region}` : ''}</>}
              </p>
              <p className="mt-3 text-sm text-ink-800"><strong>Πληρωμή:</strong> {PAYMENT_LABELS[order.paymentMethod]}{order.paymentProvider ? ` (${order.paymentProvider})` : ''}</p>
              <p className="mt-1 text-sm text-ink-800"><strong>Παραστατικό:</strong> {order.docType === 'invoice' ? 'Τιμολόγιο' : 'Απόδειξη'}</p>
              {order.docType === 'invoice' && <p className="mt-1 text-sm leading-relaxed text-ink-700">{order.companyName}<br />ΑΦΜ <span className="tabular">{order.vatNumber}</span> · ΔΟΥ {order.taxOffice}<br />{order.companyActivity}{order.companyAddress ? <><br />{order.companyAddress}</> : null}</p>}
            </Card>
          </div>
        </div>

        <div className="space-y-6 print:hidden">
          <Card title="Διαχείριση">
            <AdminForm action={updateOrder} submitLabel="Ενημέρωση παραγγελίας">
              <input type="hidden" name="id" value={order.id} />
              <div className="space-y-4">
                <Field label="Κατάσταση">
                  <select name="status" defaultValue={order.status} className="field cursor-pointer">
                    {statuses.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>)}
                  </select>
                </Field>
                <Check name="notify" label="Ενημέρωση του πελάτη με e-mail" hint="Στέλνεται μόνο όταν αλλάζει η κατάσταση." defaultChecked />
                <Check name="paid" label="Η παραγγελία έχει εξοφληθεί" defaultChecked={order.paymentStatus === 'paid'} hint={order.paymentMethod === 'card' ? 'Οι πληρωμές με κάρτα σημειώνονται αυτόματα.' : 'Σημειώστε το όταν εισπράξετε (αντικαταβολή, κατάθεση, κατάστημα).'} />
                {!pickup && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Courier"><input name="trackingCarrier" defaultValue={order.trackingCarrier ?? ''} placeholder="π.χ. ACS" className="field" /></Field>
                    <Field label="Αρ. αποστολής"><input name="trackingNumber" defaultValue={order.trackingNumber ?? ''} className="field tabular" /></Field>
                  </div>
                )}
                <Field label="Εσωτερικές σημειώσεις" hint="Δεν τις βλέπει ο πελάτης."><textarea name="adminNotes" rows={3} defaultValue={order.adminNotes ?? ''} className="field resize-y" /></Field>
              </div>
            </AdminForm>
            <p className="mt-4 text-xs leading-relaxed text-ink-500">Η ακύρωση επιστρέφει αυτόματα τα τεμάχια στο απόθεμα (για όσες συσκευασίες παρακολουθείται) και δεν αναιρείται.</p>
          </Card>

          <Card title="Ιστορικό">
            <ol className="space-y-3 border-l-2 border-line pl-4">
              {order.events.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute top-1.5 -left-[1.4rem] h-2.5 w-2.5 rounded-full bg-oil-500 ring-4 ring-white" />
                  <p className="text-ink-800">{e.message}</p>
                  <p className="text-xs text-ink-500">{formatDateTime(e.createdAt)} · {e.actor === 'system' ? 'σύστημα' : e.actor === 'customer' ? 'πελάτης' : e.actor}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
