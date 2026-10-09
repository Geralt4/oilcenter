'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, LoaderCircle, RotateCcw, Save, Search, X } from 'lucide-react';
import { updateCodes, type CodeUpdate } from '@/app/admin/actions';
import { buttonClass } from '@/components/ui/button';
import { isValidGtin, normalizeGtin } from '@/lib/gtin';
import { cn, normalizeText } from '@/lib/utils';

export type CodeRow = {
  id: number;
  productId: number;
  brand: string | null;
  product: string;
  label: string;
  sku: string;
  barcode: string;
  mpn: string;
  /** false = this size is not in the feed right now (no confirmed price, inactive…) */
  inFeed: boolean;
};

type Draft = { barcode?: string; mpn?: string };
type Problem = 'invalid' | 'duplicate';
type Notice = { ok: boolean; text: string } | null;

const PROBLEM_TEXT: Record<Problem, string> = {
  invalid: 'Μη έγκυρο barcode — λείπει ή είναι λάθος κάποιο ψηφίο',
  duplicate: 'Το ίδιο barcode υπάρχει ήδη σε άλλη συσκευασία',
};

/** "5W-40" must also be found by typing "5w40" (same rule as the price editor). */
function haystack(r: CodeRow): string {
  const text = normalizeText(`${r.brand ?? ''} ${r.product} ${r.label} ${r.sku} ${r.barcode} ${r.mpn}`);
  const compact = [...text.matchAll(/\b(\d{1,2}w) (\d{2})\b/g)].map((m) => m[1] + m[2]).join(' ');
  return ` ${text} ${compact}`;
}

type LineProps = {
  row: CodeRow;
  draft: Draft | undefined;
  /** refused on save, or visibly wrong already (a full-length code with a bad check digit, a code another size has) */
  problem: Problem | undefined;
  justSaved: boolean;
  onDraft: (id: number, change: Draft) => void;
  onEnter: (input: HTMLInputElement) => void;
};

const CodeLine = memo(function CodeLine({ row, draft, problem, justSaved, onDraft, onEnter }: LineProps) {
  const barcode = draft?.barcode ?? row.barcode;
  const mpn = draft?.mpn ?? row.mpn;
  const changed = normalizeGtin(barcode) !== row.barcode || mpn.trim() !== row.mpn;
  const bad = problem;

  const keys = (column: 'barcode' | 'mpn') => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // a barcode scanner "types" the digits and then presses Enter: save, and stand ready on the next size
      e.preventDefault();
      onEnter(e.currentTarget);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...document.querySelectorAll<HTMLInputElement>(`[data-code-input="${column}"]`)];
      all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  };

  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:flex-nowrap', changed && !bad && 'bg-oil-50', bad && 'bg-red-50')}>
      <span className="w-14 shrink-0 text-[0.9375rem] font-semibold text-ink-900 tabular">{row.label}</span>
      <label className="shrink-0">
        <span className="sr-only">Barcode {row.product} {row.label}</span>
        <input
          data-code-input="barcode"
          data-row-id={row.id}
          value={barcode}
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="barcode (EAN)"
          onChange={(e) => onDraft(row.id, { barcode: e.target.value })}
          onFocus={(e) => e.target.select()}
          onKeyDown={keys('barcode')}
          aria-invalid={Boolean(bad)}
          className={cn('field tabular h-11 w-44 text-base', changed && !bad && 'border-oil-500 bg-white ring-2 ring-oil-200', bad && 'border-red-400 ring-2 ring-red-100')}
        />
      </label>
      <label className="shrink-0">
        <span className="sr-only">Κωδικός κατασκευαστή {row.product} {row.label}</span>
        <input
          data-code-input="mpn"
          data-row-id={row.id}
          value={mpn}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="κωδ. κατασκευαστή"
          onChange={(e) => onDraft(row.id, { mpn: e.target.value })}
          onFocus={(e) => e.target.select()}
          onKeyDown={keys('mpn')}
          className={cn('field tabular h-11 w-40 text-base', changed && !bad && 'border-oil-500 bg-white ring-2 ring-oil-200')}
        />
      </label>
      <span className="min-w-0 basis-full text-xs sm:basis-auto sm:flex-1">
        {bad ? (
          <span className="font-medium text-red-700">{PROBLEM_TEXT[bad]}</span>
        ) : justSaved && !changed ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Αποθηκεύτηκε</span>
        ) : !row.inFeed ? (
          <span className="text-ink-500">εκτός αρχείου προς το παρόν</span>
        ) : null}
      </span>
    </li>
  );
});

