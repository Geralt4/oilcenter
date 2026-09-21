import { cache } from 'react';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { bestAvailability, effectiveAvailability, type Availability } from '@/lib/availability';
import { db } from '@/lib/db';
import { brands, categories, productImages, products, variants, type BaseType, type Brand, type Category } from '@/lib/db/schema';
import { normalizeText } from '@/lib/utils';

/*
 * Storefront read model.
 *
 * The whole active catalogue is loaded once per request into a lean in-memory index and every
 * listing / filter / facet / search is computed from it. For a specialist shop (hundreds to a few
 * thousand products) this is faster than round-tripping SQL per facet and keeps facet counts exact.
 * If the catalogue ever grows past ~10k products, move filtering into SQL here — callers won't change.
 */

export type CatalogVariant = {
  id: number;
  sku: string;
  /** the manufacturer's article number and the barcode of this pack, when the owner has entered them */
  mpn: string | null;
  barcode: string | null;
  label: string;
  volumeMl: number | null;
  /** false = the owner has not confirmed this price yet: the storefront says «Καλέστε για τιμή» and the size cannot be bought */
  priced: boolean;
  /** 0 when `priced` is false — a placeholder price never leaves the server */
  priceCents: number;
  compareAtCents: number | null;
  /** what the owner set, unless counted stock has run out (then 'unavailable') */
  availability: Availability;
  /** can be bought: anything but 'unavailable'. "On order" sizes count as buyable. */
  inStock: boolean;
  /** units left, or null when stock is not tracked */
  stockLeft: number | null;
  imageUrl: string | null;
  weightGrams: number;
};

export type CatalogProduct = {
  id: number;
  slug: string;
  name: string;
  brand: { id: number; slug: string; name: string } | null;
  categoryId: number | null;
  viscosity: string | null;
  baseType: BaseType | null;
  specs: string[];
  isFeatured: boolean;
  createdAt: number;
  imageUrl: string | null;
  variants: CatalogVariant[];
  /** at least one size has a confirmed price; when false, min/max are 0 */
  hasPrice: boolean;
  minPriceCents: number;
  maxPriceCents: number;
  inStock: boolean;
  /** the best state among the sizes — what a product card says */
  availability: Availability;
  onSale: boolean;
};

type IndexedProduct = CatalogProduct & { searchText: string };

export type CategoryNode = Category & { children: CategoryNode[]; productCount: number };

export const BASE_TYPE_LABELS: Record<BaseType, string> = {
  synthetic: '100% Συνθετικό',
  'synthetic-technology': 'Συνθετικής τεχνολογίας',
  'semi-synthetic': 'Ημισυνθετικό',
  mineral: 'Ορυκτέλαιο',
};

