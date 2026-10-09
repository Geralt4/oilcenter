'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect } from 'react';
import { ArrowRight, LoaderCircle, ShoppingCart, Trash2 } from 'lucide-react';
import { AvailabilityTag } from '@/components/store/availability';
import { FreeShippingMeter, syncCartWithServer } from '@/components/store/cart-drawer';
import { QuantityStepper } from '@/components/store/quantity-stepper';
import { OrdersClosedNotice } from '@/components/store/orders-closed';
import { useStoreConfig } from '@/components/store/store-context';
import { buttonClass } from '@/components/ui/button';
import { cartSubtotalCents, cartWeightGrams, useCart, useHydrated } from '@/lib/cart-store';
import { computeTotals } from '@/lib/pricing';
import { formatPrice, formatWeight } from '@/lib/utils';

export function CartView() {
  const hydrated = useHydrated();
  const config = useStoreConfig();
  const { lines, setQuantity, remove, clear } = useCart();

  useEffect(() => {
    if (hydrated) void syncCartWithServer(useCart.getState().lines);
  }, [hydrated]);

  if (!hydrated) return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-ink-300" /></div>;

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-16 text-center">
        <ShoppingCart className="mx-auto h-10 w-10 text-ink-300" />
        <h2 className="display mt-4 text-2xl">Το καλάθι σας είναι άδειο</h2>
        <p className="mt-2 text-ink-600">Ξεκινήστε από τα λιπαντικά κινητήρα ή ψάξτε με το ιξώδες που χρειάζεστε.</p>
        <Link href="/products" className={buttonClass({ variant: 'dark', className: 'mt-6' })}>Δείτε τα προϊόντα</Link>
      </div>
    );
  }

  const subtotal = cartSubtotalCents(lines);
  const weight = cartWeightGrams(lines);
  const courier = computeTotals({ subtotalCents: subtotal, weightGrams: weight, shippingMethod: 'courier', paymentMethod: null, shipping: config.shipping, vatRate: config.vatRate });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start lg:gap-8">
      <div className="overflow-hidden rounded-3xl border border-line bg-white shadow-tile">
        <ul className="divide-y divide-line">
          {lines.map((line) => (
            <li key={line.variantId} className="flex gap-4 p-4 sm:p-5">
              <Link href={`/product/${line.snapshot.slug}`} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-line bg-white sm:h-28 sm:w-28">
                {line.snapshot.imageUrl && <Image src={line.snapshot.imageUrl} alt="" fill sizes="112px" className="object-contain p-2" />}
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                {line.snapshot.brandName && <p className="eyebrow text-[0.6875rem] text-ink-500">{line.snapshot.brandName}</p>}
                <Link href={`/product/${line.snapshot.slug}`} className="font-semibold text-ink-950 hover:text-oil-700">{line.snapshot.name}</Link>
                <p className="mt-0.5 text-sm text-ink-500">Συσκευασία {line.snapshot.variantLabel} · <span className="tabular">{formatPrice(line.snapshot.unitPriceCents)}</span> / τεμ.</p>
                <AvailabilityTag availability={line.snapshot.availability} className="mt-1" />
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-3">
                  <div className="flex items-center gap-2">
                    <QuantityStepper size="sm" value={line.quantity} max={line.snapshot.maxQuantity} onChange={(q) => setQuantity(line.variantId, q)} />
                    <button type="button" onClick={() => remove(line.variantId)} aria-label={`Αφαίρεση ${line.snapshot.name}`} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl text-ink-500 hover:bg-red-50 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="tabular text-lg font-bold text-ink-950">{formatPrice(line.quantity * line.snapshot.unitPriceCents)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-line bg-ink-50 px-5 py-3 text-sm">
          <Link href="/products" className="font-semibold text-petrol-500 hover:text-petrol-700">← Συνέχεια αγορών</Link>
          <button type="button" onClick={clear} className="cursor-pointer text-ink-500 hover:text-red-600">Άδειασμα καλαθιού</button>
        </div>
      </div>

      <aside className="rounded-3xl border border-line bg-white p-5 shadow-tile sm:p-6 lg:sticky lg:top-44" aria-label="Σύνοψη">
        <h2 className="display text-2xl">Σύνοψη</h2>
        <div className="mt-4"><FreeShippingMeter subtotalCents={subtotal} weightGrams={weight} /></div>
        <dl className="mt-4 space-y-2 text-[0.9375rem]">
          <div className="flex justify-between"><dt className="text-ink-600">Υποσύνολο</dt><dd className="tabular font-medium">{formatPrice(subtotal)}</dd></div>
          {config.shipping.courierEnabled && (
            <div className="flex justify-between"><dt className="text-ink-600">Courier ({formatWeight(weight)})</dt><dd className="tabular font-medium">{courier.freeShipping ? 'Δωρεάν' : formatPrice(courier.shippingCents)}</dd></div>
          )}
          {config.shipping.pickupEnabled && <div className="flex justify-between"><dt className="text-ink-600">Παραλαβή από το κατάστημα</dt><dd className="font-medium">Δωρεάν</dd></div>}
        </dl>
        <p className="mt-4 text-xs text-ink-500">Οι τιμές περιλαμβάνουν ΦΠΑ {config.vatRate}%. Τρόπο αποστολής, πληρωμής και κουπόνι επιλέγετε στο επόμενο βήμα.</p>
        {config.canOrder ? (
          <Link href="/checkout" className={buttonClass({ size: 'lg', full: true, className: 'mt-5' })}>
            Ολοκλήρωση παραγγελίας
            <ArrowRight className="h-5 w-5" />
          </Link>
        ) : (
          <OrdersClosedNotice phone={config.phone} compact className="mt-5" />
        )}
      </aside>
    </div>
  );
}
