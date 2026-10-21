import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

/**
 * A throwaway, consistent copy of the local database for a test run. `VACUUM INTO` rather than a file copy: the shop
 * runs in WAL mode, so shop.db on its own can be days behind — everything recent still sits in shop.db-wal.
 * Call it BEFORE importing anything that opens the database; it points DATABASE_URL at the copy.
 */
export async function cloneDatabase(prefix: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const file = path.join(dir, 'shop.db');
  const source = createClient({ url: process.env.DATABASE_URL || 'file:./data/shop.db' });
  await source.execute(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  source.close();
  // the local database can be behind the code (a column added since it was last migrated): bring the COPY up to date, a no-op when it is current
  const copy = createClient({ url: `file:${file}` });
  await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
  copy.close();
  process.env.DATABASE_URL = `file:${file}`;
  return dir;
}
