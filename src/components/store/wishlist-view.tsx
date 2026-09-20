'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Heart, LoaderCircle } from 'lucide-react';
import { ProductGrid } from '@/components/store/product-card';
import { buttonClass } from '@/components/ui/button';
import type { CatalogProduct } from '@/lib/catalog';
import { useHydrated, useWishlist } from '@/lib/cart-store';

export function WishlistView() {
  const hydrated = useHydrated();
  const ids = useWishlist((s) => s.ids);
  const [fetched, setProducts] = useState<CatalogProduct[] | null>(null);
  // an empty wishlist needs no request (and no state): derive it
  const products = ids.length === 0 ? [] : fetched;

  useEffect(() => {
    if (!hydrated || ids.length === 0) return;
    const controller = new AbortController();
    fetch(`/api/products?ids=${ids.slice(0, 60).join(',')}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { products: [] }))
      .then((d: { products: CatalogProduct[] }) => setProducts(d.products))
      .catch(() => undefined);
    return () => controller.abort();
  }, [hydrated, ids]);

  if (!hydrated || products === null) return <div className="flex min-h-[30vh] items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-ink-300" /></div>;

  if (products.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-16 text-center">
        <Heart className="mx-auto h-10 w-10 text-ink-300" />
        <h2 className="display mt-4 text-2xl">Δεν έχετε αγαπημένα ακόμη</h2>
        <p className="mt-2 text-ink-600">Πατήστε την καρδιά σε όποιο προϊόν θέλετε να ξαναβρείτε εύκολα — π.χ. το λάδι που βάζετε σε κάθε σέρβις.</p>
        <Link href="/products" className={buttonClass({ variant: 'dark', className: 'mt-6' })}>Δείτε τα προϊόντα</Link>
      </div>
    );
  }
  return <ProductGrid products={products} />;
}
