import { cache } from 'react';
import { db } from '@/lib/db';
import { settings as settingsTable } from '@/lib/db/schema';
import { DEFAULT_SETTINGS, type ShopSettings } from '@/lib/settings';

/* Server-only half of the settings module: reads and writes the `settings` table. */

type Group = keyof ShopSettings;
const GROUPS = Object.keys(DEFAULT_SETTINGS) as Group[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeGroup<T extends Record<string, unknown>>(defaults: T, stored: unknown): T {
  if (!isPlainObject(stored)) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = stored[key];
    if (value === undefined || value === null) continue;
    // arrays and scalars replace wholesale; only same-typed values are accepted
    if (typeof value === typeof defaults[key] && Array.isArray(value) === Array.isArray(defaults[key])) {
      out[key] = value;
    }
  }
  return out as T;
}

async function loadSettings(): Promise<ShopSettings> {
  const rows = await db.select().from(settingsTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const result = structuredClone(DEFAULT_SETTINGS) as ShopSettings;
  for (const group of GROUPS) {
    (result[group] as Record<string, unknown>) = mergeGroup(
      DEFAULT_SETTINGS[group] as Record<string, unknown>,
      byKey.get(group),
    );
  }
  return result;
}

/** Per-request memoised. Safe to call from any server component / action. */
export const getSettings = cache(loadSettings);

export async function saveSettingsGroup<G extends Group>(group: G, value: ShopSettings[G]): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key: group, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}
