/*
 * Hazard labelling of chemical products (EU CLP Regulation 1272/2008): what the pack's label says, repeated on the
 * product page. As we read Article 48, an offer that lets someone buy a hazardous mixture without seeing the label
 * first has to show the label's hazard information — what exactly that requires of this shop is a question for the
 * lawyer (questions.md). Antifreeze, brake fluid, additives, sprays and 2-stroke oils are the usual cases; most
 * engine oils carry no hazard labelling.
 *
 * Pure module (no database): shared by the admin form, the save action, the product page and the tests.
 *
 * Rules this code follows:
 *   - nothing is shown until the owner has ticked «το έλεγξα με τη συσκευασία» (`confirmed`): hazard data that does
 *     not match the pack on the shelf is worse than none;
 *   - the source is the pack's own label or the manufacturer's safety data sheet (section 2.2) — never our product
 *     photos, whose small print is unreadable;
 *   - a statement is kept exactly as typed. A line that is only a code («H302») is completed with the regulation's
 *     own Greek wording when GHS_STATEMENTS_EL knows it; anything else is printed as written, because some statements
 *     have to name a substance (EUH208 «Περιέχει …»).
 */

import { GHS_STATEMENTS_EL } from '@/lib/ghs-statements-el';

/**
 * The symbols themselves are public/ghs/GHS01…09.svg: the UNECE artwork as vectorised on Wikimedia Commons
 * (GHS-pictogram-explos / flamme / rondflam / bottle / acid / skull / exclam / silhouette / pollu .svg), which is in
 * the public domain ("ineligible for copyright"). They are official signs: never redraw or restyle them.
 */
export const GHS_PICTOGRAMS = {
  GHS01: { symbol: 'Εκρηγνυόμενη βόμβα', meaning: 'Εκρηκτικό' },
  GHS02: { symbol: 'Φλόγα', meaning: 'Εύφλεκτο' },
  GHS03: { symbol: 'Φλόγα πάνω από κύκλο', meaning: 'Οξειδωτικό' },
  GHS04: { symbol: 'Φιάλη αερίου', meaning: 'Αέριο υπό πίεση' },
  GHS05: { symbol: 'Διάβρωση', meaning: 'Διαβρωτικό' },
  GHS06: { symbol: 'Νεκροκεφαλή με διασταυρούμενα οστά', meaning: 'Οξεία τοξικότητα' },
  GHS07: { symbol: 'Θαυμαστικό', meaning: 'Επιβλαβές / ερεθιστικό' },
  GHS08: { symbol: 'Κίνδυνος για την υγεία', meaning: 'Σοβαρός κίνδυνος για την υγεία' },
  GHS09: { symbol: 'Περιβάλλον', meaning: 'Επικίνδυνο για το υδάτινο περιβάλλον' },
} as const;

export type GhsPictogram = keyof typeof GHS_PICTOGRAMS;
export const GHS_PICTOGRAM_CODES = Object.keys(GHS_PICTOGRAMS) as GhsPictogram[];

/** the two signal words of the regulation, in its Greek wording */
export const SIGNAL_WORDS = { danger: 'Κίνδυνος', warning: 'Προσοχή' } as const;
export type SignalWord = keyof typeof SIGNAL_WORDS;

export type HazardInfo = {
  /** the owner looked at the pack: it carries no hazard labelling */
  none?: boolean;
  signalWord?: SignalWord;
  pictograms?: GhsPictogram[];
  /** hazard statements (H…, EUH…), one per entry: a bare code or the label's own wording */
  statements?: string[];
  /** precautionary statements (P…), same rule */
  precautions?: string[];
  /** the manufacturer's safety data sheet: an uploaded PDF (/media/sds/…) or a link to the manufacturer's site */
  sdsUrl?: string;
  /** false/absent = typed in but not yet checked against the pack on the shelf: never shown to customers */
  confirmed?: boolean;
};

/**
 * Official Greek wording by code: lib/ghs-statements-el.ts, generated from the regulation's consolidated Greek text —
 * never from memory or a translation. A code that is not there, or whose official wording is a template the label
 * has to complete («Περιέχει <όνομα της ευαισθητοποιητικής ουσίας>…», «Διάθεση του περιεχομένου/περιέκτη σε …»),
 * is shown as typed and flagged in the admin form, which is the safe failure.
 */
export { GHS_STATEMENTS_EL };

/** the label completes these itself: they can never stand in for what the pack actually says */
const isTemplate = (wording: string) => /[<>…]|\.\.\./.test(wording);

