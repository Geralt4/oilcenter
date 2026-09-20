import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductListing } from '@/components/store/product-listing';
import { getBrandBySlug } from '@/lib/catalog';
import type { RawSearchParams } from '@/lib/listing-params';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<RawSearchParams> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const brand = await getBrandBySlug(slug);
  if (!brand) return {};
  return {
    title: `${brand.name} — λιπαντικά & προϊόντα`,
    description: brand.description ?? `Όλα τα προϊόντα ${brand.name} στο Oil Center.`,
    alternates: { canonical: `/brand/${brand.slug}` },
    robots: Object.keys(sp).length > 0 ? { index: false, follow: true } : undefined,
  };
}

export default async function BrandPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const brand = await getBrandBySlug(slug);
  if (!brand) notFound();

  return (
    <ProductListing
      pathname={`/brand/${brand.slug}`}
      searchParams={sp}
      scope={{ brandSlug: brand.slug }}
      title={brand.name}
      eyebrow={brand.country ? `Μάρκα · ${brand.country}` : 'Μάρκα'}
      description={brand.description}
      crumbs={[
        { name: 'Μάρκες', href: '/brands' },
        { name: brand.name, href: `/brand/${brand.slug}` },
      ]}
    />
  );
}