export function CodesEditor({ rows: serverRows }: { rows: CodeRow[] }) {
  // What the server confirmed on save; the page re-renders with the same values a moment later (same idea as the price editor).
  const [overrides, setOverrides] = useState<Record<number, { barcode: string; mpn: string }>>({});
  const rows = useMemo(() => serverRows.map((r) => (overrides[r.id] && (overrides[r.id].barcode !== r.barcode || overrides[r.id].mpn !== r.mpn) ? { ...r, ...overrides[r.id] } : r)), [serverRows, overrides]);

  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [problems, setProblems] = useState<Record<number, Problem>>({});
  const [savedIds, setSavedIds] = useState<number[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();

  const hays = useMemo(() => new Map(rows.map((r) => [r.id, haystack(r)])), [rows]);
  const missingTotal = useMemo(() => rows.filter((r) => !r.barcode || !r.mpn).length, [rows]);

  /** What would be sent if the owner pressed save right now. */
  const updates = useMemo(() => {
    const out: CodeUpdate[] = [];
    const bad: Record<number, Problem> = {};
    const taken = new Map(rows.flatMap((r) => (r.barcode ? [[r.barcode, r.id] as const] : [])));
    for (const row of rows) {
      const draft = drafts[row.id];
      if (!draft) continue;
      const barcode = normalizeGtin(draft.barcode ?? row.barcode);
      const mpn = (draft.mpn ?? row.mpn).trim();
      if (barcode === row.barcode && mpn === row.mpn) continue;
      if (barcode && !isValidGtin(barcode)) bad[row.id] = 'invalid';
      else if (barcode && taken.has(barcode) && taken.get(barcode) !== row.id) bad[row.id] = 'duplicate';
      else {
        out.push({ id: row.id, barcode, mpn });
        if (barcode) taken.set(barcode, row.id);
      }
    }
    return { out, bad };
  }, [rows, drafts]);
  const dirty = updates.out.length + Object.keys(updates.bad).length;

  /** Shown while typing. A half-typed barcode is not an error yet: only a full-length one with a wrong check digit is. */
  const liveProblem = (row: CodeRow): Problem | undefined => {
    const bad = updates.bad[row.id];
    if (bad !== 'invalid') return bad;
    const code = normalizeGtin(drafts[row.id]?.barcode ?? '');
    return /\D/.test(code) || code.length >= 13 ? 'invalid' : undefined;
  };

  const shown = useMemo(() => {
    const tokens = normalizeText(query).split(' ').filter(Boolean);
    // rows being edited stay visible even if the filter would now hide them
    return rows.filter((r) => (!onlyMissing || !r.barcode || !r.mpn || drafts[r.id] !== undefined || savedIds.includes(r.id)) && tokens.every((t) => hays.get(r.id)!.includes(/\d/.test(t) ? ` ${t}` : t)));
  }, [rows, hays, query, onlyMissing, drafts, savedIds]);

  const groups = useMemo(() => {
    const out: Array<{ productId: number; brand: string | null; product: string; lines: CodeRow[] }> = [];
    for (const r of shown) {
      const last = out[out.length - 1];
      if (last && last.productId === r.productId) last.lines.push(r);
      else out.push({ productId: r.productId, brand: r.brand, product: r.product, lines: [r] });
    }
    return out;
  }, [shown]);

  const onDraft = useCallback((id: number, change: Draft) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...change } }));
    setProblems((p) => {
      if (!(id in p)) return p;
      const { [id]: _gone, ...rest } = p;
      return rest;
    });
    setNotice(null);
  }, []);

  const save = useCallback(() => {
    if (pending) return;
    setProblems(updates.bad);
    if (!updates.out.length) {
      if (Object.keys(updates.bad).length) setNotice({ ok: false, text: 'Διορθώστε τα barcodes που είναι σημειωμένα με κόκκινο.' });
      return;
    }
    const payload = updates.out;
    startTransition(async () => {
      try {
        const result = await updateCodes(payload);
        const done = new Set(result.saved.map((s) => s.id));
        setOverrides((o) => ({ ...o, ...Object.fromEntries(result.saved.map((s) => [s.id, { barcode: s.barcode, mpn: s.mpn }])) }));
        setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !done.has(Number(id)))));
        setProblems((p) => ({ ...p, ...Object.fromEntries(result.failed.map((f) => [f.id, f.reason])) }));
        setSavedIds((ids) => [...new Set([...ids, ...done])]);
        setNotice({ ok: result.ok, text: result.message });
      } catch {
        setNotice({ ok: false, text: 'Η αποθήκευση απέτυχε. Ελέγξτε τη σύνδεσή σας και δοκιμάστε ξανά — όσα γράψατε είναι ακόμη εδώ.' });
      }
    });
  }, [pending, updates]);

  // `save` changes identity on every keystroke; rows get a stable handler so that typing re-renders one row, not all of them
  const saveRef = useRef(save);
  const badRef = useRef(updates.bad);
  useEffect(() => {
    saveRef.current = save;
    badRef.current = updates.bad;
  }, [save, updates.bad]);
  const onEnter = useCallback((input: HTMLInputElement) => {
    saveRef.current();
    if (badRef.current[Number(input.dataset.rowId)]) return; // stay on a barcode that was refused
    const all = [...document.querySelectorAll<HTMLInputElement>(`[data-code-input="${input.dataset.codeInput}"]`)];
    all[all.indexOf(input) + 1]?.focus();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">Αναζήτηση προϊόντος</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} type="search" placeholder="Αναζήτηση: μάρκα, προϊόν, 5w40, barcode…" autoComplete="off" className="field h-11 pl-10" />
        </label>
        <button type="button" onClick={() => setOnlyMissing((v) => !v)} aria-pressed={onlyMissing} className={cn('flex h-11 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold', onlyMissing ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50')}>
          Μόνο όσα λείπουν <span className={cn('tabular rounded-full px-1.5 text-xs', onlyMissing ? 'bg-white/20' : 'bg-ink-100')}>{missingTotal}</span>
        </button>
      </div>

      {notice && (
        <p role="status" className={cn('mt-3 flex items-start justify-between gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium', notice.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800')}>
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Κλείσιμο" className="cursor-pointer opacity-60 hover:opacity-100"><X className="h-4 w-4" /></button>
        </p>
      )}

      <div className="mt-3 max-h-[34rem] overflow-y-auto rounded-xl border border-line">
        {groups.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-500">{onlyMissing && !query ? 'Όλες οι συσκευασίες έχουν barcode και κωδικό κατασκευαστή.' : 'Δεν βρέθηκε προϊόν.'}</p>
        ) : (
          groups.map((g) => (
            <section key={g.productId} className="border-b border-line last:border-b-0">
              <h3 className="flex items-baseline justify-between gap-3 bg-ink-50 px-4 py-1.5 text-sm">
                <span className="min-w-0 truncate"><span className="font-semibold text-ink-950">{g.brand}</span> <span className="text-ink-800">{g.product}</span></span>
                <Link href={`/admin/products/${g.productId}`} className="shrink-0 text-xs font-medium text-ink-500 underline underline-offset-2 hover:text-ink-900">καρτέλα</Link>
              </h3>
              <ul className="divide-y divide-line">
                {g.lines.map((row) => (
                  <CodeLine key={row.id} row={row} draft={drafts[row.id]} problem={problems[row.id] ?? liveProblem(row)} justSaved={savedIds.includes(row.id)} onDraft={onDraft} onEnter={onEnter} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-500">Με σαρωτή barcode: πατήστε στο πρώτο κουτάκι και σαρώστε — κάθε σάρωση αποθηκεύεται και προχωρά στην επόμενη συσκευασία. Με το χέρι: Enter αποθηκεύει, ↑ ↓ αλλάζουν γραμμή.</p>
        <div className="flex items-center gap-2">
          {dirty > 0 && (
            <button type="button" onClick={() => { setDrafts({}); setProblems({}); setNotice(null); }} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
              <RotateCcw className="h-4 w-4" />Αναίρεση
            </button>
          )}
          <button type="button" onClick={save} disabled={pending || dirty === 0} className={buttonClass({ variant: 'primary', size: 'sm' })}>
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {dirty > 0 ? `Αποθήκευση (${dirty})` : 'Αποθήκευση'}
          </button>
        </div>
      </div>
    </div>
  );
}
