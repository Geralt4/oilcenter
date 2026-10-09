'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Heart, House, LayoutGrid, Navigation, Phone, ShoppingCart } from 'lucide-react';
import { useStoreConfig } from '@/components/store/store-context';
import { cartCount, useCart, useHydrated } from '@/lib/cart-store';
import { cn } from '@/lib/utils';

/** Phone-only tab bar. Calling the shop and getting directions are one thumb away on every page. */
export function BottomBar({ phoneHref, directionsHref }: { phoneHref: string; directionsHref: string }) {
  const pathname = usePathname();
  const { canOrder } = useStoreConfig();
  const hydrated = useHydrated();
  const lines = useCart((s) => s.lines);
  const openCart = useCart((s) => s.open);
  const count = hydrated ? cartCount(lines) : 0;

  // the checkout has its own sticky total bar; keep this one out of the way
  if (pathname.startsWith('/checkout')) return null;

  const item = 'flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium';
  return (
    <nav aria-label="Γρήγορες ενέργειες" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur md:hidden">
      <div className="flex h-15 items-stretch">
        <Link href="/" className={cn(item, pathname === '/' ? 'text-ink-950' : 'text-ink-500')}>
          <House className="h-5 w-5" />
          Αρχική
        </Link>
        <Link href="/products" className={cn(item, pathname.startsWith('/products') || pathname.startsWith('/category') ? 'text-ink-950' : 'text-ink-500')}>
          <LayoutGrid className="h-5 w-5" />
          Προϊόντα
        </Link>
        <a href={phoneHref} className={cn(item, 'text-ink-950')}>
          <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-oil-500 shadow-[0_6px_16px_-4px_rgb(242_163_11/0.8)] ring-4 ring-white">
            <Phone className="h-5 w-5" />
          </span>
          Κλήση
        </a>
        <a href={directionsHref} target="_blank" rel="noopener noreferrer" className={cn(item, 'text-ink-500')}>
          <Navigation className="h-5 w-5" />
          Οδηγίες
        </a>
        {/* catalogue mode has no cart: the fifth tab is the visitor's saved products instead */}
        {!canOrder ? (
          <Link href="/wishlist" className={cn(item, pathname.startsWith('/wishlist') ? 'text-ink-950' : 'text-ink-500')}>
            <Heart className="h-5 w-5" />
            Αγαπημένα
          </Link>
        ) : (
        <button type="button" onClick={openCart} className={cn(item, 'relative text-ink-500')}>
          <span className="relative">
            <ShoppingCart className="h-5 w-5" />
            {count > 0 && (
              <span className="tabular absolute -top-2 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-oil-500 px-1 text-[0.625rem] font-bold text-ink-950">{count}</span>
            )}
          </span>
          Καλάθι
        </button>
        )}
      </div>
    </nav>
  );
}
