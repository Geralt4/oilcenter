/*
 * Turns the specification lines of a product («VW 504 00/507 00», «MB-Approval 229.51», «BMW Longlife-04») into
 * stable keys a listing can filter on. Pure module.
 *
 * What it must never do:
 *   - infer. API SP oils are usually fine where SN is asked for, MB 229.51 is not 229.5, ACEA C3 is not C2:
 *     a product gets exactly the approvals its label prints, nothing "compatible";
 *   - guess. A line it does not understand yields nothing and simply stays a plain chip on the product page.
 * It does merge spellings of the SAME approval («BMW Longlife-04» = «BMW LL-04», «FIAT 955535-S2» = «Fiat 9.55535-S2»),
 * and it does not distinguish «MB-Approval 229.5» from «MB 229.5»: both are what the pack says, and the facet says so.
 */

export type ApprovalFacet = 'standard' | 'oem' | 'other';
export type Approval = { key: string; label: string; facet: ApprovalFacet; /** sort key: family first, then natural order */ order: string };

const slug = (s: string) => s.toLowerCase().replace(/\+/g, '-plus').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
const pad = (s: string) => s.replace(/\d+/g, (n) => n.padStart(6, '0'));

function make(facet: ApprovalFacet, family: string, rank: number, label: string): Approval {
  return { key: slug(label), label, facet, order: `${String(rank).padStart(2, '0')}|${family}|${pad(label)}` };
}
const standard = (family: string, rank: number, label: string) => make('standard', family, rank, label);
const oem = (family: string, label: string) => make('oem', family, 50, label);
const other = (family: string, rank: number, label: string) => make('other', family, rank, label);

/** ACEA sequences that are written with a slash but are ONE category */
const ACEA_PAIRS = new Set(['A1/B1', 'A3/B3', 'A3/B4', 'A5/B5', 'A7/B7']);

type Rule = (line: string) => Approval[] | null;

const all = (text: string, re: RegExp) => [...text.matchAll(re)];

