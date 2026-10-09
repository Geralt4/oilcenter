import { isAvailability, type Availability } from '@/lib/availability';
import { parsePriceToCents } from '@/lib/utils';

/*
 * The price list as a spreadsheet: what Admin → Τιμές exports and what it reads back.
 * Pure (no database, no session) so that the round trip can be tested: a file exported and uploaded again
 * unchanged must change NOTHING — an empty cell means "leave it", never "zero".
 */

export const MAX_PRICE_CENTS = 5_000_000;
const BOM = 0xfeff;

export type CsvRow = { line: number; cells: string[] };

/**
 * Splits CSV text into rows of cells. The separator is `;` when the header line has one (what Greek Excel writes),
 * otherwise `,`. Honours "quoted cells", `""` inside them and line breaks inside quotes; blank lines are dropped.
 */
export function parseCsv(input: string): { sep: ';' | ','; header: string[]; rows: CsvRow[] } {
  const text = input.charCodeAt(0) === BOM ? input.slice(1) : input;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = firstLine.includes(';') ? ';' : ',';

  const all: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(cell.trim());
    if (cells.some((c) => c !== '')) all.push({ line: rowLine, cells });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === sep) {
      cells.push(cell.trim());
      cell = '';
    } else if (ch === '\n') {
      endRow();
      line++;
      rowLine = line;
    } else if (ch !== '\r') cell += ch;
  }
  endRow();

  const [head, ...rows] = all;
  return { sep, header: (head?.cells ?? []).map((h) => h.toLowerCase()), rows };
}

export type PriceCsvSource = { sku: string; brand: string | null; product: string; pack: string; priceCents: number; stock: number; trackStock: boolean; priceVerified: boolean; availability: Availability };

/** sku;brand;product;pack;price;stock;verified;availability — semicolon + BOM so Greek Excel opens it correctly on double-click. */
export function buildPriceCsv(rows: PriceCsvSource[]): string {
  const cell = (value: string | number | null) => {
    const s = String(value ?? '');
    // neutralise spreadsheet formula injection, then quote
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    ['sku', 'brand', 'product', 'pack', 'price', 'stock', 'verified', 'availability'].join(';'),
    ...rows.map((v) => [v.sku, v.brand, v.product, v.pack, (v.priceCents / 100).toFixed(2).replace('.', ','), v.trackStock ? v.stock : '', v.priceVerified ? 'yes' : 'no', v.availability].map(cell).join(';')),
  ];
  return String.fromCharCode(BOM) + lines.join('\r\n');
}

export type PriceCsvCurrent = { id: number; priceCents: number; priceVerified: boolean; stock: number; trackStock: boolean; availability: Availability };
export type PriceCsvPatch = { priceCents?: number; priceVerified?: boolean; stock?: number; trackStock?: boolean; availability?: Availability };
export type PriceCsvChange = { id: number; sku: string; patch: PriceCsvPatch; oldCents: number; newCents: number };
export type PriceCsvSkip = { line: number; sku: string; reason: string };
export type PriceCsvPlan = { error: string } | { error?: undefined; changes: PriceCsvChange[]; unchanged: number; skipped: PriceCsvSkip[]; unknown: string[] };

const YES = new Set(['yes', 'y', 'ναι', 'nai', 'true', '1', 'x']);

/**
 * What an uploaded price list would change, given what the shop holds now (`current`, by SKU).
 * - price: a new amount is saved and counts as confirmed (the owner typed it);
 * - verified: `yes` confirms a price that was not; nothing ever un-confirms one;
 * - stock: a whole number starts counting stock for that size; an EMPTY cell leaves it exactly as it is;
 * - availability: one of the exported keys; anything else leaves it as it is.
 * A row that would change nothing is not written at all.
 */
