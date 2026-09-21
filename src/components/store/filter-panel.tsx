'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { FACET_TITLES } from '@/lib/approvals';
import type { FacetOption, Listing, SortKey } from '@/lib/catalog';
import { cn } from '@/lib/utils';

type Props = {
  facets: Listing['facets'];
  total: number;
  activeCount: number;
  /** hide the brand facet on a brand page, where it is the page's own scope */
  hideBrands?: boolean;
  /** same for a /viscosity/… page */
  hideViscosities?: boolean;
  /** a category page narrows with its own sub-category chips instead */
  hideCategories?: boolean;
};

type Hidden = Pick<Props, 'hideBrands' | 'hideViscosities' | 'hideCategories'>;

function useListingNav() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = (mutate: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete('page');
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  const selected = (key: string) => new Set((searchParams.get(key) ?? '').split(',').filter(Boolean));
  const toggle = (key: string, value: string) =>
    push((p) => {
      const set = selected(key);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      if (set.size) p.set(key, [...set].join(','));
      else p.delete(key);
    });
  const setParam = (key: string, value: string | null) => push((p) => (value ? p.set(key, value) : p.delete(key)));
  const clearAll = () =>
    push((p) => {
      for (const k of ['brand', 'cat', 'visc', 'spec', 'pack', 'base', 'stock', 'sale', 'min', 'max']) p.delete(k);
    });

  return { pending, searchParams, selected, toggle, setParam, clearAll };
}

function FacetGroup({ title, options, selected, onToggle, columns = 1, note }: { title: string; options: FacetOption[]; selected: Set<string>; onToggle: (value: string) => void; columns?: 1 | 2; note?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (options.length === 0) return null;
  const limit = columns === 2 ? 12 : 8;
  const visible = expanded ? options : options.slice(0, limit);

  return (
    <fieldset className="border-b border-line py-5 first:pt-0 last:border-0">
      <legend className="eyebrow float-left mb-3 w-full text-ink-900">{title}</legend>
      <div className={cn('clear-both grid gap-x-1 gap-y-1', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
        {visible.map((o) => {
          const checked = selected.has(o.value);
          const disabled = o.count === 0 && !checked;
          return (
            <label key={o.value} className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[0.9375rem] hover:bg-ink-50', disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent')}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(o.value)} className="h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer rounded border-ink-300 accent-ink-900" />
              <span className={cn('tabular min-w-0 flex-1', columns === 1 && 'truncate', checked ? 'font-semibold text-ink-950' : 'text-ink-700')}>{o.label}</span>
              <span className="tabular text-xs text-ink-400">{o.count}</span>
            </label>
          );
        })}
      </div>
      {options.length > limit && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="mt-2 cursor-pointer px-1.5 text-sm font-semibold text-petrol-500 hover:text-petrol-700">
          {expanded ? 'Λιγότερα' : `Όλα (${options.length})`}
        </button>
      )}
      {note && <p className="mt-2 px-1.5 text-xs leading-relaxed text-ink-500">{note}</p>}
    </fieldset>
  );
}

function Facets({ facets, hideBrands, hideViscosities, hideCategories }: Pick<Props, 'facets'> & Hidden) {
  const nav = useListingNav();

  return (
    <div className={cn('transition-opacity', nav.pending && 'opacity-60')} aria-busy={nav.pending}>
      {/* one category to choose from is no choice */}
      {!hideCategories && (facets.categories.length > 1 || nav.selected('cat').size > 0) && <FacetGroup title="Κατηγορία" options={facets.categories} selected={nav.selected('cat')} onToggle={(v) => nav.toggle('cat', v)} />}
      {!hideViscosities && <FacetGroup title="Ιξώδες (SAE)" options={facets.viscosities} selected={nav.selected('visc')} onToggle={(v) => nav.toggle('visc', v)} columns={2} />}
      {!hideBrands && <FacetGroup title="Μάρκα" options={facets.brands} selected={nav.selected('brand')} onToggle={(v) => nav.toggle('brand', v)} />}
      {/* one URL key for the three groups: ticking more than one NARROWS the list (an oil that carries all of them) */}
      {(['standard', 'oem', 'other'] as const).map((kind) => (
        <FacetGroup key={kind} title={FACET_TITLES[kind]} options={facets.approvals[kind]} selected={nav.selected('spec')} onToggle={(v) => nav.toggle('spec', v)} note={kind === 'oem' ? 'Όπως αναγράφονται στη συσκευασία. Επιβεβαιώστε με το βιβλίο συντήρησης.' : undefined} />
      ))}
      <FacetGroup title="Συσκευασία" options={facets.packs} selected={nav.selected('pack')} onToggle={(v) => nav.toggle('pack', v)} columns={2} />
      <FacetGroup title="Τύπος λιπαντικού" options={facets.baseTypes} selected={nav.selected('base')} onToggle={(v) => nav.toggle('base', v)} />

      <fieldset className="border-b border-line py-5">
        <legend className="eyebrow float-left mb-3 w-full text-ink-900">Τιμή (€)</legend>
        <PriceForm key={`${nav.searchParams.get('min')}|${nav.searchParams.get('max')}`} initialMin={nav.searchParams.get('min') ?? ''} initialMax={nav.searchParams.get('max') ?? ''} placeholderMin={Math.floor(facets.priceMinCents / 100)} placeholderMax={Math.ceil(facets.priceMaxCents / 100)} />
      </fieldset>

      <div className="space-y-1 py-5">
        {facets.onSaleCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[0.9375rem] text-ink-700 hover:bg-ink-50">
            <input type="checkbox" checked={nav.searchParams.get('sale') === '1'} onChange={(e) => nav.setParam('sale', e.target.checked ? '1' : null)} className="h-[1.125rem] w-[1.125rem] cursor-pointer accent-ink-900" />
            <span className="flex-1">Μόνο προσφορές</span>
            <span className="tabular text-xs text-ink-400">{facets.onSaleCount}</span>
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[0.9375rem] text-ink-700 hover:bg-ink-50">
          <input type="checkbox" checked={nav.searchParams.get('stock') === '1'} onChange={(e) => nav.setParam('stock', e.target.checked ? '1' : null)} className="h-[1.125rem] w-[1.125rem] cursor-pointer accent-ink-900" />
          <span className="flex-1">Μόνο διαθέσιμα</span>
          <span className="tabular text-xs text-ink-400">{facets.inStockCount}</span>
        </label>
      </div>
    </div>
  );
}

/** Both bounds are committed in ONE navigation (two router.push calls would race each other). */
function PriceForm({ initialMin, initialMax, placeholderMin, placeholderMax }: { initialMin: string; initialMax: string; placeholderMin: number; placeholderMax: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The parent remounts this form (via `key`) whenever the URL's bounds change, so plain initial state is enough.
  const [min, setMin] = useState(initialMin);
  const [max, setMax] = useState(initialMax);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of [['min', min], ['max', max]] as const) {
      if (v.trim()) params.set(k, v.trim());
      else params.delete(k);
    }
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <form onSubmit={submit} className="clear-both flex items-center gap-2">
      <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder={String(placeholderMin)} aria-label="Ελάχιστη τιμή" className="field h-10 min-w-0 px-3" />
      <span className="text-ink-400">–</span>
      <input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder={String(placeholderMax)} aria-label="Μέγιστη τιμή" className="field h-10 min-w-0 px-3" />
      <button type="submit" className="h-10 shrink-0 cursor-pointer rounded-xl bg-ink-900 px-3.5 text-sm font-semibold text-white hover:bg-ink-700">OK</button>
    </form>
  );
}

