import Link from 'next/link';
import { ChevronLeft, ChevronRight, SearchX } from 'lucide-react';
import { FilterSidebar, MobileFilters, SortSelect } from '@/components/store/filter-panel';
import { ProductGrid } from '@/components/store/product-card';
import { TrackSearch } from '@/components/store/tracker';
import { buttonClass } from '@/components/ui/button';
import { SORT_LABELS, listProducts, type ListingFilters } from '@/lib/catalog';
import { activeFilterCount, listingHref, parseListingParams, type RawSearchParams } from '@/lib/listing-params';
import { breadcrumbJsonLd, jsonLdString } from '@/lib/seo';
import { cn } from '@/lib/utils';

export type Crumb = { name: string; href: string };

/**
 * The same cards as everywhere else, but the filters take a fixed 384 px out of the row from 1024 up, so from there
 * the image is (33vw − 143 px) over three columns, and a flat 215 px once the fourth column arrives at 1280. Rounded
 * up a little; below 1024 the filters are a drawer and the grid has the row to itself, so those two entries match
 * ProductGrid's own default.
 */
const LISTING_IMAGE_SIZES = '(min-width: 1280px) 220px, (min-width: 1024px) calc(33vw - 130px), (min-width: 640px) 33vw, 50vw';

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const all = [{ name: 'Αρχική', href: '/' }, ...items];
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(breadcrumbJsonLd(all)) }} />
      <nav aria-label="Διαδρομή" className="no-scrollbar overflow-x-auto">
        <ol className="flex items-center gap-1.5 text-sm whitespace-nowrap text-ink-500">
          {all.map((item, i) => (
            <li key={item.href} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-ink-300" />}
              {i === all.length - 1 ? <span aria-current="page" className="font-medium text-ink-800">{item.name}</span> : <Link href={item.href} className="hover:text-ink-900">{item.name}</Link>}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

function Pagination({ page, pageCount, pathname, searchParams }: { page: number; pageCount: number; pathname: string; searchParams: RawSearchParams }) {
  if (pageCount <= 1) return null;
  const href = (p: number) => listingHref(pathname, searchParams, { page: p > 1 ? String(p) : null });
  const pages = [...new Set([1, page - 1, page, page + 1, pageCount])].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const item = 'tabular flex h-11 min-w-11 items-center justify-center rounded-xl border px-3 text-sm font-semibold';

  return (
    <nav aria-label="Σελιδοποίηση" className="mt-10 flex flex-wrap items-center justify-center gap-1.5">
      {page > 1 && (
        <Link href={href(page - 1)} rel="prev" aria-label="Προηγούμενη σελίδα" className={cn(item, 'border-ink-200 bg-white text-ink-700 hover:border-ink-400')}>
          <ChevronLeft className="h-4 w-4" />
        </Link>
      )}
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - pages[i - 1] > 1 && <span className="px-1 text-ink-400">…</span>}
          <Link href={href(p)} aria-current={p === page ? 'page' : undefined} className={cn(item, p === page ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-400')}>
            {p}
          </Link>
        </span>
      ))}
      {page < pageCount && (
        <Link href={href(page + 1)} rel="next" aria-label="Επόμενη σελίδα" className={cn(item, 'border-ink-200 bg-white text-ink-700 hover:border-ink-400')}>
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </nav>
  );
}

type Props = {
  pathname: string;
  searchParams: RawSearchParams;
  /** fixed scope of the page (category / brand / viscosity); merged over whatever the URL says */
  scope?: Pick<ListingFilters, 'categorySlug' | 'brandSlug' | 'viscosity'>;
  title: string;
  eyebrow?: string;
  description?: string | null;
  crumbs: Crumb[];
  /** e.g. sub-category chips */
  children?: React.ReactNode;
  /** shown under the products, e.g. the explainer of a viscosity page */
  footer?: React.ReactNode;
};

export async function ProductListing({ pathname, searchParams, scope, title, eyebrow, description, crumbs, children, footer }: Props) {
  // a facet the page hides must not filter behind the visitor's back (?cat= on a category page, ?visc= on a viscosity page)
  const hidden = { hideBrands: Boolean(scope?.brandSlug), hideViscosities: Boolean(scope?.viscosity), hideCategories: Boolean(scope?.categorySlug) };
  const filters = { ...parseListingParams(searchParams), ...(hidden.hideCategories && { categories: [] }), ...(hidden.hideViscosities && { viscosities: [] }), ...scope };
  const listing = await listProducts(filters);
  const active = activeFilterCount(filters);

  return (
    <div className="container-page py-6 sm:py-8">
      {/* a search with no results is the most useful statistic of all: it names a product people want and cannot find */}
      {filters.q && (filters.page ?? 1) === 1 && active === 0 && <TrackSearch query={filters.q} results={listing.total} />}
      <Breadcrumbs items={crumbs} />

      <header className="mt-5 max-w-3xl">
        {eyebrow && <p className="eyebrow text-oil-700">{eyebrow}</p>}
        <h1 className="display mt-1 text-4xl sm:text-5xl">{title}</h1>
        {description && <p className="mt-3 leading-relaxed text-ink-600">{description}</p>}
      </header>

      {children}

      <div className="mt-8 flex items-start gap-8">
        <FilterSidebar facets={listing.facets} activeCount={active} {...hidden} />

        <div className="min-w-0 flex-1">
          <div className="mb-5 flex items-center justify-between gap-3">
            <p className="text-sm text-ink-600">
              <strong className="tabular font-semibold text-ink-950">{listing.total}</strong> {listing.total === 1 ? 'προϊόν' : 'προϊόντα'}
              {filters.q && <> για «{filters.q}»</>}
            </p>
            <div className="flex items-center gap-2">
              <MobileFilters facets={listing.facets} total={listing.total} activeCount={active} {...hidden} />
              <SortSelect sortLabels={SORT_LABELS} />
            </div>
          </div>

          {listing.products.length > 0 ? (
            <>
              <ProductGrid products={listing.products} priorityCount={4} sizes={LISTING_IMAGE_SIZES} />
              <Pagination page={listing.page} pageCount={listing.pageCount} pathname={pathname} searchParams={searchParams} />
            </>
          ) : (
            <div className="rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-16 text-center">
              <SearchX className="mx-auto h-10 w-10 text-ink-300" />
              <h2 className="display mt-4 text-2xl">Δεν βρέθηκαν προϊόντα</h2>
              <p className="mx-auto mt-2 max-w-md text-ink-600">
                {active > 0 ? 'Δοκιμάστε να αφαιρέσετε κάποιο φίλτρο.' : 'Δοκιμάστε άλλη αναζήτηση — π.χ. ιξώδες (5W-30) ή μάρκα.'} Αν ψάχνετε κάτι συγκεκριμένο, καλέστε μας: πιθανότατα το έχουμε στο κατάστημα.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Link href={pathname} className={buttonClass({ variant: 'dark' })}>Καθαρισμός φίλτρων</Link>
                <Link href="/find-my-oil" className={buttonClass({ variant: 'outline' })}>Ποιο λάδι θέλει το όχημά μου;</Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