const CODE = /^((?:EUH|H|P)\d{3}[A-Za-z]{0,2}(?:\s*\+\s*(?:EUH|H|P)\d{3}[A-Za-z]{0,2})*)(?:\s*[:.–—-]\s*|\s+|$)(.*)$/i;

export type Statement = { code: string | null; text: string | null };

/**
 * "H302" → the official wording if known; "H302 Επιβλαβές…" → as typed; free text → as typed.
 * The table is looked up by the upper-cased code ("H361D", "P301+P312"); the code is shown the way the regulation
 * writes it (the letters after the digits keep their case: H361d, H350i).
 */
export function parseStatement(line: string, table: Record<string, string> = GHS_STATEMENTS_EL): Statement {
  const raw = line.trim();
  const m = CODE.exec(raw);
  if (!m) return { code: null, text: raw };
  const code = m[1].replace(/\s+/g, '').replace(/(^|\+)(euh|h|p)/gi, (_, plus: string, letters: string) => plus + letters.toUpperCase());
  const typed = m[2].trim();
  const official = table[code.toUpperCase()];
  return { code, text: typed || (official && !isTemplate(official) ? official : null) };
}

/** Codes typed without wording that the table cannot complete: the admin form warns about them. */
export function unknownCodes(hazard: HazardInfo, table: Record<string, string> = GHS_STATEMENTS_EL): string[] {
  return [...(hazard.statements ?? []), ...(hazard.precautions ?? [])].map((l) => parseStatement(l, table)).flatMap((s) => (s.code && !s.text ? [s.code] : []));
}

export const hasLabelElements = (h: HazardInfo) => Boolean(h.signalWord || h.pictograms?.length || h.statements?.length || h.precautions?.length);

/** What customers may see: only checked data, and only when there is something to say. */
export function publicHazard(hazard: HazardInfo | null | undefined): HazardInfo | null {
  if (!hazard?.confirmed) return null;
  if (hazard.none) return hazard.sdsUrl ? { none: true, sdsUrl: hazard.sdsUrl, confirmed: true } : null;
  return hasLabelElements(hazard) || hazard.sdsUrl ? hazard : null;
}

/** Builds the stored value from the admin form's fields; null when the card was left empty. */
export function buildHazard(input: { none: boolean; confirmed: boolean; signalWord: string; pictograms: string[]; statements: string; precautions: string; sdsUrl: string }): HazardInfo | null {
  const lines = (s: string) => s.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40);
  const sdsUrl = input.sdsUrl.trim();
  if (input.none) return { none: true, confirmed: input.confirmed, ...(sdsUrl && { sdsUrl }) };
  const hazard: HazardInfo = {
    ...(input.signalWord in SIGNAL_WORDS && { signalWord: input.signalWord as SignalWord }),
    pictograms: GHS_PICTOGRAM_CODES.filter((c) => input.pictograms.includes(c)),
    statements: lines(input.statements),
    precautions: lines(input.precautions),
    ...(sdsUrl && { sdsUrl }),
  };
  if (!hasLabelElements(hazard) && !sdsUrl) return null;
  // a label with pictograms or statements always has a signal word… except the few EUH-only labels; "confirmed" with
  // nothing but an SDS link is fine too (it just publishes the link)
  return { ...hazard, confirmed: input.confirmed };
}

/**
 * Categories whose products usually carry hazard labelling: what the admin worklist and the dashboard count.
 * Slugs of top-level categories (all their sub-categories count) and of single sub-categories.
 */
export const HAZARD_PRIORITY_CATEGORIES = ['antipsyktika-ygra', 'chimika-prostheta', 'lipantika-2t'];

export function hazardPriorityCategoryIds(categories: Array<{ id: number; slug: string; parentId: number | null }>): Set<number> {
  const listed = new Set(categories.filter((c) => HAZARD_PRIORITY_CATEGORIES.includes(c.slug)).map((c) => c.id));
  return new Set(categories.filter((c) => listed.has(c.id) || (c.parentId !== null && listed.has(c.parentId))).map((c) => c.id));
}

/** On the worklist: an active product of those categories whose labelling nobody has confirmed yet (either way). */
export function needsHazardCheck(product: { isActive: boolean; categoryId: number | null; hazard: HazardInfo | null }, priorityIds: Set<number>): boolean {
  return product.isActive && product.categoryId !== null && priorityIds.has(product.categoryId) && !product.hazard?.confirmed;
}
