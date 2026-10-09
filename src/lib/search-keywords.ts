import { normalizeText } from '@/lib/utils';

/*
 * What a product can be found by. One formula for the seed, the product editor and the repair patch, so that
 * saving a product can never again produce a different haystack from the one it was seeded with.
 * Pure: no database.
 */

export type SearchTextParts = {
  brand?: string | null;
  name: string;
  viscosity?: string | null;
  specs?: string[];
  category?: string | null;
  /** the words customers use that appear nowhere on the label: «λαδι», «παραφλου», «σασμαν»… (products.keywords) */
  keywords?: string | null;
  /** pack sizes: "1L", "5L" */
  labels?: string[];
};

/** The stored, accent-free haystack (products.search_text). */
export function buildSearchText(p: SearchTextParts): string {
  const viscosity = p.viscosity ?? '';
  return normalizeText([p.brand ?? '', p.name, viscosity, viscosity.replace('-', ''), (p.specs ?? []).join(' '), p.category ?? '', p.keywords ?? '', (p.labels ?? []).join(' ')].join(' '));
}

/**
 * The words in a haystack that its other fields do not account for — i.e. the synonyms the catalogue builder
 * added for that kind of product. Used once, to give products seeded before the keywords column their keywords back.
 */
export function extraKeywords(searchText: string, parts: Omit<SearchTextParts, 'keywords'>): string {
  const known = new Set(buildSearchText(parts).split(' '));
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const word of normalizeText(searchText).split(' ')) {
    if (!word || known.has(word) || seen.has(word)) continue;
    seen.add(word);
    extra.push(word);
  }
  // the haystack folds the final sigma; the owner reads these words in the product editor, so give it back
  return extra.join(' ').replace(/σ(?= |$)/g, 'ς');
}

// ─── How people actually type ────────────────────────────────────────────────

/**
 * Brand names the way a Greek keyboard spells them: «καστρολ 5w30» is as common a query as "castrol 5w30".
 * Keyed by the brand's name as stored (accent-free, lower case); a brand that is missing simply has no alias.
 */
const BRAND_ALIASES: Record<string, string> = {
  accelerate: 'ακσελερειτ αξελερειτ',
  aisin: 'αισιν',
  aral: 'αραλ',
  avista: 'αβιστα',
  castrol: 'καστρολ',
  'liqui moly': 'λικι μολι λικουι λικιμολι',
  mannol: 'μανολ',
  mobil: 'μομπιλ',
  motul: 'μοτουλ',
  'petronas tutela': 'πετρονασ τουτελα',
  selenia: 'σελενια',
  shell: 'σελ',
  toyota: 'τογιοτα',
  valeo: 'βαλεο',
  valvoline: 'βαλβολιν βαλβολαιν',
};

export function brandAliases(brand: string | null | undefined): string {
  return brand ? (BRAND_ALIASES[normalizeText(brand)] ?? '') : '';
}

// Two common ways of writing Greek with Latin letters: by look (υ → y, χ → x) and by sound (υ → i, χ → ch).
const DIGRAPHS: Array<[string, string, string]> = [
  // vowels only: «ντ», «μπ», «γκ» are typed letter by letter (antipsiktiko, not adipsiktiko)
  ['ου', 'ou', 'ou'], ['αι', 'ai', 'e'], ['ει', 'ei', 'i'], ['οι', 'oi', 'i'], ['αυ', 'au', 'av'], ['ευ', 'eu', 'ev'],
];
const LETTERS: Record<string, [string, string]> = {
  α: ['a', 'a'], β: ['v', 'v'], γ: ['g', 'g'], δ: ['d', 'd'], ε: ['e', 'e'], ζ: ['z', 'z'], η: ['h', 'i'], θ: ['th', 'th'], ι: ['i', 'i'], κ: ['k', 'k'], λ: ['l', 'l'], μ: ['m', 'm'],
  ν: ['n', 'n'], ξ: ['x', 'ks'], ο: ['o', 'o'], π: ['p', 'p'], ρ: ['r', 'r'], σ: ['s', 's'], τ: ['t', 't'], υ: ['y', 'i'], φ: ['f', 'f'], χ: ['x', 'ch'], ψ: ['ps', 'ps'], ω: ['w', 'o'],
};

