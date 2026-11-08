import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  const sourceUrl = process.env.DATABASE_URL || 'file:./data/shop.db';
  // The tests write to the copy only, but they start by reading the source: a DATABASE_URL that points at a hosted database
  // (an env file loaded by mistake) must stop here, before anything connects to it.
  if (!sourceUrl.startsWith('file:')) throw new Error(`cloneDatabase: DATABASE_URL must be a local file: URL for tests, got a ${sourceUrl.split(':')[0]}: URL`);
  const source = createClient({ url: sourceUrl });
  await source.execute(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  source.close();
  // the local database can be behind the code (a column added since it was last migrated): bring the COPY up to date, a no-op when it is current
  const copy = createClient({ url: `file:${file}` });
  await migrate(drizzle(copy), { migrationsFolder: './drizzle' });
  copy.close();
  process.env.DATABASE_URL = `file:${file}`;
  return dir;
}

/**
 * Deletes a folder made by cloneDatabase. Windows refuses to delete a database file that is still open, so the shop's own
 * client (src/lib/db keeps it on globalThis outside production) is closed first. The close lets go of the file only once
 * the event loop runs again, so the retries wait asynchronously. A folder that still can't be removed is reported, not
 * fatal: it sits in the temp folder, and the run's result must not depend on it.
 */
export async function removeClone(dir: string): Promise<void> {
  (globalThis as { __ocDbClient?: { close(): void } }).__ocDbClient?.close();
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 10) {
        console.warn(`(could not remove the test folder ${dir}: ${(err as Error).message})`);
        return;
      }
      await delay(100 * attempt);
    }
  }
}

/**
 * `node <tsx cli>`: runs a script in a child process the same way on macOS, Linux and Windows. `npx` and
 * `node_modules/.bin/tsx` are .cmd shims on Windows, which spawn and execFile can't start without a shell.
 */
export const TSX = { node: process.execPath, cli: path.resolve('node_modules/tsx/dist/cli.mjs') };
