'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { ShoppingCart, Trash2, Truck, X } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { AvailabilityTag } from '@/components/store/availability';
import { OrdersClosedNotice } from '@/components/store/orders-closed';
import { QuantityStepper } from '@/components/store/quantity-stepper';
import { useStoreConfig } from '@/components/store/store-context';
import { cartCount, cartSubtotalCents, cartWeightGrams, useCart, useHydrated, type CartLine } from '@/lib/cart-store';
import { computeTotals } from '@/lib/pricing';
import { cn, formatPrice } from '@/lib/utils';

/** Re-prices the local cart against the server. Shared by the drawer, /cart and /checkout. */
export async function syncCartWithServer(lines: CartLine[]) {
  if (!lines.length) return;
  try {
    const res = await fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { lines: Parameters<ReturnType<typeof useCart.getState>['syncSnapshots']>[0] };
    useCart.getState().syncSnapshots(data.lines);
  } catch {
    /* offline: keep showing the snapshot; checkout re-validates anyway */
  }
}

export function FreeShippingMeter({ subtotalCents, weightGrams }: { subtotalCents: number; weightGrams: number }) {
  const { shipping, vatRate } = useStoreConfig();
  if (!shipping.courierEnabled || shipping.freeOverCents <= 0) return null;
  const totals = computeTotals({ subtotalCents, weightGrams, shippingMethod: 'courier', paymentMethod: null, shipping, vatRate });
  if (!totals.freeShipping && totals.freeShippingRemainingCents === null) return null; // too heavy for the offer

  const pct = totals.freeShipping ? 100 : Math.min(100, Math.round((subtotalCents / shipping.freeOverCents) * 100));
  return (
    <div className="rounded-xl bg-oil-50 p-3">
      <p className="flex items-center gap-2 text-sm text-ink-800">
        <Truck className="h-4 w-4 shrink-0 text-oil-700" />
        {totals.freeShipping ? (
          <span className="font-semibold">Κερδίσατε δωρεάν μεταφορικά!</span>
        ) : (
          <span>
            Ακόμα <strong className="tabular">{formatPrice(totals.freeShippingRemainingCents ?? 0)}</strong> για δωρεάν μεταφορικά
          </span>
        )}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-oil-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-oil-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function CartDrawer() {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const { lines, isOpen, lastAdded, close, setQuantity, remove } = useCart();
  const { canOrder, phone } = useStoreConfig();
  const panelRef = useRef<HTMLDivElement>(null);

  // close on navigation
  useEffect(() => {
    useCart.getState().close();
  }, [pathname]);

  useEffect(() => {
    if (!isOpen) return;
    void syncCartWithServer(useCart.getState().lines);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [isOpen, close]);

  if (!hydrated || !isOpen) return null;

  const subtotal = cartSubtotalCents(lines);
  const count = cartCount(lines);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Καλάθι αγορών">
      <button type="button" aria-label="Κλείσιμο καλαθιού" onClick={close} className="animate-fade-in absolute inset-0 h-full w-full cursor-default bg-ink-950/55 backdrop-blur-[2px]" />
      <div ref={panelRef} tabIndex={-1} className="animate-slide-in-right absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-lift outline-none">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="display text-2xl">
            Καλάθι {count > 0 && <span className="text-ink-400">({count})</span>}
          </h2>
          <button type="button" onClick={close} aria-label="Κλείσιμο" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-ink-600 hover:bg-ink-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-ink-100 text-ink-400">
              <ShoppingCart className="h-7 w-7" />
            </span>
            <p className="text-ink-600">Το καλάθι σας είναι άδειο.</p>
            <Link href="/products" onClick={close} className={buttonClass({ variant: 'dark' })}>
              Δείτε τα προϊόντα
            </Link>
          </div>
        ) : (
          <>
            <ul className="flex-1 divide-y divide-line overflow-y-auto px-5">
              {lines.map((line) => (
                <li key={line.variantId} className={cn('flex gap-3 py-4 transition-colors', lastAdded === line.variantId && '-mx-5 bg-oil-50 px-5')}>
                  <Link href={`/product/${line.snapshot.slug}`} onClick={close} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line bg-white">
                    {line.snapshot.imageUrl && <Image src={line.snapshot.imageUrl} alt="" fill sizes="80px" className="object-contain p-1.5" />}
                  </Link>
                  <div className="min-w-0 flex-1">
                    {line.snapshot.brandName && <p className="eyebrow text-[0.6875rem] text-ink-400">{line.snapshot.brandName}</p>}
                    <Link href={`/product/${line.snapshot.slug}`} onClick={close} className="line-clamp-2 text-sm leading-snug font-semibold text-ink-900 hover:text-oil-700">
                      {line.snapshot.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {line.snapshot.variantLabel} · <span className="tabular">{formatPrice(line.snapshot.unitPriceCents)}</span>
                    </p>
                    <AvailabilityTag availability={line.snapshot.availability} className="mt-0.5" />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <QuantityStepper size="sm" value={line.quantity} max={line.snapshot.maxQuantity} onChange={(q) => setQuantity(line.variantId, q)} />
                      <span className="tabular text-sm font-bold text-ink-900">{formatPrice(line.quantity * line.snapshot.unitPriceCents)}</span>
                    </div>
                  </div>
                  <button type="button" onClick={() => remove(line.variantId)} aria-label={`Αφαίρεση ${line.snapshot.name}`} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center self-start rounded-lg text-ink-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>

            <div className="safe-bottom shrink-0 space-y-3 border-t border-line bg-ink-50 p-5">
              <FreeShippingMeter subtotalCents={subtotal} weightGrams={cartWeightGrams(lines)} />
              <div className="flex items-baseline justify-between">
                <span className="text-ink-600">Υποσύνολο</span>
                <span className="tabular text-xl font-bold text-ink-900">{formatPrice(subtotal)}</span>
              </div>
              <p className="text-xs text-ink-500">Οι τιμές περιλαμβάνουν ΦΠΑ. Τα μεταφορικά υπολογίζονται στο ταμείο.</p>
              {canOrder ? (
                <Link href="/checkout" onClick={close} className={buttonClass({ size: 'lg', full: true })}>
                  Ολοκλήρωση παραγγελίας
                </Link>
              ) : (
                <OrdersClosedNotice phone={phone} compact onNavigate={close} />
              )}
              <Link href="/cart" onClick={close} className={buttonClass({ variant: 'outline', full: true })}>
                Προβολή καλαθιού
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
