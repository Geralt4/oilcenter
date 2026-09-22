import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { products } from '../src/lib/db/schema';
import { buildHazard, type HazardInfo } from '../src/lib/ghs';
import { normalizeText } from '../src/lib/utils';

/*
 * Data taken from the manufacturers' own documents, matched by hand to catalogue slugs (September 2026):
 *   catalog/manufacturer-specs.json — specifications / approvals from the current product data sheets, for products
 *                                     that had none
 *   catalog/hazard-labels.json      — the label elements of section 2.2 of the manufacturers' safety data sheets
 * Shared by the seed and the data patches. Both only ever FILL GAPS: a product that already has specs keeps them, a
 * product whose hazard card has been touched keeps it, and hazard data always lands unconfirmed — nothing reaches the
 * storefront until the owner has checked it against the pack (see README → hazard labelling).
 */

export type SpecEntry = { slug: string; specs: string[]; source: string; url: string };
export type HazardEntry = { slug: string; hazard: HazardInfo; source: string; url: string; note?: string };

function readJson<T>(file: string): T | null {
  const full = path.resolve(file);
  return existsSync(full) ? (JSON.parse(readFileSync(full, 'utf8')) as T) : null;
}

export function loadManufacturerSpecs(): Map<string, SpecEntry> {
  const data = readJson<{ entries: SpecEntry[] }>('catalog/manufacturer-specs.json');
  return new Map((data?.entries ?? []).filter((e) => e.specs.length > 0).map((e) => [e.slug, e]));
}

export function loadHazardLabels(): Map<string, HazardEntry> {
  const data = readJson<{ entries: HazardEntry[] }>('catalog/hazard-labels.json');
  return new Map((data?.entries ?? []).map((e) => [e.slug, e]));
}

/** the stored hazard card, run through the same builder as the admin form so it is shaped exactly like typed input */
export function hazardFromEntry(entry: HazardEntry): HazardInfo | null {
  const h = entry.hazard;
  return buildHazard({
    none: Boolean(h.none),
    confirmed: false,
    signalWord: h.signalWord ?? '',
    pictograms: h.pictograms ?? [],
    statements: (h.statements ?? []).join('\n'),
    precautions: (h.precautions ?? []).join('\n'),
    sdsUrl: h.sdsUrl ?? '',
  });
}

const stamp = (notes: string | null, line: string) => (notes ? `${notes.trimEnd()}\n${line}` : line);

/** Fills in specs for products that have none. Products the owner (or the seed) already gave specs are left alone. */
export async function applyManufacturerSpecs({ dry = false, verbose = true } = {}): Promise<string> {
  const entries = loadManufacturerSpecs();
  const rows = await db.select({ id: products.id, slug: products.slug, specs: products.specs, searchText: products.searchText, internalNotes: products.internalNotes }).from(products);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  let filled = 0, kept = 0;
  const unknown: string[] = [];
  for (const [slug, entry] of entries) {
    const p = bySlug.get(slug);
    if (!p) {
      unknown.push(slug);
      continue;
    }
    if (p.specs.length > 0) {
      kept++;
      continue;
    }
    if (verbose) console.log(`  ${dry ? 'would set' : 'set'} ${slug}: ${entry.specs.join(' · ')}`);
    if (!dry) {
      await db
        .update(products)
        .set({
          specs: entry.specs,
          searchText: `${p.searchText} ${normalizeText(entry.specs.join(' '))}`.trim(),
          internalNotes: stamp(p.internalNotes, `Προδιαγραφές από ${entry.source} — επιβεβαιώστε με τη συσκευασία. ${entry.url}`),
        })
        .where(eq(products.id, p.id));
    }
    filled++;
  }
  return `${dry ? '[dry run] ' : ''}${filled} products got specs · ${kept} already had specs (kept)` + (unknown.length ? ` · ${unknown.length} slugs not in this database (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''})` : '');
}

/** Pre-fills the hazard card (unconfirmed) for products nobody has looked at yet. A card that exists is never touched. */
export async function applyHazardLabels({ dry = false, verbose = true } = {}): Promise<string> {
  const entries = loadHazardLabels();
  const rows = await db.select({ id: products.id, slug: products.slug, hazard: products.hazard, internalNotes: products.internalNotes }).from(products);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  let filled = 0, kept = 0, invalid = 0;
  const unknown: string[] = [];
  for (const [slug, entry] of entries) {
    const p = bySlug.get(slug);
    if (!p) {
      unknown.push(slug);
      continue;
    }
    if (p.hazard) {
      kept++;
      continue;
    }
    const hazard = hazardFromEntry(entry);
    if (!hazard) {
      invalid++;
      if (verbose) console.log(`  skipped ${slug}: the entry holds no label elements`);
      continue;
    }
    if (verbose) console.log(`  ${dry ? 'would set' : 'set'} ${slug}: ${hazard.none ? 'no label elements' : `${hazard.signalWord ?? '—'} ${(hazard.pictograms ?? []).join(' ')} ${(hazard.statements ?? []).map((s) => s.split(' ')[0]).join(' ')}`}`);
    if (!dry) {
      const line = `Σήμανση κινδύνου προσυμπληρωμένη από ${entry.source} — ΔΕΝ εμφανίζεται στο site μέχρι να την ελέγξετε με τη συσκευασία και να τικάρετε «Το έλεγξα».${entry.note ? ` ${entry.note}` : ''}`;
      await db.update(products).set({ hazard, internalNotes: stamp(p.internalNotes, line) }).where(eq(products.id, p.id));
    }
    filled++;
  }
  return `${dry ? '[dry run] ' : ''}${filled} hazard cards pre-filled (unconfirmed) · ${kept} already had a card (kept)` + (invalid ? ` · ${invalid} entries empty` : '') + (unknown.length ? ` · ${unknown.length} slugs not in this database (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''})` : '');
}
