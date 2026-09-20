import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/* catalog/skroutz-prices.json: the shop's own Skroutz prices, matched by hand to catalogue SKUs. Shared by the seed and `npm run prices:skroutz`. */

export type SkroutzMatch = { sku: string; priceCents: number; confidence: 'exact' | 'probable' };

export function loadSkroutzPrices(): Map<string, SkroutzMatch> {
  const file = path.resolve('catalog/skroutz-prices.json');
  if (!existsSync(file)) return new Map();
  const { matches } = JSON.parse(readFileSync(file, 'utf8')) as { matches: SkroutzMatch[] };
  return new Map(matches.filter((m) => Number.isInteger(m.priceCents) && m.priceCents > 0).map((m) => [m.sku, m]));
}
