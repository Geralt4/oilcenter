import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// ─── Money ───────────────────────────────────────────────────────────────────
const eur = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' });

/** 1234 → "12,34 €" */
export function formatPrice(cents: number): string {
  return eur.format(cents / 100);
}

/**
 * A typed amount, in cents: "12,90" | "12.90" | "12" → 1290 | 1290 | 1200. Returns null when it is not an amount —
 * and also when it could be read two ways. Thousands must be unmistakable: "1.250,00" or "1,250.00" (both marks),
 * or "1.250.000" (more than one group). A lone "1.250" or "12,500" is refused rather than guessed: it is 1 250 € to
 * a Greek reader and 1,25 € to a spreadsheet, and a price saved a thousand times off is worse than one typed again.
 */
export function parsePriceToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const typed = input.trim().replace(/[€\s]/g, '');
  let plain: string;
  if (/^\d+(\.\d{1,2})?$/.test(typed)) plain = typed; // 12 · 12.9 · 12.90
  else if (/^\d+,\d{1,2}$/.test(typed)) plain = typed.replace(',', '.'); // 12,9 · 12,90
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(typed) || /^\d{1,3}(\.\d{3}){2,}$/.test(typed)) plain = typed.replace(/\./g, '').replace(',', '.'); // 1.250,00 · 1.250.000
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(typed) || /^\d{1,3}(,\d{3}){2,}$/.test(typed)) plain = typed.replace(/,/g, ''); // 1,250.00 · 1,250,000
  else return null;
  return Math.round(Number(plain) * 100);
}

/** cents → "12,50" for <input> default values */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** VAT-inclusive gross → the VAT portion, in cents */
export function vatPortion(grossCents: number, ratePercent: number): number {
  return Math.round(grossCents - grossCents / (1 + ratePercent / 100));
}

// ─── Text ────────────────────────────────────────────────────────────────────
/**
 * Lower-case, strip accents/diaeresis and fold final sigma so that
 * "ΛΆΔΙ", "λάδι" and "λαδι" all compare equal. Used for both the stored
 * haystack and the incoming query because SQLite's LIKE only folds ASCII.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const GREEK_DIGRAPHS: Array<[RegExp, string]> = [
  [/ου/g, 'ou'],
  [/αι/g, 'ai'],
  [/ει/g, 'ei'],
  [/οι/g, 'oi'],
  [/ευ/g, 'ev'],
  [/αυ/g, 'av'],
  [/μπ/g, 'b'],
  [/ντ/g, 'nt'],
  [/γκ/g, 'gk'],
  [/γγ/g, 'ng'],
  [/τσ/g, 'ts'],
  [/τζ/g, 'tz'],
];

const GREEK_LETTERS: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

/** "Λιπαντικά Κινητήρα" → "lipantika-kinitira". Latin text passes through. */
export function slugify(input: string): string {
  let s = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ');
  for (const [re, to] of GREEK_DIGRAPHS) s = s.replace(re, to);
  s = s.replace(/[α-ω]/g, (ch) => GREEK_LETTERS[ch] ?? ch);
  return s
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

// ─── Misc ────────────────────────────────────────────────────────────────────
/** "2310 850778" → "+302310850778" for tel: links */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '#';
  if (digits.startsWith('30') && digits.length > 10) return `tel:+${digits}`;
  return `tel:+30${digits}`;
}

const dateFmt = new Intl.DateTimeFormat('el-GR', { dateStyle: 'medium', timeZone: 'Europe/Athens' });
const dateTimeFmt = new Intl.DateTimeFormat('el-GR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Athens',
});

export function formatDate(d: Date | number): string {
  return dateFmt.format(d);
}

export function formatDateTime(d: Date | number): string {
  return dateTimeFmt.format(d);
}

/** 4500 → "4,5 kg", 300 → "300 g" */
export function formatWeight(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toLocaleString('el-GR', { maximumFractionDigits: 1 })} kg`;
  return `${grams} g`;
}

/** 1000 → "1L", 300 → "300ml", 20000 → "20L" */
export function formatVolume(ml: number): string {
  if (ml >= 1000) return `${(ml / 1000).toLocaleString('el-GR', { maximumFractionDigits: 2 })}L`;
  return `${ml}ml`;
}

/** "5L" | "300 ml" | "1 lt" | "20 Liter" → millilitres, or null */
export function parseVolumeMl(label: string): number | null {
  const m = label
    .toLowerCase()
    .replace(',', '.')
    .match(/([\d.]+)\s*(ml|l|lt|ltr|liter|litre|λίτρ\S*|λιτρ\S*|kg|g|gr)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === 'ml' || unit === 'g' || unit === 'gr') return Math.round(n);
  return Math.round(n * 1000);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function isGreekPostalCode(value: string): boolean {
  return /^\d{3}\s?\d{2}$/.test(value.trim());
}

/** Greek ΑΦΜ check digit (mod 11) */
export function isValidAfm(value: string): boolean {
  const afm = value.replace(/\D/g, '');
  if (afm.length !== 9 || afm === '000000000') return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(afm[i]) * 2 ** (8 - i);
  return (sum % 11) % 10 === Number(afm[8]);
}