export function SortSelect({ sortLabels }: { sortLabels: Record<SortKey, string> }) {
  const nav = useListingNav();
  return (
    <label className="flex items-center gap-2 text-sm text-ink-600">
      <span className="hidden sm:inline">Ταξινόμηση</span>
      <select
        value={nav.searchParams.get('sort') ?? 'featured'}
        onChange={(e) => nav.setParam('sort', e.target.value === 'featured' ? null : e.target.value)}
        className="field h-10 w-auto max-w-[40vw] cursor-pointer truncate py-0 pr-8 pl-3 text-sm font-medium sm:max-w-none"
      >
        {(Object.keys(sortLabels) as SortKey[]).map((k) => (
          <option key={k} value={k}>{sortLabels[k]}</option>
        ))}
      </select>
    </label>
  );
}

function ClearFilters({ activeCount }: { activeCount: number }) {
  const nav = useListingNav();
  if (activeCount === 0) return null;
  return (
    <button type="button" onClick={nav.clearAll} className="cursor-pointer text-sm font-semibold text-petrol-500 hover:text-petrol-700">
      Καθαρισμός ({activeCount})
    </button>
  );
}

/** Desktop: sticky sidebar. Filter state lives in the URL, so this and <MobileFilters> never disagree. */
export function FilterSidebar({ facets, activeCount, ...hidden }: Omit<Props, 'total'>) {
  return (
    <aside className="hidden w-72 shrink-0 lg:block" aria-label="Φίλτρα">
      <div className="sticky top-44 max-h-[calc(100dvh-12rem)] overflow-y-auto rounded-2xl border border-line bg-white p-5 shadow-tile">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-xl">Φίλτρα</h2>
          <ClearFilters activeCount={activeCount} />
        </div>
        <Facets facets={facets} {...hidden} />
      </div>
    </aside>
  );
}

/** Phones / tablets: a toolbar button that opens a bottom sheet. */
export function MobileFilters({ facets, total, activeCount, ...hidden }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 lg:hidden">
        <SlidersHorizontal className="h-4 w-4" />
        Φίλτρα
        {activeCount > 0 && <span className="tabular flex h-5 min-w-5 items-center justify-center rounded-full bg-oil-500 px-1 text-xs font-bold text-ink-950">{activeCount}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Φίλτρα">
          <button type="button" aria-label="Κλείσιμο φίλτρων" onClick={() => setOpen(false)} className="animate-fade-in absolute inset-0 h-full w-full cursor-default bg-ink-950/55" />
          <div className="animate-slide-up absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-3xl bg-white">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
              <h2 className="display text-xl">Φίλτρα</h2>
              <div className="flex items-center gap-3">
                <ClearFilters activeCount={activeCount} />
                <button type="button" onClick={() => setOpen(false)} aria-label="Κλείσιμο" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-ink-600 hover:bg-ink-100">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <Facets facets={facets} {...hidden} />
            </div>
            <div className="safe-bottom shrink-0 border-t border-line p-4">
              <button type="button" onClick={() => setOpen(false)} className="h-12 w-full cursor-pointer rounded-xl bg-oil-500 font-semibold text-ink-950">
                Εμφάνιση {total} προϊόντων
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