const loadIndex = cache(async (): Promise<IndexedProduct[]> => {
  const [productRows, variantRows, imageRows, brandRows] = await Promise.all([
    db.select().from(products).where(eq(products.isActive, true)),
    db.select().from(variants).where(eq(variants.isActive, true)).orderBy(asc(variants.sort), asc(variants.volumeMl)),
    db.select().from(productImages).orderBy(asc(productImages.sort), asc(productImages.id)),
    db.select().from(brands),
  ]);

  const brandById = new Map(brandRows.map((b) => [b.id, b]));
  const firstImage = new Map<number, string>();
  for (const img of imageRows) if (!firstImage.has(img.productId)) firstImage.set(img.productId, img.url);

  const variantsByProduct = new Map<number, CatalogVariant[]>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    const availability = effectiveAvailability(v);
    list.push({
      id: v.id,
      sku: v.sku,
      mpn: v.mpn,
      barcode: v.barcode,
      label: v.label,
      volumeMl: v.volumeMl,
      priced: v.priceVerified,
      priceCents: v.priceVerified ? v.priceCents : 0,
      compareAtCents: v.priceVerified && v.compareAtCents && v.compareAtCents > v.priceCents ? v.compareAtCents : null,
      availability,
      inStock: availability !== 'unavailable',
      stockLeft: v.trackStock ? v.stock : null,
      imageUrl: v.imageUrl,
      weightGrams: v.weightGrams,
    });
    variantsByProduct.set(v.productId, list);
  }

  const out: IndexedProduct[] = [];
  for (const p of productRows) {
    const vs = variantsByProduct.get(p.id);
    if (!vs?.length) continue; // nothing purchasable → not shown
    const brand = p.brandId ? brandById.get(p.brandId) : undefined;
    const prices = vs.filter((v) => v.priced).map((v) => v.priceCents);
    out.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: brand ? { id: brand.id, slug: brand.slug, name: brand.name } : null,
      categoryId: p.categoryId,
      viscosity: p.viscosity,
      baseType: p.baseType ?? null,
      specs: p.specs ?? [],
      isFeatured: p.isFeatured,
      createdAt: p.createdAt.getTime(),
      imageUrl: firstImage.get(p.id) ?? vs.find((v) => v.imageUrl)?.imageUrl ?? null,
      variants: vs,
      hasPrice: prices.length > 0,
      minPriceCents: prices.length ? Math.min(...prices) : 0,
      maxPriceCents: prices.length ? Math.max(...prices) : 0,
      inStock: vs.some((v) => v.inStock),
      availability: bestAvailability(vs.map((v) => v.availability)),
      onSale: vs.some((v) => v.compareAtCents !== null),
      // Codes are added here, not into products.search_text: they are edited in places that never rebuild that column
      // (Admin → Skroutz codes, CSV import). Both spellings, so «MN7501-1» and «MN75011» find the same can.
      searchText: [p.searchText, ...vs.flatMap(codesOf).flatMap((c) => [normalizeText(c), compact(c)])].join(' '),
    });
  }
  return out;
});

const compact = (s: string) => normalizeText(s).replace(/ /g, '');
const codesOf = (v: CatalogVariant) => [v.sku, v.mpn, v.barcode].filter((c): c is string => Boolean(c));

/**
 * The size whose manufacturer code or barcode the query spells out, if any — so a suggestion can show why it matched.
 * Our own SKUs are left out: they are built from the product name, so «castrol edge» would "match" them.
 */
export function matchCode(p: CatalogProduct, q: string): { code: string; label: string } | null {
  const needle = compact(q);
  if (needle.length < 3) return null;
  for (const v of p.variants) for (const code of [v.mpn, v.barcode]) if (code && compact(code).startsWith(needle)) return { code, label: v.label };
  return null;
}

/**
 * Words match anywhere ("tronic" finds SuperTronic), but a term containing a digit must match from the
 * start of a token — otherwise "5w40" would also return every 15W-40, which is a different oil.
 */
function matchesTerm(searchText: string, term: string): boolean {
  return /\d/.test(term) ? ` ${searchText}`.includes(` ${term}`) : searchText.includes(term);
}

function strip(p: IndexedProduct): CatalogProduct {
  const { searchText: _searchText, ...rest } = p;
  return rest;
}

// ─── Categories & brands ─────────────────────────────────────────────────────
export const getCategoryTree = cache(async (): Promise<CategoryNode[]> => {
  const [rows, index] = await Promise.all([
    db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort), asc(categories.name)),
    loadIndex(),
  ]);
  const direct = new Map<number, number>();
  for (const p of index) if (p.categoryId) direct.set(p.categoryId, (direct.get(p.categoryId) ?? 0) + 1);

  const nodes = new Map<number, CategoryNode>(rows.map((c) => [c.id, { ...c, children: [], productCount: direct.get(c.id) ?? 0 }]));
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const total = (n: CategoryNode): number => {
    n.productCount += n.children.reduce((sum, c) => sum + total(c), 0);
    return n.productCount;
  };
  roots.forEach(total);
  return roots;
});

