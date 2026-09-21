"""Extract the Greek wording of every hazard (H, EUH) and precautionary (P) statement from the consolidated
Greek text of Regulation (EC) No 1272/2008 (Annex III and IV, plus the additional codes of Annex VI 1.1.2.1.2)
as published by the EU Publications Office. This is how src/lib/ghs-statements-el.ts was produced.

Get the source (about 30 MB; replace the date with the newest consolidated version):
  curl -L -H "Accept: application/xhtml+xml" -H "Accept-Language: el" \
       -o clp-el.xhtml http://publications.europa.eu/resource/celex/02008R1272-20260701

usage: python3 scripts/extract-ghs-statements.py clp-el.xhtml statements.json
Then compare statements.json with the table in src/lib/ghs-statements-el.ts before regenerating it: a changed wording
is a legal change, not a typo to be smoothed over.
"""
import html.entities
import json
import re
import sys
import xml.etree.ElementTree as ET

src, out = sys.argv[1], sys.argv[2]
raw = open(src, encoding='utf-8').read()

# XHTML named entities are not known to a plain XML parser
def entity(m):
    name = m.group(1)
    if name in ('amp', 'lt', 'gt', 'quot', 'apos'):
        return m.group(0)
    cp = html.entities.name2codepoint.get(name)
    return f'&#{cp};' if cp else m.group(0)

raw = re.sub(r'&([A-Za-z][A-Za-z0-9]*);', entity, raw)
raw = re.sub(r'<!DOCTYPE[^>]*>', '', raw, count=1)
root = ET.fromstring(raw.encode('utf-8'))
NS = '{http://www.w3.org/1999/xhtml}'

CODE = re.compile(r'^(EUH|H|P)\d{3}[A-Za-z]{0,2}$')
MARK = re.compile(r'[►▼◄]\s*[A-Z]\d{0,3}\s*|[►▼◄]')


def text_of(el):
    t = ''.join(el.itertext())
    t = MARK.sub(' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def rows_of(table):
    for child in table:
        if child.tag == NS + 'tr':
            yield child
        elif child.tag in (NS + 'tbody', NS + 'thead'):
            for tr in child:
                if tr.tag == NS + 'tr':
                    yield tr


found = {}
conflicts = []
for table in root.iter(NS + 'table'):
    rows = list(rows_of(table))
    if len(rows) < 3:
        continue
    # amendment markers (▼M4 …) sit in rows of their own, so the header is not always the first row
    head_at, head = None, None
    for i, tr in enumerate(rows[:4]):
        cells = [text_of(td) for td in tr if td.tag == NS + 'td']
        if 'Γλώσσα' in cells:
            head_at, head = i, cells
            break
    if head is None:
        continue
    # the Greek text sometimes spells a code with Greek look-alike capitals (Ρ102 with a rho)
    LOOKALIKE = str.maketrans({'Ρ': 'P', 'Η': 'H', 'Ε': 'E'})
    code_cells = [c.replace(' ', '').translate(LOOKALIKE) for c in head[: head.index('Γλώσσα')] if c]
    parts = [p for c in code_cells for p in c.split('+') if p]
    if not parts or not all(CODE.match(p) for p in parts):
        continue
    code = '+'.join(parts)
    el_text = None
    for tr in rows[head_at + 1:]:
        cells = [text_of(td) for td in tr if td.tag == NS + 'td']
        cells = [c for c in cells if c]
        if cells and cells[0] == 'EL':
            el_text = ' '.join(cells[1:]).strip()
            break
    if not el_text:
        continue
    key = code.upper()
    if key in found and found[key]['text'] != el_text:
        conflicts.append((key, found[key]['text'], el_text))
    found.setdefault(key, {'code': code, 'text': el_text})

# Annex VI, 1.1.2.1.2: the additional codes for carcinogenicity by inhalation and the reproductive-toxicity variants
# are given in a plain two-column Greek table (code | wording), not in the multilingual tables of Annex III.
EXTRA = re.compile(r'^H3(50i|60F|60D|61f|61d|60FD|61fd|60Fd|60Df)$')
for table in root.iter(NS + 'table'):
    pairs = []
    for tr in rows_of(table):
        cells = [c for c in (text_of(td) for td in tr if td.tag == NS + 'td') if c]
        if len(cells) == 2 and EXTRA.match(cells[0]):
            pairs.append(cells)
    if len(pairs) >= 9:
        for code, text in pairs:
            text = text if text.endswith('.') else text + '.'
            found.setdefault(code.upper(), {'code': code, 'text': text})
        break

json.dump({'source': re.search(r'<title>([^<]*)</title>', raw).group(1), 'statements': found}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
kinds = {'H': 0, 'EUH': 0, 'P': 0}
for k in found:
    kinds['EUH' if k.startswith('EUH') else k[0]] += 1
print('statements:', len(found), kinds, '| combined:', sum('+' in k for k in found))
print('conflicts:', len(conflicts))
for c in conflicts[:10]:
    print('  ', c)
for k in ['H302', 'H304', 'H373', 'H412', 'H222', 'H229', 'H361D', 'EUH208', 'EUH210', 'EUH066', 'P102', 'P301+P312', 'P501', 'P210']:
    print(f'{k:12s}', found.get(k, {}).get('text'))
