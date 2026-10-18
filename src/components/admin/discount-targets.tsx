'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchAdminProducts } from '@/app/admin/actions';

export type TargetOption = { id: number; name: string; depth?: number };

type Props = {
  brands: TargetOption[];
  categories: TargetOption[];
  /** the products already chosen, so a form carries only those and never the catalogue */
  products: TargetOption[];
  brandIds: number[];
  categoryIds: number[];
};

/**
 * «Ισχύει για»: products, brands and categories a coupon or a sale is limited to. Nothing chosen = everything.
 * Brands and categories post as repeated checkbox values; products as hidden inputs behind the chips.
 */
export function DiscountTargets({ brands, categories, products, brandIds, categoryIds }: Props) {
  const [chosen, setChosen] = useState<TargetOption[]>(products);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TargetOption[]>([]);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const box = useRef<HTMLFieldSetElement>(null);

  // the «new» form resets itself after saving: native inputs follow, the chips are state and must be told
  useEffect(() => {
    const form = box.current?.closest('form');
    const onReset = () => {
      setChosen(products);
      setQuery('');
    };
    form?.addEventListener('reset', onReset);
    return () => form?.removeEventListener('reset', onReset);
  }, [products]);

  useEffect(() => {
    const q = query.trim();
    const ticket = ++latest.current;
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the list is the response to a cleared box
      setHits([]);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      searchAdminProducts(q)
        .then((rows) => ticket === latest.current && setHits(rows))
        .catch(() => ticket === latest.current && setHits([]))
        .finally(() => ticket === latest.current && setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const add = (p: TargetOption) => setChosen((c) => (c.some((x) => x.id === p.id) ? c : [...c, p]));
  const available = hits.filter((h) => !chosen.some((c) => c.id === h.id));

  return (
    <fieldset ref={box} className="space-y-4 rounded-xl border border-line p-4">
      <legend className="label px-1">Ισχύει για</legend>
      <p className="text-xs text-ink-500">Αν δεν επιλέξετε τίποτα, ισχύει για όλα τα προϊόντα. Μια κατηγορία καλύπτει και τις υποκατηγορίες της, και τα νέα προϊόντα της μάρκας ή της κατηγορίας μπαίνουν αυτόματα.</p>

      <div>
        <p className="label">Προϊόντα</p>
        {chosen.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {chosen.map((p) => (
              <li key={p.id} className="flex items-center gap-1 rounded-full bg-ink-100 py-1 pr-1 pl-3 text-sm text-ink-800">
                <input type="hidden" name="productIds" value={p.id} />
                {p.name}
                <button type="button" aria-label={`Αφαίρεση: ${p.name}`} onClick={() => setChosen((c) => c.filter((x) => x.id !== p.id))} className="cursor-pointer rounded-full p-1 hover:bg-ink-200"><X className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            placeholder="Αναζήτηση προϊόντος για προσθήκη…"
            className="field pl-9"
          />
        </div>
        {query.trim().length >= 2 && (
          <ul className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-white">
            {available.map((p) => (
              <li key={p.id}><button type="button" onClick={() => add(p)} className="block w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-ink-50">{p.name}</button></li>
            ))}
            {!busy && available.length === 0 && <li className="px-3 py-2 text-sm text-ink-500">Κανένα αποτέλεσμα.</li>}
            {hits.length >= 50 && <li className="px-3 py-2 text-xs text-ink-500">Περιορίστε την αναζήτηση για να δείτε περισσότερα.</li>}
          </ul>
        )}
      </div>

      <div>
        <p className="label">Μάρκες</p>
        <div className="grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-2 text-sm text-ink-800">
              <input type="checkbox" name="brandIds" value={b.id} defaultChecked={brandIds.includes(b.id)} className="h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
              {b.name}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="label">Κατηγορίες</p>
        <div className="grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.id} style={{ paddingLeft: `${(c.depth ?? 0) * 1.25}rem` }} className="flex cursor-pointer items-center gap-2 text-sm text-ink-800">
              <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={categoryIds.includes(c.id)} className="h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
              {c.name}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
