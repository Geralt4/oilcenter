import type { Metadata } from 'next';
import { Breadcrumbs } from '@/components/store/product-listing';
import { WishlistView } from '@/components/store/wishlist-view';

export const metadata: Metadata = { title: 'Αγαπημένα', robots: { index: false, follow: true } };

export default function WishlistPage() {
  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Αγαπημένα', href: '/wishlist' }]} />
      <h1 className="display mt-5 mb-7 text-4xl sm:text-5xl">Αγαπημένα</h1>
      <WishlistView />
    </div>
  );
}
