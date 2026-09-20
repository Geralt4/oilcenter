import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProductGrid } from '@/components/store/product-card';
import { Breadcrumbs } from '@/components/store/product-listing';
import { ProductView } from '@/components/store/product-view';
import { BASE_TYPE_LABELS, getCategoryTrailById, getProductBySlug, getRelatedProducts } from '@/lib/catalog';
import { productJsonLd } from '@/lib/seo';
import { getSettings } from '@/lib/settings.server';
import { formatWeight } from '@/lib/utils';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return {};
  const fullName = [product.brand?.name, product.name].filter(Boolean).join(' ');
  const sizes = product.variants.map((v) => v.label).join(', ');
  return {
    title: product.metaTitle || `${fullName}${sizes ? ` (${sizes})` : ''}`,
    description: product.metaDescription || `${fullName}: ${product.shortDescription ?? ''} Αγορά online ή παραλαβή από το Oil Center στη Θεσσαλονίκη.`.trim(),
    alternates: { canonical: `/product/${product.slug}` },
    openGraph: { title: fullName, images: product.images[0] ? [{ url: product.images[0].url, width: 1000, height: 1000 }] : undefined },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const [settings, trail, related] = await Promise.all([getSettings(), getCategoryTrailById(product.categoryId), getRelatedProducts(product, 4)]);

  const variants = product.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    label: v.label,
    volumeMl: v.volumeMl,
    // a placeholder price never leaves the server: the page says «Καλέστε για τιμή» instead
    priceCents: v.priceVerified ? v.priceCents : 0,
    compareAtCents: v.priceVerified && v.compareAtCents && v.compareAtCents > v.priceCents ? v.compareAtCents : null,
    inStock: !v.trackStock || v.stock > 0,
    stockLeft: v.trackStock ? v.stock : null,
    imageUrl: v.imageUrl,
    weightGrams: v.weightGrams,
    priceVerified: v.priceVerified,
  }));

  const rows: Array<[string, React.ReactNode]> = [];
  if (product.brand) rows.push(['Μάρκα', <Link key="b" href={`/brand/${product.brand.slug}`} className="font-medium text-petrol-500 underline underline-offset-2 hover:text-petrol-700">{product.brand.name}</Link>]);
  if (product.viscosity) rows.push(['Ιξώδες (SAE)', <span key="v" className="tabular font-semibold">{product.viscosity}</span>]);
  if (product.baseType) rows.push(['Τύπος', BASE_TYPE_LABELS[product.baseType]]);
  if (product.category) rows.push(['Κατηγορία', <Link key="c" href={`/category/${product.category.slug}`} className="font-medium text-petrol-500 underline underline-offset-2 hover:text-petrol-700">{product.category.name}</Link>]);
  rows.push(['Συσκευασίες', product.variants.map((v) => v.label).join(' · ')]);
  for (const [k, v] of Object.entries(product.attributes ?? {})) rows.push([k, v]);
  rows.push(['Βάρος αποστολής', product.variants.map((v) => `${v.label}: ${formatWeight(v.weightGrams)}`).join(' · ')]);
  if (product.brand?.country) rows.push(['Χώρα προέλευσης μάρκας', product.brand.country]);

  return (
    <div className="container-page py-6 sm:py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product, settings)) }} />
      <Breadcrumbs items={[...trail.map((c) => ({ name: c.name, href: `/category/${c.slug}` })), { name: product.name, href: `/product/${product.slug}` }]} />

      <div className="mt-6">
        <ProductView
          product={{ id: product.id, slug: product.slug, name: product.name, brandName: product.brand?.name ?? null, shortDescription: product.shortDescription }}
          images={product.images.map((i) => ({ url: i.url, alt: i.alt }))}
          variants={variants}
        />
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-12">
        <section aria-labelledby="desc">
          <h2 id="desc" className="display text-2xl sm:text-3xl">Περιγραφή</h2>
          <div className="prose-oc mt-4">
            {(product.description ?? '').split(/\n{2,}/).filter(Boolean).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        </section>

        <section aria-labelledby="specs">
          <h2 id="specs" className="display text-2xl sm:text-3xl">Χαρακτηριστικά</h2>
          <dl className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white text-[0.9375rem]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-4 px-4 py-3">
                <dt className="text-ink-500">{label}</dt>
                <dd className="text-ink-900">{value}</dd>
              </div>
            ))}
          </dl>

          {product.specs.length > 0 && (
            <>
              <h3 className="eyebrow mt-6 text-ink-500">Προδιαγραφές & εγκρίσεις</h3>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {product.specs.map((s) => (
                  <li key={s} className="tabular rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-medium text-ink-800">{s}</li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-ink-500">Όπως αναγράφονται στη συσκευασία του κατασκευαστή. Επιβεβαιώνετε πάντα την καταλληλότητα με το βιβλίο συντήρησης του οχήματός σας.</p>
            </>
          )}
        </section>
      </div>

      {related.length > 0 && (
        <section className="mt-16" aria-labelledby="related">
          <h2 id="related" className="display text-2xl sm:text-3xl">Δείτε επίσης</h2>
          <div className="mt-5">
            <ProductGrid products={related} />
          </div>
        </section>
      )}
    </div>
  );
}
