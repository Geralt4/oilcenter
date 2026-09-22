import './env';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { settings } from '../src/lib/db/schema';
import { applyHazardLabels, applyManufacturerSpecs } from './manufacturer-data';
import { applySkroutzPrices } from './skroutz-prices';

/*
 * One-time DATA patches for existing databases. Runs at start-up after the migrations and the seed (see Dockerfile).
 * The hosted database lives on a volume and is never re-seeded, so this is how a data change rides along with a deploy.
 * Each patch runs exactly once per database: its id is recorded in the settings table under the key "dataPatches".
 * Patches must be safe on a freshly seeded database too (they simply find nothing to do there).
 */

const PATCHES: Array<{ id: string; run: () => Promise<string> }> = [
  // Real prices from the shop's Skroutz listing. Never overwrites a price the owner has already confirmed.
  { id: '2026-09-20-skroutz-prices', run: () => applySkroutzPrices({ verbose: false }) },
  // Specifications from the manufacturers' data sheets, only where the product had none.
  { id: '2026-09-22-manufacturer-specs', run: () => applyManufacturerSpecs({ verbose: false }) },
  // Hazard labelling copied from the manufacturers' safety data sheets — unconfirmed, so nothing shows until checked.
  { id: '2026-09-22-hazard-labels', run: () => applyHazardLabels({ verbose: false }) },
];

const KEY = 'dataPatches';

async function main() {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const applied = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
  const pending = PATCHES.filter((p) => !applied.has(p.id));
  if (!pending.length) {
    console.log('Data patches: nothing to apply.');
    return;
  }
  for (const patch of pending) {
    console.log(`Data patch ${patch.id}: ${await patch.run()}`);
    applied.add(patch.id);
    const value = [...applied];
    await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
