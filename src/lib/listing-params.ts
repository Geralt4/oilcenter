import type { ListingFilters, SortKey } from '@/lib/catalog';

/*
 * Listing state lives entirely in the URL so that filtered pages can be shared, bookmarked and crawled:
 *   ?brand=castrol,motul&visc=5W-30&pack=1000,5000&base=synthetic&stock=1&sale=1&min=10&max=60&sort=price-asc&page=2&q=…
 */
export type RawSearchParams = Record<string, string | string[] | undefined>;

const SORTS: SortKey[] = ['featured', 'price-asc', 'price-desc', 'name', 'newest'];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const list = (v: string | string[] | undefined) =>
  first(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);

export function parseListingParams(sp: RawSearchParams): ListingFilters {
  const sort = first(sp.sort) as SortKey;
  const euros = (v: string) => {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
  };
  return {
    q: first(sp.q).slice(0, 80) || undefined,
    brands: list(sp.brand),
    viscosities: list(sp.visc),
    packs: list(sp.pack).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    baseTypes: list(sp.base),
    inStockOnly: first(sp.stock) === '1',
    onSaleOnly: first(sp.sale) === '1',
    minPriceCents: first(sp.min) ? euros(first(sp.min)) : undefined,
    maxPriceCents: first(sp.max) ? euros(first(sp.max)) : undefined,
    sort: SORTS.includes(sort) ? sort : 'featured',
    page: Math.max(1, Math.floor(Number(first(sp.page)) || 1)),
  };
}

export function activeFilterCount(f: ListingFilters): number {
  return (
    (f.brands?.length ?? 0) +
    (f.viscosities?.length ?? 0) +
    (f.packs?.length ?? 0) +
    (f.baseTypes?.length ?? 0) +
    (f.inStockOnly ? 1 : 0) +
    (f.onSaleOnly ? 1 : 0) +
    (f.minPriceCents !== undefined || f.maxPriceCents !== undefined ? 1 : 0)
  );
}

/** Builds an href for the same listing with some params changed. `null` removes a param; page resets unless given. */
export function listingHref(pathname: string, current: RawSearchParams, changes: Record<string, string | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const value = first(v);
    if (value) params.set(k, value);
  }
  if (!('page' in changes)) params.delete('page');
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === '') params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
