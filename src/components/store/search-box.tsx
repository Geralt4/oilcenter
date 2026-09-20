'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Search, X } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';

type Suggestion = {
  slug: string;
  name: string;
  brandName: string | null;
  imageUrl: string | null;
  minPriceCents: number;
  multiplePrices: boolean;
};

export function SearchBox({ autoFocus = false, onNavigate }: { autoFocus?: boolean; onNavigate?: () => void }) {
  const router = useRouter();
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);

  // Debounced suggestions; stale responses are dropped via AbortController.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return; // too short: the render below simply ignores stale items
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { items: Suggestion[] };
        setItems(data.items);
        setActive(-1);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    onNavigate?.();
    router.push(href);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (active >= 0 && items[active]) return go(`/product/${items[active].slug}`);
    if (q) go(`/products?q=${encodeURIComponent(q)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    }
  };

  const longEnough = query.trim().length >= 2;
  const showPanel = open && longEnough;
  const busy = loading && longEnough;

  return (
    <div ref={wrapRef} className="relative">
      <form role="search" onSubmit={submit} className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-[1.125rem] w-[1.125rem] -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          name="q"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setLoading(e.target.value.trim().length >= 2);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Αναζήτηση: 5W-30, Castrol Edge, αντιψυκτικό…"
          autoComplete="off"
          enterKeyHint="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Αναζήτηση προϊόντων"
          className="h-11 w-full rounded-xl border border-ink-200 bg-ink-50 pr-24 pl-11 text-ink-900 placeholder:text-ink-400 hover:border-ink-300 focus:border-oil-500 focus:bg-white focus:shadow-[0_0_0_3px_rgb(242_163_11/0.22)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          {busy && <LoaderCircle className="h-4 w-4 animate-spin text-ink-400" />}
          {query && !busy && (
            <button type="button" onClick={() => setQuery('')} aria-label="Καθαρισμός" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700">
              <X className="h-4 w-4" />
            </button>
          )}
          <button type="submit" className="h-8 rounded-lg bg-ink-900 px-3 text-sm font-semibold text-white hover:bg-ink-700">
            Εύρεση
          </button>
        </div>
      </form>

      {showPanel && (
        <div id={listId} role="listbox" className="animate-fade-in absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-2xl border border-line bg-white shadow-lift">
          {items.length > 0 ? (
            <>
              <ul className="max-h-[60vh] overflow-y-auto p-2">
                {items.map((item, i) => (
                  <li key={item.slug} role="option" aria-selected={i === active}>
                    <Link
                      href={`/product/${item.slug}`}
                      onClick={() => {
                        setOpen(false);
                        onNavigate?.();
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={cn('flex items-center gap-3 rounded-xl p-2', i === active ? 'bg-oil-50' : 'hover:bg-ink-50')}
                    >
                      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-line bg-white">
                        {item.imageUrl && <Image src={item.imageUrl} alt="" fill sizes="48px" className="object-contain p-1" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        {item.brandName && <span className="eyebrow block text-[0.6875rem] text-ink-400">{item.brandName}</span>}
                        <span className="block truncate text-sm font-semibold text-ink-900">{item.name}</span>
                      </span>
                      <span className="tabular shrink-0 text-sm font-bold text-ink-900">
                        {item.multiplePrices && <span className="mr-1 text-xs font-medium text-ink-400">από</span>}
                        {formatPrice(item.minPriceCents)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => go(`/products?q=${encodeURIComponent(query.trim())}`)}
                className="block w-full border-t border-line bg-ink-50 px-4 py-3 text-left text-sm font-semibold text-ink-800 hover:bg-ink-100"
              >
                Όλα τα αποτελέσματα για «{query.trim()}» →
              </button>
            </>
          ) : (
            !busy && (
              <p className="px-4 py-6 text-center text-sm text-ink-500">
                Δεν βρέθηκαν προϊόντα για «{query.trim()}». Δοκιμάστε ιξώδες (π.χ. 5W-40) ή μάρκα.
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