export async function getCategoryBySlug(slug: string): Promise<{ node: CategoryNode; trail: CategoryNode[] } | null> {
  const tree = await getCategoryTree();
  const walk = (nodes: CategoryNode[], trail: CategoryNode[]): { node: CategoryNode; trail: CategoryNode[] } | null => {
    for (const n of nodes) {
      if (n.slug === slug) return { node: n, trail: [...trail, n] };
      const hit = walk(n.children, [...trail, n]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, []);
}

export async function getCategoryTrailById(id: number | null): Promise<CategoryNode[]> {
  if (!id) return [];
  const tree = await getCategoryTree();
  const walk = (nodes: CategoryNode[], trail: CategoryNode[]): CategoryNode[] | null => {
    for (const n of nodes) {
      if (n.id === id) return [...trail, n];
      const hit = walk(n.children, [...trail, n]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

function descendantIds(node: CategoryNode): number[] {
  return [node.id, ...node.children.flatMap(descendantIds)];
}

/** category id → its slug / name, its top-level ancestor and its place in the tree (for ordering facets) */
const getCategoryLookup = cache(async () => {
  const byId = new Map<number, { slug: string; name: string; rootSlug: string; order: number }>();
  const walk = (nodes: CategoryNode[], rootSlug: string | null) => {
    for (const n of nodes) {
      byId.set(n.id, { slug: n.slug, name: n.name, rootSlug: rootSlug ?? n.slug, order: byId.size });
      walk(n.children, rootSlug ?? n.slug);
    }
  };
  walk(await getCategoryTree(), null);
  return byId;
});

export type BrandWithCount = Brand & { productCount: number };

export const getBrands = cache(async (): Promise<BrandWithCount[]> => {
  const [rows, index] = await Promise.all([db.select().from(brands).orderBy(asc(brands.sort), asc(brands.name)), loadIndex()]);
  const counts = new Map<number, number>();
  for (const p of index) if (p.brand) counts.set(p.brand.id, (counts.get(p.brand.id) ?? 0) + 1);
  return rows.map((b) => ({ ...b, productCount: counts.get(b.id) ?? 0 })).filter((b) => b.productCount > 0);
});

export async function getBrandBySlug(slug: string): Promise<BrandWithCount | null> {
  return (await getBrands()).find((b) => b.slug === slug) ?? null;
}

// ─── Listing ─────────────────────────────────────────────────────────────────
export type SortKey = 'featured' | 'price-asc' | 'price-desc' | 'name' | 'newest';

export const SORT_LABELS: Record<SortKey, string> = {
  featured: 'Προτεινόμενα',
  'price-asc': 'Τιμή: χαμηλότερη',
  'price-desc': 'Τιμή: υψηλότερη',
  name: 'Αλφαβητικά',
  newest: 'Νεότερα',
};

export type ListingFilters = {
  q?: string;
  categorySlug?: string;
  brandSlug?: string;
  /** fixed SAE grade of a /viscosity/… page, e.g. "5W-30" */
  viscosity?: string;
  brands?: string[];
  /** slugs of the products' own categories (the «Κατηγορία» facet on pages that are not a category page) */
  categories?: string[];
  viscosities?: string[];
  packs?: number[];
  baseTypes?: string[];
  inStockOnly?: boolean;
  onSaleOnly?: boolean;
  minPriceCents?: number;
  maxPriceCents?: number;
  sort?: SortKey;
  page?: number;
  perPage?: number;
};

export type FacetOption = { value: string; label: string; count: number };

export type Listing = {
  products: CatalogProduct[];
  total: number;
  page: number;
  pageCount: number;
  perPage: number;
  facets: {
    brands: FacetOption[];
    categories: FacetOption[];
    viscosities: FacetOption[];
    packs: FacetOption[];
    baseTypes: FacetOption[];
    inStockCount: number;
    onSaleCount: number;
    priceMinCents: number;
    priceMaxCents: number;
  };
};

/** "0W-20" < "5W-30" < "10W-40" < "75W-90": numeric, not lexical */
export function compareViscosity(a: string, b: string): number {
  const parse = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const [a1 = 0, a2 = 0] = parse(a);
  const [b1 = 0, b2 = 0] = parse(b);
  return a1 - b1 || a2 - b2 || a.localeCompare(b);
}

function packLabel(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toLocaleString('el-GR')} L` : `${ml} ml`;
}

export async function listProducts(filters: ListingFilters): Promise<Listing> {
  const index = await loadIndex();
  const perPage = filters.perPage ?? 24;

  // 1. Scope: things the visitor cannot un-tick from the sidebar (category page, brand page, search query).
  let scope = index;
  if (filters.categorySlug) {
    const hit = await getCategoryBySlug(filters.categorySlug);
    const ids = new Set(hit ? descendantIds(hit.node) : []);
    scope = scope.filter((p) => p.categoryId !== null && ids.has(p.categoryId));
  }
  if (filters.brandSlug) scope = scope.filter((p) => p.brand?.slug === filters.brandSlug);
  if (filters.viscosity) scope = scope.filter((p) => p.viscosity === filters.viscosity);
  const terms = filters.q ? normalizeText(filters.q).split(' ').filter(Boolean) : [];
  if (terms.length) scope = scope.filter((p) => terms.every((t) => matchesTerm(p.searchText, t)));

  // 2. Facet predicates. Each facet's counts are computed with every OTHER facet applied,
  //    so ticking "Castrol" never makes "Motul" read as 0.
  const brandSet = new Set(filters.brands ?? []);
  const categorySet = new Set(filters.categories ?? []);
  const categoryLookup = await getCategoryLookup();
  const categoryOf = (p: IndexedProduct) => (p.categoryId !== null ? categoryLookup.get(p.categoryId) : undefined);
  const viscSet = new Set(filters.viscosities ?? []);
  const packSet = new Set(filters.packs ?? []);
  const baseSet = new Set(filters.baseTypes ?? []);
  const min = filters.minPriceCents;
  const max = filters.maxPriceCents;

  const tests = {
    brand: (p: IndexedProduct) => !brandSet.size || (p.brand !== null && brandSet.has(p.brand.slug)),
    category: (p: IndexedProduct) => !categorySet.size || categorySet.has(categoryOf(p)?.slug ?? ''),
    viscosity: (p: IndexedProduct) => !viscSet.size || (p.viscosity !== null && viscSet.has(p.viscosity)),
    pack: (p: IndexedProduct) => !packSet.size || p.variants.some((v) => v.volumeMl !== null && packSet.has(v.volumeMl)),
    base: (p: IndexedProduct) => !baseSet.size || (p.baseType !== null && baseSet.has(p.baseType)),
    stock: (p: IndexedProduct) => !filters.inStockOnly || p.inStock,
    sale: (p: IndexedProduct) => !filters.onSaleOnly || p.onSale,
    // a price filter can only match products that show a price
    price: (p: IndexedProduct) => (min === undefined && max === undefined) || (p.hasPrice && (min === undefined || p.maxPriceCents >= min) && (max === undefined || p.minPriceCents <= max)),
  };
  type TestKey = keyof typeof tests;
  const applyExcept = (skip: TestKey | null) =>
    scope.filter((p) => (Object.keys(tests) as TestKey[]).every((k) => k === skip || tests[k](p)));

  const count = <K extends string>(items: IndexedProduct[], keysOf: (p: IndexedProduct) => K[]) => {
    const m = new Map<K, number>();
    for (const p of items) for (const k of new Set(keysOf(p))) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };

  const brandNames = new Map(scope.filter((p) => p.brand).map((p) => [p.brand!.slug, p.brand!.name]));
  const brandCounts = count(applyExcept('brand'), (p) => (p.brand ? [p.brand.slug] : []));
  const categoryCounts = count(applyExcept('category'), (p) => (categoryOf(p) ? [categoryOf(p)!.slug] : []));
  const categoryBySlug = new Map([...categoryLookup.values()].map((c) => [c.slug, c]));
  const viscCounts = count(applyExcept('viscosity'), (p) => (p.viscosity ? [p.viscosity] : []));
  const packCounts = count(applyExcept('pack'), (p) => p.variants.flatMap((v) => (v.volumeMl ? [String(v.volumeMl)] : [])));
  const baseCounts = count(applyExcept('base'), (p) => (p.baseType ? [p.baseType] : []));

  const matched = applyExcept(null);

  // 3. Sort
  const sort = filters.sort ?? 'featured';
  const sorted = [...matched].sort((a, b) => {
    // sold-out products sink regardless of the chosen order
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    // «Καλέστε για τιμή» products have no place in a price order: they go last either way
    if ((sort === 'price-asc' || sort === 'price-desc') && a.hasPrice !== b.hasPrice) return a.hasPrice ? -1 : 1;
    switch (sort) {
      case 'price-asc':
        return a.minPriceCents - b.minPriceCents;
      case 'price-desc':
        return b.minPriceCents - a.minPriceCents;
      case 'name':
        return a.name.localeCompare(b.name, 'el');
      case 'newest':
        return b.createdAt - a.createdAt || b.id - a.id;
      default:
        return Number(b.isFeatured) - Number(a.isFeatured) || (a.brand?.name ?? '').localeCompare(b.brand?.name ?? '') || a.name.localeCompare(b.name, 'el');
    }
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const page = Math.min(Math.max(1, filters.page ?? 1), pageCount);
  const priced = applyExcept('price').filter((p) => p.hasPrice);

  return {
    products: sorted.slice((page - 1) * perPage, page * perPage).map(strip),
    total: sorted.length,
    page,
    pageCount,
    perPage,
    facets: {
      brands: [...brandCounts].map(([value, n]) => ({ value, label: brandNames.get(value) ?? value, count: n })).sort((a, b) => a.label.localeCompare(b.label)),
      // in the order of the shop's own menu, not alphabetical
      categories: [...categoryCounts].map(([value, n]) => ({ value, label: categoryBySlug.get(value)?.name ?? value, count: n })).sort((a, b) => (categoryBySlug.get(a.value)?.order ?? 0) - (categoryBySlug.get(b.value)?.order ?? 0)),
      viscosities: [...viscCounts].map(([value, n]) => ({ value, label: value, count: n })).sort((a, b) => compareViscosity(a.value, b.value)),
      packs: [...packCounts].map(([value, n]) => ({ value, label: packLabel(Number(value)), count: n })).sort((a, b) => Number(a.value) - Number(b.value)),
      baseTypes: [...baseCounts].map(([value, n]) => ({ value, label: BASE_TYPE_LABELS[value as BaseType] ?? value, count: n })),
      inStockCount: applyExcept('stock').filter((p) => p.inStock).length,
      onSaleCount: applyExcept('sale').filter((p) => p.onSale).length,
      priceMinCents: priced.length ? Math.min(...priced.map((p) => p.minPriceCents)) : 0,
      priceMaxCents: priced.length ? Math.max(...priced.map((p) => p.maxPriceCents)) : 0,
    },
  };
}

export async function getFeaturedProducts(limit = 8): Promise<CatalogProduct[]> {
  const index = await loadIndex();
  const featured = index.filter((p) => p.isFeatured && p.inStock);
  const pool = featured.length >= limit ? featured : [...featured, ...index.filter((p) => !p.isFeatured && p.inStock)];
  return pool.slice(0, limit).map(strip);
}

export async function getProductsByIds(ids: number[]): Promise<CatalogProduct[]> {
  const index = await loadIndex();
  const byId = new Map(index.map((p) => [p.id, p]));
  return ids.flatMap((id) => (byId.has(id) ? [strip(byId.get(id)!)] : []));
}

/** Viscosity grades that actually exist in the engine-oil range, most stocked first. */
export async function getPopularViscosities(limit = 8): Promise<Array<{ viscosity: string; count: number }>> {
  const index = await loadIndex();
  const counts = new Map<string, number>();
  for (const p of index) {
    if (!p.viscosity || !/^\d+W-\d+$/.test(p.viscosity)) continue;
    const winter = Number(p.viscosity.split('W')[0]);
    if (winter > 25) continue; // 75W-90 etc. are gear oils, not what "find my engine oil" is about
    counts.set(p.viscosity, (counts.get(p.viscosity) ?? 0) + 1);
  }
  return [...counts]
    .map(([viscosity, count]) => ({ viscosity, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .sort((a, b) => compareViscosity(a.viscosity, b.viscosity));
}

// ─── Viscosity pages (/viscosity/5w-30) ──────────────────────────────────────
export type ViscosityInfo = {
  /** as stored on the products: "5W-30" */
  grade: string;
  /** URL form: "5w-30" */
  slug: string;
  count: number;
  /** brand names, the best stocked first */
  brands: string[];
  /** lowest confirmed price among them, or null when none has one yet */
  minPriceCents: number | null;
  /** what most products of this grade are: decides whether the page says «Λάδια κινητήρα» or «Βαλβολίνες» */
  kind: 'engine' | 'gear';
};

const GEAR_ROOT_SLUG = 'valvolines-kivotia';

export const viscositySlug = (grade: string) => grade.toLowerCase();

/** "5W-30" stays as it is; a bare number ("90", "140") reads better as "SAE 90" */
export const viscosityLabel = (grade: string) => (/w/i.test(grade) ? grade : `SAE ${grade}`);

export const getViscosities = cache(async (): Promise<ViscosityInfo[]> => {
  const [index, lookup] = await Promise.all([loadIndex(), getCategoryLookup()]);
  const byGrade = new Map<string, IndexedProduct[]>();
  for (const p of index) if (p.viscosity) byGrade.set(p.viscosity, [...(byGrade.get(p.viscosity) ?? []), p]);

  return [...byGrade]
    .map(([grade, items]) => {
      const brandCounts = new Map<string, number>();
      for (const p of items) if (p.brand) brandCounts.set(p.brand.name, (brandCounts.get(p.brand.name) ?? 0) + 1);
      const gear = items.filter((p) => (p.categoryId !== null ? lookup.get(p.categoryId)?.rootSlug : undefined) === GEAR_ROOT_SLUG).length;
      const prices = items.filter((p) => p.hasPrice).map((p) => p.minPriceCents);
      return {
        grade,
        slug: viscositySlug(grade),
        count: items.length,
        brands: [...brandCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
        minPriceCents: prices.length ? Math.min(...prices) : null,
        kind: gear * 2 > items.length ? ('gear' as const) : ('engine' as const),
      };
    })
    .sort((a, b) => compareViscosity(a.grade, b.grade));
});

export async function getViscosityBySlug(slug: string): Promise<ViscosityInfo | null> {
  return (await getViscosities()).find((v) => v.slug === slug.toLowerCase()) ?? null;
}

export async function suggestProducts(q: string, limit = 6): Promise<CatalogProduct[]> {
  const terms = normalizeText(q).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const index = await loadIndex();
  return index
    .filter((p) => terms.every((t) => matchesTerm(p.searchText, t)))
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || Number(b.isFeatured) - Number(a.isFeatured))
    .slice(0, limit)
    .map(strip);
}

// ─── Product detail ──────────────────────────────────────────────────────────
export async function getProductBySlug(slug: string) {
  const product = await db.query.products.findFirst({
    where: and(eq(products.slug, slug), eq(products.isActive, true)),
    with: {
      brand: true,
      category: true,
      images: { orderBy: [asc(productImages.sort), asc(productImages.id)] },
      variants: { where: eq(variants.isActive, true), orderBy: [asc(variants.sort), asc(variants.volumeMl)] },
    },
  });
  if (!product || product.variants.length === 0) return null;
  return product;
}

export type ProductDetail = NonNullable<Awaited<ReturnType<typeof getProductBySlug>>>;

export async function getRelatedProducts(product: { id: number; categoryId: number | null; brandId: number | null; viscosity: string | null }, limit = 4): Promise<CatalogProduct[]> {
  const index = await loadIndex();
  const scored = index
    .filter((p) => p.id !== product.id && p.inStock)
    .map((p) => {
      let score = 0;
      if (product.viscosity && p.viscosity === product.viscosity) score += 4;
      if (product.categoryId && p.categoryId === product.categoryId) score += 3;
      if (product.brandId && p.brand?.id === product.brandId) score += 1;
      return { p, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || Number(b.p.isFeatured) - Number(a.p.isFeatured));
  return scored.slice(0, limit).map((x) => strip(x.p));
}

// ─── Cart resolution ─────────────────────────────────────────────────────────
export type ResolvedCartLine = {
  variantId: number;
  productId: number;
  slug: string;
  name: string;
  brandName: string | null;
  variantLabel: string;
  sku: string;
  imageUrl: string | null;
  unitPriceCents: number;
  compareAtCents: number | null;
  quantity: number;
  /** null = unlimited */
  maxQuantity: number | null;
  lineTotalCents: number;
  /** weight of the whole line */
  weightGrams: number;
  unitWeightGrams: number;
  /** null on a line that can no longer be bought */
  availability: Availability | null;
  issue: 'unavailable' | 'out_of_stock' | 'quantity_reduced' | null;
};

/**
 * Turns {variantId, quantity} pairs from the browser into authoritative lines using live DB data.
 * The browser never supplies prices. Quantities are clamped to stock; vanished variants are reported.
 */
export async function resolveCartLines(lines: Array<{ variantId: number; quantity: number }>): Promise<ResolvedCartLine[]> {
  const wanted = new Map<number, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.variantId) || !Number.isInteger(l.quantity) || l.quantity <= 0) continue;
    wanted.set(l.variantId, Math.min(999, (wanted.get(l.variantId) ?? 0) + l.quantity));
  }
  if (!wanted.size) return [];

  const rows = await db
    .select({ v: variants, p: products, brandName: brands.name })
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .leftJoin(brands, eq(products.brandId, brands.id))
    .where(inArray(variants.id, [...wanted.keys()]));

  const productIds = [...new Set(rows.map((r) => r.p.id))];
  const images = productIds.length
    ? await db.select().from(productImages).where(inArray(productImages.productId, productIds)).orderBy(asc(productImages.sort), asc(productImages.id))
    : [];
  const firstImage = new Map<number, string>();
  for (const img of images) if (!firstImage.has(img.productId)) firstImage.set(img.productId, img.url);

  const byVariant = new Map(rows.map((r) => [r.v.id, r]));
  const out: ResolvedCartLine[] = [];
  for (const [variantId, requested] of wanted) {
    const row = byVariant.get(variantId);
    // a size whose price the owner has not confirmed cannot be bought: same treatment as a withdrawn product
    if (!row || !row.v.isActive || !row.p.isActive || !row.v.priceVerified) {
      out.push({
        variantId, productId: row?.p.id ?? 0, slug: row?.p.slug ?? '', name: row?.p.name ?? 'Μη διαθέσιμο προϊόν', brandName: row?.brandName ?? null,
        variantLabel: row?.v.label ?? '', sku: row?.v.sku ?? '', imageUrl: null, unitPriceCents: 0, compareAtCents: null, quantity: 0, maxQuantity: 0,
        lineTotalCents: 0, weightGrams: 0, unitWeightGrams: 0, availability: null, issue: 'unavailable',
      });
      continue;
    }
    const { v, p } = row;
    // a size the owner marked "not available" is treated exactly like counted stock that ran out
    const availability = effectiveAvailability(v);
    const max = availability === 'unavailable' ? 0 : v.trackStock ? Math.max(0, v.stock) : null;
    const quantity = max === null ? requested : Math.min(requested, max);
    out.push({
      variantId,
      productId: p.id,
      slug: p.slug,
      name: p.name,
      brandName: row.brandName ?? null,
      variantLabel: v.label,
      sku: v.sku,
      imageUrl: v.imageUrl ?? firstImage.get(p.id) ?? null,
      unitPriceCents: v.priceCents,
      compareAtCents: v.compareAtCents && v.compareAtCents > v.priceCents ? v.compareAtCents : null,
      quantity,
      maxQuantity: max,
      lineTotalCents: v.priceCents * quantity,
      weightGrams: v.weightGrams * quantity,
      unitWeightGrams: v.weightGrams,
      availability,
      issue: quantity === 0 ? 'out_of_stock' : quantity < requested ? 'quantity_reduced' : null,
    });
  }
  return out;
}
