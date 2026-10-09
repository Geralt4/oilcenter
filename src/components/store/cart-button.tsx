'use client';

import { ShoppingCart } from 'lucide-react';
import { cartCount, cartSubtotalCents, useCart, useHydrated } from '@/lib/cart-store';
import { formatPrice } from '@/lib/utils';

export function CartButton() {
  const hydrated = useHydrated();
  const lines = useCart((s) => s.lines);
  const open = useCart((s) => s.open);
  const count = hydrated ? cartCount(lines) : 0;

  return (
    <button
      type="button"
      onClick={open}
      aria-label={count ? `Καλάθι, ${count === 1 ? '1 προϊόν' : `${count} προϊόντα`}` : 'Καλάθι'}
      className="relative flex h-11 cursor-pointer items-center gap-2.5 rounded-xl bg-ink-900 pr-4 pl-3.5 text-white transition-colors hover:bg-ink-700"
    >
      <span className="relative">
        <ShoppingCart className="h-5 w-5" />
        {count > 0 && (
          <span key={count} className="animate-pop tabular absolute -top-2.5 -right-2.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-oil-500 px-1 text-[0.6875rem] font-bold text-ink-950">
            {count}
          </span>
        )}
      </span>
      <span className="tabular hidden text-sm font-semibold sm:inline">{count > 0 ? formatPrice(cartSubtotalCents(lines)) : 'Καλάθι'}</span>
    </button>
  );
}
