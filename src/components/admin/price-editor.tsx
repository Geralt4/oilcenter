'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, LoaderCircle, Percent, RotateCcw, Save, Search, Undo2, X } from 'lucide-react';
import { updatePrices, type PriceUpdate } from '@/app/admin/actions';
import { buttonClass } from '@/components/ui/button';
import { AVAILABILITY, AVAILABILITY_SHORT, type Availability } from '@/lib/availability';
import { centsToInput, cn, formatPrice, normalizeText, parsePriceToCents } from '@/lib/utils';

export type PriceRow = {
  id: number;
  productId: number;
  brand: string | null;
  product: string;
  label: string;
  sku: string;
  priceCents: number;
  verified: boolean;
  availability: Availability;
  /** last logged change, if any */
  previousCents: number | null;
  changedAt: number | null;
};

type Rounding = 'none' | '10' | '50' | '90';
type Notice = { ok: boolean; text: string; undo?: PriceUpdate[] } | null;

/** A change this large is more often a typo (4,29 for 42,90) than a real price move: ask before saving. */
const SUSPICIOUS_RATIO = 0.35;

const shortDate = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'numeric', timeZone: 'Europe/Athens' });

function percentDiff(from: number, to: number): string {
  const pct = ((to - from) / from) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0).replace('.', ',')}%`;
}

/** `cents` is the exact (fractional) result of the percentage: round once, straight to the target step. */
function applyRounding(cents: number, rounding: Rounding): number {
  if (rounding === '10') return Math.max(10, Math.round(cents / 10) * 10);
  if (rounding === '50') return Math.max(50, Math.round(cents / 50) * 50);
  if (rounding === '90') return Math.max(90, Math.round((cents - 90) / 100) * 100 + 90);
  return Math.max(1, Math.round(cents));
}

/** Searchable text of a row. "5W-40" must also be found by typing "5w40". */
function haystack(r: PriceRow): string {
  const text = normalizeText(`${r.brand ?? ''} ${r.product} ${r.label} ${r.sku}`);
  const compact = [...text.matchAll(/\b(\d{1,2}w) (\d{2})\b/g)].map((m) => m[1] + m[2]).join(' ');
  return ` ${text} ${compact}`;
}

function matches(hay: string, tokens: string[]): boolean {
  // a token with a digit must start a word, otherwise "5w40" would also list every 15W-40
  return tokens.every((t) => hay.includes(/\d/.test(t) ? ` ${t}` : t));
}

type LineProps = {
  row: PriceRow;
  draft: string | undefined;
  verifiedDraft: boolean | undefined;
  availabilityDraft: Availability | undefined;
  failed: boolean;
  justSaved: boolean;
  onDraft: (id: number, value: string) => void;
  onVerify: (id: number, value: boolean) => void;
  onAvailability: (id: number, value: Availability) => void;
  onEnter: () => void;
};

/** A size that is not simply "on the shelf" should catch the eye while scrolling the list. */
const AVAILABILITY_FIELD: Record<Availability, string> = {
  in_stock: 'text-ink-600',
  days_1_3: 'border-petrol-500/50 bg-petrol-50 font-medium text-petrol-700',
  on_order: 'border-amber-400 bg-amber-50 font-medium text-amber-900',
  unavailable: 'border-red-300 bg-red-50 font-medium text-red-800',
};

const PriceLine = memo(function PriceLine({ row, draft, verifiedDraft, availabilityDraft, failed, justSaved, onDraft, onVerify, onAvailability, onEnter }: LineProps) {
  const value = draft ?? centsToInput(row.priceCents);
  const cents = parsePriceToCents(value);
  const invalid = draft !== undefined && (cents === null || cents <= 0);
  const changed = !invalid && cents !== null && cents !== row.priceCents;
  const verified = changed ? true : (verifiedDraft ?? row.verified);
  const availability = availabilityDraft ?? row.availability;
  const availabilityChanged = availability !== row.availability;

  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:flex-nowrap', (changed || availabilityChanged) && 'bg-oil-50', (invalid || failed) && 'bg-red-50')}>
      <span className="w-14 shrink-0 text-[0.9375rem] font-semibold text-ink-900 tabular">{row.label}</span>
      <span className="hidden w-44 shrink-0 truncate text-xs text-ink-500 tabular lg:block" title={row.sku}>{row.sku}</span>

      <label className="relative ml-auto shrink-0 sm:ml-0">
        <span className="sr-only">Τιμή {row.product} {row.label} σε ευρώ, με ΦΠΑ</span>
        <input
          data-price-input
          value={value}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => onDraft(row.id, e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const all = [...document.querySelectorAll<HTMLInputElement>('[data-price-input]')];
              all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
            }
          }}
          aria-invalid={invalid || failed}
          className={cn(
            'field tabular h-11 w-32 pr-8 text-right text-base font-semibold',
            changed && 'border-oil-500 bg-white ring-2 ring-oil-200',
            (invalid || failed) && 'border-red-400 ring-2 ring-red-100',
          )}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-500">€</span>
      </label>

      <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto sm:flex-1">
        <select
          value={availability}
          onChange={(e) => onAvailability(row.id, e.target.value as Availability)}
          aria-label={`Διαθεσιμότητα ${row.product} ${row.label}`}
          className={cn('field h-9 w-[10.5rem] shrink-0 cursor-pointer py-0 pr-7 text-sm', AVAILABILITY_FIELD[availability], availabilityChanged && 'border-oil-500 ring-2 ring-oil-200')}
        >
          {AVAILABILITY.map((a) => <option key={a} value={a}>{AVAILABILITY_SHORT[a]}</option>)}
        </select>
      <span className="min-w-0 flex-1 text-right text-xs sm:text-left">
        {invalid || failed ? (
          <span className="font-medium text-red-700">Μη έγκυρη τιμή — γράψτε π.χ. 12,90</span>
        ) : changed ? (
          <span className="font-medium text-ink-700">
            ήταν {formatPrice(row.priceCents)} <span className={cn('tabular', cents! > row.priceCents ? 'text-red-700' : 'text-emerald-700')}>({percentDiff(row.priceCents, cents!)})</span>
          </span>
        ) : justSaved ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Αποθηκεύτηκε</span>
        ) : !verified ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">ενδεικτική</span>
            <button type="button" onClick={() => onVerify(row.id, true)} className="cursor-pointer font-medium text-ink-600 underline underline-offset-2 hover:text-ink-950">είναι σωστή</button>
          </span>
        ) : verifiedDraft === true && !row.verified ? (
          <span className="inline-flex items-center gap-2 font-medium text-ink-700">
            θα σημειωθεί ως σωστή
            <button type="button" onClick={() => onVerify(row.id, false)} aria-label="Αναίρεση" className="cursor-pointer text-ink-500 hover:text-ink-900"><X className="h-3.5 w-3.5" /></button>
          </span>
        ) : row.changedAt && row.previousCents !== null ? (
          <span className="text-ink-500">άλλαξε {shortDate.format(row.changedAt)} · ήταν {formatPrice(row.previousCents)}</span>
        ) : null}
      </span>
      </div>
    </li>
  );
});

type Props = { rows: PriceRow[]; initialQuery?: string; initialBrand?: string; initialOnlyUnverified?: boolean; initialOnlyWaiting?: boolean };
type Override = Partial<Pick<PriceRow, 'priceCents' | 'verified' | 'availability' | 'previousCents' | 'changedAt'>>;

export function PriceEditor({ rows: serverRows, initialQuery = '', initialBrand = '', initialOnlyUnverified = false, initialOnlyWaiting = false }: Props) {
  // What the server confirmed on save. The page re-renders with the same values a moment later; until then these keep the boxes from flashing the old price.
  const [overrides, setOverrides] = useState<Record<number, Override>>({});
  const rows = useMemo(
    () =>
      serverRows.map((r) => {
        const o = overrides[r.id];
        if (!o) return r;
        // once the server row has caught up — or moved on, e.g. after a CSV import — it wins
        const caughtUp = o.changedAt != null ? (r.changedAt ?? 0) >= o.changedAt : r.verified === o.verified && (o.availability === undefined || r.availability === o.availability);
        return caughtUp ? r : { ...r, ...o };
      }),
    [serverRows, overrides],
  );

  const [query, setQuery] = useState(initialQuery);
  const [brand, setBrand] = useState(initialBrand);
  const [onlyUnverified, setOnlyUnverified] = useState(initialOnlyUnverified);
  const [onlyWaiting, setOnlyWaiting] = useState(initialOnlyWaiting);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [verifiedDrafts, setVerifiedDrafts] = useState<Record<number, boolean>>({});
  const [availabilityDrafts, setAvailabilityDrafts] = useState<Record<number, Availability>>({});
  const [failed, setFailed] = useState<number[]>([]);
  const [savedIds, setSavedIds] = useState<number[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [percent, setPercent] = useState('');
  const [rounding, setRounding] = useState<Rounding>('10');
  const [pending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const brands = useMemo(() => [...new Set(rows.flatMap((r) => (r.brand ? [r.brand] : [])))].sort((a, b) => a.localeCompare(b)), [rows]);
  const hays = useMemo(() => new Map(rows.map((r) => [r.id, haystack(r)])), [rows]);
  const unverifiedTotal = useMemo(() => rows.filter((r) => !r.verified).length, [rows]);
  const waitingTotal = useMemo(() => rows.filter((r) => r.availability !== 'in_stock').length, [rows]);

  /** What would be sent if the owner pressed save right now. */
  const updates = useMemo(() => {
    const out: PriceUpdate[] = [];
    const bad: number[] = [];
    for (const row of rows) {
      const draft = drafts[row.id];
      const cents = draft === undefined ? row.priceCents : parsePriceToCents(draft);
      const availability = availabilityDrafts[row.id] !== undefined && availabilityDrafts[row.id] !== row.availability ? availabilityDrafts[row.id] : undefined;
      if (draft !== undefined && (cents === null || cents <= 0)) bad.push(row.id);
      else if (cents !== row.priceCents) out.push({ id: row.id, price: draft!, availability });
      else if (verifiedDrafts[row.id] !== undefined && verifiedDrafts[row.id] !== row.verified) out.push({ id: row.id, price: centsToInput(row.priceCents), verified: verifiedDrafts[row.id], availability });
      else if (availability) out.push({ id: row.id, price: centsToInput(row.priceCents), availability });
    }
    return { out, bad };
  }, [rows, drafts, verifiedDrafts, availabilityDrafts]);
  const dirty = updates.out.length + updates.bad.length;

  const shown = useMemo(() => {
    const tokens = normalizeText(query).split(' ').filter(Boolean);
    const touched = (r: PriceRow) => drafts[r.id] !== undefined || availabilityDrafts[r.id] !== undefined;
    return rows.filter((r) => (!brand || r.brand === brand) && (!onlyUnverified || !r.verified || touched(r)) && (!onlyWaiting || r.availability !== 'in_stock' || touched(r)) && matches(hays.get(r.id)!, tokens));
    // rows being edited stay visible even if the filter would now hide them
  }, [rows, hays, query, brand, onlyUnverified, onlyWaiting, drafts, availabilityDrafts]);

  const groups = useMemo(() => {
    const out: Array<{ productId: number; brand: string | null; product: string; lines: PriceRow[] }> = [];
    for (const r of shown) {
      const last = out[out.length - 1];
      if (last && last.productId === r.productId) last.lines.push(r);
      else out.push({ productId: r.productId, brand: r.brand, product: r.product, lines: [r] });
    }
    return out;
  }, [shown]);

  const onDraft = useCallback((id: number, value: string) => {
    setDrafts((d) => ({ ...d, [id]: value }));
    setFailed((f) => (f.includes(id) ? f.filter((x) => x !== id) : f));
    setNotice(null);
  }, []);
  const onVerify = useCallback((id: number, value: boolean) => {
    setVerifiedDrafts((d) => ({ ...d, [id]: value }));
    setNotice(null);
  }, []);
  const onAvailability = useCallback((id: number, value: Availability) => {
    setAvailabilityDrafts((d) => ({ ...d, [id]: value }));
    setNotice(null);
  }, []);

  const send = useCallback(
    (payload: PriceUpdate[], isUndo: boolean) => {
      startTransition(async () => {
        try {
          const result = await updatePrices(payload);
          const done = new Set(result.saved.map((s) => s.id));
          setOverrides((o) => ({
            ...o,
            ...Object.fromEntries(result.saved.map((s) => [s.id, { ...o[s.id], priceCents: s.priceCents, verified: s.verified, availability: s.availability, ...(s.changedAt !== null ? { previousCents: s.previousCents, changedAt: s.changedAt } : {}) }])),
          }));
          setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !done.has(Number(id)))));
          setVerifiedDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !done.has(Number(id)))));
          setAvailabilityDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !done.has(Number(id)))) as Record<number, Availability>);
          setFailed(result.failed);
          setSavedIds([...done]);
          const undo = result.saved.flatMap((s) => (s.previousCents !== null ? [{ id: s.id, price: centsToInput(s.previousCents) }] : []));
          setNotice({ ok: result.ok, text: isUndo && result.ok ? 'Οι προηγούμενες τιμές επανήλθαν.' : result.message, undo: !isUndo && undo.length ? undo : undefined });
        } catch {
          setNotice({ ok: false, text: 'Η αποθήκευση απέτυχε. Ελέγξτε τη σύνδεσή σας και δοκιμάστε ξανά — οι αλλαγές σας είναι ακόμη εδώ.' });
        }
      });
    },
    [],
  );

  const save = useCallback(() => {
    if (pending) return;
    if (updates.bad.length) {
      setFailed(updates.bad);
      setNotice({ ok: false, text: updates.bad.length === 1 ? 'Μία τιμή δεν είναι έγκυρη (σημειωμένη με κόκκινο).' : `${updates.bad.length} τιμές δεν είναι έγκυρες (σημειωμένες με κόκκινο).` });
      return;
    }
    if (!updates.out.length) return;
    const suspicious = updates.out.flatMap((u) => {
      const row = byId.get(u.id)!;
      const cents = parsePriceToCents(u.price)!;
      return Math.abs(cents - row.priceCents) / row.priceCents >= SUSPICIOUS_RATIO ? [`• ${row.brand ?? ''} ${row.product} ${row.label}: ${formatPrice(row.priceCents)} → ${formatPrice(cents)} (${percentDiff(row.priceCents, cents)})`] : [];
    });
    if (suspicious.length && !window.confirm(`Μεγάλη αλλαγή τιμής — είναι σωστή;\n\n${suspicious.slice(0, 8).join('\n')}${suspicious.length > 8 ? `\n… και ${suspicious.length - 8} ακόμη` : ''}`)) return;
    send(updates.out, false);
  }, [pending, updates, byId, send]);

  // `save` changes identity on every keystroke; rows get a stable handler so that typing re-renders one row, not 215
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const onEnter = useCallback(() => saveRef.current(), []);

  const discard = () => {
    setDrafts({});
    setVerifiedDrafts({});
    setAvailabilityDrafts({});
    setFailed([]);
    setNotice(null);
  };

  const percentValue = Number(percent.replace(',', '.').replace('%', '').trim());
  const percentValid = percent.trim() !== '' && Number.isFinite(percentValue) && percentValue !== 0 && percentValue > -90 && percentValue <= 300;
  const applyPercent = () => {
    if (!percentValid) return;
    // always from the saved price, so pressing the button twice does not compound
    setDrafts((d) => ({ ...d, ...Object.fromEntries(shown.map((r) => [r.id, centsToInput(applyRounding(r.priceCents * (1 + percentValue / 100), rounding))])) }));
    setNotice(null);
  };

  // leaving with unsaved prices is the one way to lose work here
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const chip = (active: boolean) => cn('h-10 shrink-0 cursor-pointer rounded-full px-4 text-sm font-medium', active ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50');
  const scope = [brand, query.trim() && `«${query.trim()}»`, onlyUnverified && 'ενδεικτικές', onlyWaiting && 'όχι άμεσα διαθέσιμα'].filter(Boolean).join(' · ') || 'όλο τον κατάλογο';

  return (
    <div>
      {/* Only the search box stays pinned (a phone has no room for more). Below lg the admin header bar, 4.375rem tall, is itself sticky. */}
      <div className="sticky top-[4.375rem] z-10 -mx-4 border-b border-line bg-ink-50/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:top-0">
        <label className="relative block">
          <span className="sr-only">Αναζήτηση προϊόντος</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                document.querySelector<HTMLInputElement>('[data-price-input]')?.focus();
              }
            }}
            placeholder="Γράψτε προϊόν, μάρκα ή κωδικό — π.χ. motul 5w40"
            autoFocus
            className="field h-11 w-full pl-10 text-base"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Μάρκα" className="field h-10 w-auto max-w-[11rem] cursor-pointer py-0 text-sm">
          <option value="">Όλες οι μάρκες</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        {unverifiedTotal > 0 && (
          <button type="button" onClick={() => setOnlyUnverified((v) => !v)} aria-pressed={onlyUnverified} className={chip(onlyUnverified)}>Ενδεικτικές ({unverifiedTotal})</button>
        )}
        {(waitingTotal > 0 || onlyWaiting) && (
          <button type="button" onClick={() => setOnlyWaiting((v) => !v)} aria-pressed={onlyWaiting} className={chip(onlyWaiting)}>Όχι άμεσα διαθέσιμα ({waitingTotal})</button>
        )}
      </div>

      <details className="group mt-4 rounded-2xl border border-line bg-white shadow-tile">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-semibold text-ink-900 [&::-webkit-details-marker]:hidden">
          <Percent className="h-4 w-4 text-oil-600" />
          Αύξηση ή μείωση με ποσοστό
          <span className="ml-auto text-xs font-normal text-ink-500 group-open:hidden">π.χ. +3% σε όλα τα Motul</span>
        </summary>
        <div className="border-t border-line px-4 py-4">
          <p className="text-sm text-ink-600">
            Εφαρμόζεται στις τιμές που εμφανίζονται τώρα από κάτω ({scope}). Οι νέες τιμές γράφονται στα κουτάκια για να τις δείτε — <strong>δεν αλλάζει τίποτα στο κατάστημα μέχρι να πατήσετε «Αποθήκευση»</strong>.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">Ποσοστό %</span>
              <input value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" placeholder="+3 ή -2,5" className="field tabular h-11 w-32 text-base" />
            </label>
            <label className="block">
              <span className="label">Στρογγυλοποίηση</span>
              <select value={rounding} onChange={(e) => setRounding(e.target.value as Rounding)} className="field h-11 w-auto cursor-pointer py-0 text-sm">
                <option value="none">Καμία (ακριβές λεπτό)</option>
                <option value="10">Στα 10 λεπτά — 12,40</option>
                <option value="50">Στα 50 λεπτά — 12,50</option>
                <option value="90">Να τελειώνει σε ,90 — 12,90</option>
              </select>
            </label>
            <button type="button" onClick={applyPercent} disabled={!percentValid || shown.length === 0} className={buttonClass({ variant: 'dark' })}>
              Υπολογισμός σε {shown.length} {shown.length === 1 ? 'τιμή' : 'τιμές'}
            </button>
          </div>
        </div>
      </details>

      <p className="mt-4 mb-2 text-xs text-ink-500" aria-live="polite">
        {shown.length === rows.length ? `${rows.length} τιμές` : `${shown.length} από ${rows.length} τιμές`} · τιμές λιανικής με ΦΠΑ · Enter = αποθήκευση · ↑ ↓ = επόμενη τιμή · η διαθεσιμότητα αποθηκεύεται μαζί με τις τιμές
      </p>

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
          Δεν βρέθηκε προϊόν.{' '}
          <button type="button" onClick={() => { setQuery(''); setBrand(''); setOnlyUnverified(false); setOnlyWaiting(false); searchRef.current?.focus(); }} className="cursor-pointer font-medium text-ink-900 underline underline-offset-2">Καθαρισμός φίλτρων</button>
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.productId} className="overflow-hidden rounded-2xl border border-line bg-white shadow-tile md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <Link href={`/admin/products/${g.productId}`} className="block border-b border-line bg-ink-50/60 px-4 py-2.5 hover:bg-ink-100 md:border-r md:border-b-0 md:py-3.5" title="Άνοιγμα προϊόντος">
                <span className="block text-[0.6875rem] font-semibold tracking-wide text-ink-500 uppercase">{g.brand ?? '—'}</span>
                <span className="block font-medium text-ink-900">{g.product}</span>
              </Link>
              <ul className="divide-y divide-line">
                {g.lines.map((r) => (
                  <PriceLine key={r.id} row={r} draft={drafts[r.id]} verifiedDraft={verifiedDrafts[r.id]} availabilityDraft={availabilityDrafts[r.id]} failed={failed.includes(r.id)} justSaved={savedIds.includes(r.id)} onDraft={onDraft} onVerify={onVerify} onAvailability={onAvailability} onEnter={onEnter} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {(dirty > 0 || notice) && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            {dirty > 0 && (
              <div className="flex items-center gap-2">
                <button type="button" onClick={save} disabled={pending} className={buttonClass({ size: 'lg', className: 'min-w-0 flex-1 sm:flex-none' })}>
                  {pending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                  Αποθήκευση {dirty === 1 ? '1 αλλαγής' : `${dirty} αλλαγών`}
                </button>
                {/* icon-only on a phone, where the two labels do not fit on one row */}
                <button type="button" onClick={discard} disabled={pending} aria-label="Ακύρωση αλλαγών" className={buttonClass({ variant: 'outline', size: 'lg', className: 'shrink-0 px-4' })}>
                  <RotateCcw className="h-4 w-4" />
                  <span className="hidden sm:inline">Ακύρωση</span>
                </button>
              </div>
            )}
            {notice && (
              <p role={notice.ok ? 'status' : 'alert'} className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium', notice.ok ? 'text-emerald-700' : 'text-red-700')}>
                {notice.ok && <Check className="h-4 w-4 shrink-0" />}
                {notice.text}
                {notice.undo && dirty === 0 && (
                  <button type="button" onClick={() => send(notice.undo!, true)} disabled={pending} className="inline-flex cursor-pointer items-center gap-1 text-ink-600 underline underline-offset-2 hover:text-ink-950">
                    <Undo2 className="h-3.5 w-3.5" />
                    Αναίρεση
                  </button>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
