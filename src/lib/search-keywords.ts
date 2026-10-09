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
