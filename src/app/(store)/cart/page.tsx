import type { Metadata } from 'next';
import { CartView } from '@/components/store/cart-view';
import { Breadcrumbs } from '@/components/store/product-listing';
import { requireOrdering } from '@/lib/catalogue-mode';

export const metadata: Metadata = { title: 'Καλάθι αγορών', robots: { index: false, follow: false } };

export default async function CartPage() {
  await requireOrdering();
  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Καλάθι', href: '/cart' }]} />
      <h1 className="display mt-5 mb-7 text-4xl sm:text-5xl">Καλάθι αγορών</h1>
      <CartView />
    </div>
  );
}