const RULES: Rule[] = [
  // ── Industry standards ──
  (l) => {
    const m = /^ACEA\s+(.+)$/i.exec(l);
    if (!m) return null;
    return m[1].toUpperCase().split(/\s*[,&]\s*/).flatMap((part) => {
      const p = part.replace(/\s+/g, '');
      const tokens = ACEA_PAIRS.has(p) ? [p] : p.split('/');
      return tokens.filter((t) => ACEA_PAIRS.has(t) || /^[ABCEF]\d{1,2}$/.test(t)).map((t) => standard('ACEA', 1, `ACEA ${t}`));
    });
  },
  (l) => {
    const m = /^API\s+(.+)$/i.exec(l);
    if (!m) return null;
    return m[1].toUpperCase().split(/\s*[,/&]\s*/).flatMap((t) => {
      const token = t.trim().replace(/\s+/g, ' ');
      return /^(S[A-Z]( PLUS)?|C[A-Z](-4)?|GL-\d|T[A-C])$/.test(token) ? [standard('API', 2, `API ${token}`)] : [];
    });
  },
  (l) => {
    const m = /^ILSAC\s+(GF-\d[AB]?)$/i.exec(l);
    return m ? [standard('ILSAC', 3, `ILSAC ${m[1].toUpperCase()}`)] : null;
  },
  (l) => {
    const m = /^JASO\s+(.+)$/i.exec(l);
    if (!m) return null;
    return m[1].toUpperCase().split(/\s*[,/&]\s*/).flatMap((t) => {
      const token = t.replace(/[\s-]/g, '');
      return /^(MA|MA1|MA2|MB|FA|FB|FC|FD)$/.test(token) ? [standard('JASO', 4, `JASO ${token}`)] : [];
    });
  },

  // ── Vehicle manufacturers ──
  (l) => (/^VW\b/i.test(l) ? all(l, /\b(\d{3})\s?(\d{2})\b/g).map((m) => oem('VW', `VW ${m[1]} ${m[2]}`)) : null),
  (l) => (/^MB\b/i.test(l) ? all(l, /\b(\d{3}\.\d{1,2})\b/g).map((m) => oem('MB', `MB ${m[1]}`)) : null),
  (l) => {
    if (!/^BMW\b/i.test(l)) return null;
    const ll = all(l, /\b(?:LL|Longlife)[\s-]?(\d{2})(\s?FE\+?)?/gi).map((m) => oem('BMW', `BMW LL-${m[1]}${m[2] ? ' FE+' : ''}`));
    const mtf = /MTF/i.test(l) ? all(l, /\bLT-?(\d)\b/gi).map((m) => oem('BMW', `BMW MTF LT-${m[1]}`)) : [];
    return [...ll, ...mtf];
  },
  (l) => (/^RENAULT\b/i.test(l) ? all(l, /\b(?:RN\s?)?(0\d{3}|17(?:\s?FE)?)\b/gi).map((m) => oem('Renault', `Renault RN${m[1].toUpperCase().replace(/\s+/g, ' ')}`)) : null),
  (l) => (/^PSA\b/i.test(l) ? all(l, /\bB71\s?(\d{4})\b/gi).map((m) => oem('PSA', `PSA B71 ${m[1]}`)) : null),
  (l) => {
    const m = /^FIAT\s+9\.?(55535|55550)-(.+)$/i.exec(l);
    if (!m) return null;
    return m[2].toUpperCase().split(/\s*\/\s*/).filter((t) => /^[A-Z0-9]{1,4}$/.test(t)).map((t) => oem('Fiat', `Fiat 9.${m[1]}-${t}`));
  },
  (l) => {
    // labels print Ford's ATF specification without the maker's name
    if (/^(FORD\s+)?MERCON\b/i.test(l)) return all(l, /MERCON\s?(LV|SP|V)\b/gi).map((m) => oem('Ford', `Ford MERCON ${m[1].toUpperCase()}`));
    if (!/^FORD\b/i.test(l)) return null;
    // «WSS-M2C947-A / -B1 / 962-A1»: a bare suffix repeats the number before it, a bare number starts a new one
    let number = '';
    return l.replace(/^FORD\s+/i, '').split(/\s*\/\s*/).flatMap((part) => {
      const full = /M2C\s?(\d{3})-?([A-Z]\d?)/i.exec(part);
      const suffix = /^-([A-Z]\d?)$/i.exec(part.trim());
      const next = /^(\d{3})-([A-Z]\d?)$/i.exec(part.trim());
      if (full) number = full[1];
      else if (next) number = next[1];
      const letter = (full?.[2] ?? suffix?.[1] ?? next?.[2])?.toUpperCase();
      return number && letter ? [oem('Ford', `Ford WSS-M2C${number}-${letter}`)] : [];
    });
  },
  (l) => {
    const m = /\bdexos\s?([12D])(?:\s*gen\s*(\d))?/i.exec(l);
    return m ? [oem('GM', `GM dexos${m[1].toUpperCase()}${m[2] ? ` Gen ${m[2]}` : ''}`)] : null;
  },
  (l) => {
    const m = /^GM.*\bLL[\s-]?([AB])[\s-]?025\b/i.exec(l);
    return m ? [oem('GM', `GM-LL-${m[1].toUpperCase()}-025`)] : null;
  },
  (l) => {
    const m = /\bOV\s?040\s?1547\s?-?\s?(.+)$/i.exec(l);
    if (!m) return null;
    return m[1].toUpperCase().split(/\s*\/\s*/).filter((t) => /^[A-Z]\d{2}$/.test(t.trim())).map((t) => oem('GM', `Opel OV 040 1547-${t.trim()}`));
  },
  (l) => {
    const m = /^DEXRON[\s-]?(VI|III|II)(?:\s?([A-Z]))?$/i.exec(l);
    return m ? [oem('GM', `GM DEXRON ${m[1].toUpperCase()}${m[2] ? ` ${m[2].toUpperCase()}` : ''}`)] : null;
  },
  (l) => {
    const m = /^PORSCHE\s+([AC]\d{2})$/i.exec(l);
    return m ? [oem('Porsche', `Porsche ${m[1].toUpperCase()}`)] : null;
  },
  (l) => (/^(CHRYSLER\s+)?MS[\s-]?\d{4,5}/i.test(l) ? all(l.replace(/^CHRYSLER\s+/i, ''), /\b(\d{4,5})\b/g).map((m) => oem('Chrysler', `Chrysler MS-${m[1]}`)) : null),
  (l) => {
    const m = /\bSTJLR\.(\d{2})\.(\d{4})\b/i.exec(l);
    return m ? [oem('JLR', `JLR STJLR.${m[1]}.${m[2]}`)] : null;
  },
  (l) => (/^VOLVO\b/i.test(l) ? all(l, /\b(97\d{3})\b/g).map((m) => oem('Volvo', `Volvo ${m[1]}`)) : null),
  (l) => {
    const m = /^MAN\s+(?:M\s?(\d{4})|(\d{3})\s+Typ\s+([A-Z]-?\d))$/i.exec(l);
    if (!m) return null;
    return [oem('MAN', m[1] ? `MAN M ${m[1]}` : `MAN ${m[2]} Typ ${m[3].toUpperCase()}`)];
  },
  (l) => {
    const m = /^MTU\s+Type\s+(\d(?:\.\d)?)$/i.exec(l);
    return m ? [oem('MTU', `MTU Type ${m[1]}`)] : null;
  },
  (l) => (/^ZF\s+TE-ML\b/i.test(l) ? all(l, /\b(\d{2}[A-Z])\b/g).map((m) => oem('ZF', `ZF TE-ML ${m[1]}`)) : null),
  (l) => {
    const m = /^JWS\s?(\d{4})$/i.exec(l);
    return m ? [oem('JWS', `JWS ${m[1]}`)] : null;
  },

  // ── Everything that is not an engine / gear oil approval ──
  (l) => {
    const m = /^G\s?(11|12|13)(\+{0,2})$/i.exec(l);
    return m ? [other('Coolant', 1, `G${m[1]}${m[2]}`)] : null;
  },
  (l) => {
    const m = /^DOT\s?(3|4|5\.1|5)$/i.exec(l);
    return m ? [other('Brake fluid', 2, `DOT ${m[1]}`)] : null;
  },
  (l) => {
    const m = /^NLGI\s?(\d{1,3})$/i.exec(l);
    return m ? [other('Grease', 3, `NLGI ${m[1]}`)] : null;
  },
  (l) => {
    const m = /^MIL-L-(\d{4})\s?([A-Z])$/i.exec(l);
    return m ? [other('MIL', 4, `MIL-L-${m[1]}${m[2].toUpperCase()}`)] : null;
  },
];

/** One spec line → the approvals it names (usually one; «VW 502 00 / 505 00» names two). Unknown lines → []. */
export function parseSpecLine(line: string): Approval[] {
  const l = line.trim().replace(/\s+/g, ' ');
  for (const rule of RULES) {
    const hit = rule(l);
    if (hit) return dedupe(hit);
  }
  return [];
}

export function parseApprovals(specs: string[]): Approval[] {
  return dedupe(specs.flatMap(parseSpecLine));
}

function dedupe(items: Approval[]): Approval[] {
  return [...new Map(items.map((a) => [a.key, a])).values()];
}

export const FACET_TITLES: Record<ApprovalFacet, string> = {
  standard: 'Προδιαγραφή (ACEA · API · JASO)',
  oem: 'Έγκριση κατασκευαστή',
  other: 'Άλλες προδιαγραφές',
};