function transliterate(word: string, variant: 0 | 1): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const pair = DIGRAPHS.find(([greek]) => word.startsWith(greek, i));
    if (pair) {
      out += pair[variant + 1];
      i++;
    } else out += LETTERS[word[i]]?.[variant] ?? word[i];
  }
  return out;
}

/**
 * "Greeklish" spellings of the Greek words in an (already normalised) text, so that «ladi», «antipsiktiko» and
 * «antipsyktiko» find what «λάδι» and «αντιψυκτικό» find. Words without Greek letters give nothing.
 */
export function greeklish(normalised: string): string {
  const out = new Set<string>();
  for (const word of normalised.split(' ')) {
    if (!/[α-ω]/.test(word)) continue;
    out.add(transliterate(word, 0));
    out.add(transliterate(word, 1));
    // «η» is typed as "i" far more often than as "h", also by people who write «υ» as "y"…
    out.add(transliterate(word, 0).replace(/h/g, 'i'));
    // …and «υ» as "i" by people who still spell «ει» out: psigeio
    out.add(transliterate(word, 0).replace(/[hy]/g, 'i'));
  }
  return [...out].join(' ');
}

const GRADE = /\b(\d{1,2}) ?w ?(\d{2,3})\b/g;

/**
 * A query, as the tokens to look for. "5w-30", "5 w 30" and "5W30" are one question and become one token, spelled
 * the way every haystack spells a grade («5w30»).
 */
export function searchTerms(q: string): string[] {
  return normalizeText(q).replace(GRADE, '$1w$2').split(' ').filter(Boolean);
}

/**
 * Every grade written out in a (normalised) text, each as that one token. The stored haystack has it only for the
 * product's viscosity FIELD; a product that carries its grade in the name alone must answer to it too.
 */
export function compactGrades(normalised: string): string {
  return [...new Set([...normalised.matchAll(GRADE)].map((m) => `${m[1]}w${m[2]}`))].join(' ');
}

/**
 * What a product is searched in.
 * - `searchText`: its own words. A term matches anywhere in a word ("tronic" finds SuperTronic).
 * - `prefixText`: spellings nobody stores — the brand in Greek letters («καστρολ») and the Greek words in Latin ones
 *   («ladi», «valvolini»). These are approximations, so a term must START one of them: as substrings they matched
 *   far too much («λιπαντικό» spells "lipantiko", which contains "anti"; «ακσελερέιτ» contains «σελ»).
 */
export type SearchDoc = { searchText: string; prefixText: string };

/** The words brand names are made of («liqui», «moly», «valvoline»), for `matchesTerm`. */
export function brandWords(names: Iterable<string>): Set<string> {
  const words = new Set<string>();
  for (const name of names) for (const w of normalizeText(name).split(' ')) if (w.length >= 3) words.add(w);
  return words;
}

/**
 * Does a product answer to one query term?
 * - In its own words: anywhere, except that a term containing a digit must match from the start of a token —
 *   otherwise "5w40" would also return every 15W-40, which is a different oil.
 * - In the approximate spellings: from the start of a word, and never for a Latin term that is (the beginning of) a
 *   brand name. «Βαλβολίνες» spells "valvolines", and somebody who types "valvoline" wants the brand, not every
 *   gear oil in the shop; the brand's own name is in `searchText` anyway.
 */
export function matchesTerm(doc: SearchDoc, term: string, brands: ReadonlySet<string>): boolean {
  if (/\d/.test(term) ? ` ${doc.searchText}`.includes(` ${term}`) : doc.searchText.includes(term)) return true;
  if (/^[a-z]+$/.test(term) && term.length >= 3) for (const word of brands) if (word.startsWith(term)) return false;
  return ` ${doc.prefixText}`.includes(` ${term}`);
}
