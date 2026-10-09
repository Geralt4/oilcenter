import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CategoryIcon } from '@/components/category-icon';
import { ProductListing } from '@/components/store/product-listing';
import { getCategoryBySlug } from '@/lib/catalog';
import type { RawSearchParams } from '@/lib/listing-params';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<RawSearchParams> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const hit = await getCategoryBySlug(slug);
  if (!hit) return {};
  const filtered = Object.keys(sp).length > 0;
  return {
    title: hit.node.name,
    description: hit.node.description ?? undefined,
    alternates: { canonical: `/category/${hit.node.slug}` },
    // spread, not `robots: undefined`: an explicit undefined would erase the store layout's demo-mode noindex
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const hit = await getCategoryBySlug(slug);
  if (!hit) notFound();
  const { node, trail } = hit;
  const parent = trail.length > 1 ? trail[trail.length - 2] : null;
  // on a leaf, show its siblings so the visitor can hop sideways
  const chips = node.children.length > 0 ? node.children : (parent?.children ?? []);

  return (
    <ProductListing
      pathname={`/category/${node.slug}`}
      searchParams={sp}
      scope={{ categorySlug: node.slug }}
      title={node.name}
      eyebrow={parent?.name}
      description={node.description}
      crumbs={trail.map((c) => ({ name: c.name, href: `/category/${c.slug}` }))}
    >
      {chips.filter((c) => c.productCount > 0).length > 1 && (
        <ul className="no-scrollbar -mx-4 mt-6 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          {chips
            .filter((c) => c.productCount > 0)
            .map((c) => (
              <li key={c.id} className="shrink-0">
                <Link
                  href={`/category/${c.slug}`}
                  aria-current={c.id === node.id ? 'page' : undefined}
                  className={
                    c.id === node.id
                      ? 'flex h-11 items-center gap-2 rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white'
                      : 'flex h-11 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-800 shadow-tile hover:border-oil-400'
                  }
                >
                  <CategoryIcon name={c.icon} className="h-4 w-4 opacity-70" />
                  {c.name}
                  <span className="tabular text-xs font-medium opacity-80">{c.productCount}</span>
                </Link>
              </li>
            ))}
        </ul>
      )}
    </ProductListing>
  );
}