export function planPriceImport(input: string, current: Map<string, PriceCsvCurrent>): PriceCsvPlan {
  const { sep, header, rows } = parseCsv(input);
  const col = {
    sku: header.indexOf('sku'),
    price: header.findIndex((h) => h.startsWith('price') || h.startsWith('τιμ')),
    stock: header.findIndex((h) => h.startsWith('stock') || h.startsWith('απόθ') || h.startsWith('αποθ')),
    verified: header.findIndex((h) => h.startsWith('verif') || h.startsWith('επιβεβ')),
    availability: header.findIndex((h) => h.startsWith('availab') || h.startsWith('διαθεσ')),
  };
  if (col.sku < 0 || col.price < 0) return { error: 'Η πρώτη γραμμή πρέπει να έχει στήλες «sku» και «price».' };

  const state = new Map([...current].map(([sku, v]) => [sku, { ...v }]));
  const merged = new Map<number, PriceCsvChange>();
  const skipped: PriceCsvSkip[] = [];
  const unknown: string[] = [];
  let unchanged = 0;

  for (const { line, cells } of rows) {
    const at = (i: number) => (i >= 0 ? (cells[i] ?? '') : '');
    // the export puts an apostrophe in front of a cell that would read as a formula
    const rawSku = at(col.sku);
    const sku = state.has(rawSku) ? rawSku : state.has(rawSku.replace(/^'/, '')) ? rawSku.replace(/^'/, '') : state.has(rawSku.toUpperCase()) ? rawSku.toUpperCase() : rawSku;
    if (!sku) {
      skipped.push({ line, sku: '', reason: 'χωρίς κωδικό' });
      continue;
    }
    // «12,90» without quotes in a comma-separated file splits into two cells and shifts every column after it
    if (sep === ',' && cells.length > header.length) {
      skipped.push({ line, sku, reason: 'δεκαδικό κόμμα χωρίς εισαγωγικά' });
      continue;
    }
    const now = state.get(sku);
    if (!now) {
      unknown.push(sku);
      continue;
    }
    const cents = parsePriceToCents(at(col.price));
    if (cents === null || cents <= 0 || cents > MAX_PRICE_CENTS) {
      skipped.push({ line, sku, reason: 'μη έγκυρη τιμή' });
      continue;
    }
    const stockCell = at(col.stock);
    if (stockCell !== '' && !/^\d{1,7}$/.test(stockCell)) {
      skipped.push({ line, sku, reason: 'μη έγκυρο απόθεμα' });
      continue;
    }

    const patch: PriceCsvPatch = {};
    if (cents !== now.priceCents) Object.assign(patch, { priceCents: cents, priceVerified: true });
    else if (!now.priceVerified && YES.has(at(col.verified).toLowerCase())) patch.priceVerified = true;
    if (stockCell !== '') {
      const stock = Number(stockCell);
      if (!now.trackStock || stock !== now.stock) Object.assign(patch, { stock, trackStock: true });
    }
    const availability = at(col.availability).toLowerCase();
    if (isAvailability(availability) && availability !== now.availability) patch.availability = availability;

    if (Object.keys(patch).length === 0) {
      unchanged++;
      continue;
    }
    // a SKU listed twice: the later line wins, as one change against what the shop held before the upload
    const before = merged.get(now.id);
    merged.set(now.id, { id: now.id, sku, patch: { ...before?.patch, ...patch }, oldCents: before?.oldCents ?? now.priceCents, newCents: cents });
    Object.assign(now, patch);
  }
  return { changes: [...merged.values()], unchanged, skipped, unknown };
}

/** One line for the owner: what changed, what was left alone and why. */
export function describePriceImport(plan: Exclude<PriceCsvPlan, { error: string }>): string {
  const n = plan.changes.length;
  const parts = [n === 0 ? 'Καμία αλλαγή' : n === 1 ? 'Άλλαξε 1 συσκευασία' : `Άλλαξαν ${n} συσκευασίες`];
  if (plan.unchanged) parts.push(`${plan.unchanged} ίδιες με πριν`);
  let message = `${parts.join(' · ')}.`;
  if (plan.skipped.length) message += ` Δεν διαβάστηκαν ${plan.skipped.length}: ${plan.skipped.slice(0, 6).map((s) => `γραμμή ${s.line} (${s.reason})`).join(', ')}${plan.skipped.length > 6 ? '…' : ''}.`;
  if (plan.unknown.length) message += ` Άγνωστοι κωδικοί: ${plan.unknown.slice(0, 8).join(', ')}${plan.unknown.length > 8 ? '…' : ''}.`;
  return message;
}
