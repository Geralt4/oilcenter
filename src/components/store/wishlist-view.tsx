'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CircleAlert, Heart, LoaderCircle } from 'lucide-react';
import { ProductGrid } from '@/components/store/product-card';
import { buttonClass } from '@/components/ui/button';
import type { CatalogProduct } from '@/lib/catalog';
import { useHydrated, useWishlist } from '@/lib/cart-store';

/** the most ids /api/products takes in one request */
const BATCH = 60;

export function WishlistView() {
  const hydrated = useHydrated();
  const ids = useWishlist((s) => s.ids);
  const [fetched, setProducts] = useState<CatalogProduct[] | null>(null);
  // a failed load is told, with a way to try again: an empty list or a spinner that never stops would be wrong in both directions
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // an empty wishlist needs no request (and no state): derive it
  const products = ids.length === 0 ? [] : fetched;

  useEffect(() => {
    if (!hydrated || ids.length === 0) return;
    const controller = new AbortController();
    // the endpoint answers at most 60 ids per request: a longer list goes in batches, joined back in the saved order
    const batches: number[][] = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    Promise.all(
      batches.map((batch) =>
        fetch(`/api/products?ids=${batch.join(',')}`, { signal: controller.signal })
          .then((r) => {
            if (!r.ok) throw new Error(`/api/products answered ${r.status}`);
            return r.json();
          })
          .then((d: { products: CatalogProduct[] }) => d.products),
      ),
    )
      .then((parts) => {
        setFailed(false);
        setProducts(parts.flat());
      })
      .catch(() => {
        // leaving the page (or a changed list) aborts the request: that is not a failure
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [hydrated, ids, attempt]);

  if (hydrated && ids.length > 0 && failed) {
    return (
      <div role="alert" className="mx-auto max-w-md rounded-3xl border border-amber-200 bg-amber-50 px-6 py-12 text-center">
        <CircleAlert className="mx-auto h-10 w-10 text-amber-600" />
        <h2 className="display mt-4 text-2xl text-amber-950">Δεν φορτώθηκαν τα αγαπημένα σας</h2>
        <p className="mt-2 text-amber-900">Ελέγξτε τη σύνδεσή σας και δοκιμάστε ξανά. Τα αγαπημένα σας είναι αποθηκευμένα.</p>
        <button type="button" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }} className={buttonClass({ variant: 'dark', className: 'mt-6' })}>Δοκιμάστε ξανά</button>
      </div>
    );
  }

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
