import type { Metadata } from 'next';
import { ProductListing } from '@/components/store/product-listing';
import type { RawSearchParams } from '@/lib/listing-params';

type Props = { searchParams: Promise<RawSearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  return {
    title: q ? `Αναζήτηση: ${q}` : 'Όλα τα προϊόντα',
    description: 'Λιπαντικά κινητήρα, βαλβολίνες, αντιψυκτικά, πρόσθετα και σπρέι συντήρησης. Φιλτράρετε ανά ιξώδες, μάρκα και συσκευασία.',
    alternates: { canonical: '/products' },
    // search results and filtered views are thin / duplicate content
    robots: q || Object.keys(sp).length > 0 ? { index: false, follow: true } : undefined,
  };
}

export default async function ProductsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  return (
    <ProductListing
      pathname="/products"
      searchParams={sp}
      title={q ? `Αποτελέσματα για «${q}»` : 'Όλα τα προϊόντα'}
      eyebrow={q ? 'Αναζήτηση' : 'Κατάλογος'}
      description={q ? null : 'Ό,τι χρειάζεται το όχημά σας, από τις μάρκες που εμπιστεύονται οι επαγγελματίες. Δεν βρίσκετε κάτι; Καλέστε μας — το κατάστημα έχει πολύ περισσότερα απ’ όσα χωράνε εδώ.'}
      crumbs={[{ name: q ? 'Αναζήτηση' : 'Προϊόντα', href: '/products' }]}
    />
  );
}
