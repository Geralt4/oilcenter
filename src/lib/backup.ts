import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { client, DATABASE_URL } from '@/lib/db';

/*
 * Database snapshots. `VACUUM INTO` writes a consistent copy of the SQLite file while the shop keeps running
 * (copying shop.db by hand would miss whatever still sits in the write-ahead log).
 *
 *   DATA_DIR/backups/shop-2026-09-20.db.gz   one per day, the newest 14 are kept
 *
 * These live on the same disk as the database, so they protect against a bad edit or a corrupted file, NOT against
 * losing the disk. Until an off-site copy exists, download one from Admin → Ρυθμίσεις now and then.
 * A snapshot holds customer details and password hashes: treat the file accordingly.
 */

const KEEP = 14;
const NAME = /^shop-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

export const backupsDir = () => path.resolve(process.env.DATA_DIR || './data', 'backups');
export const backupsSupported = () => DATABASE_URL.startsWith('file:');

const athensDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(date);

/** Writes a gzipped snapshot to `target` (absolute path ending in .db.gz). Returns its size in bytes. */
export async function writeSnapshot(target: string): Promise<number> {
  if (!backupsSupported()) throw new Error('Snapshots are only available for a local SQLite database.');
  await mkdir(path.dirname(target), { recursive: true });
  const raw = target.replace(/\.gz$/, '');
  await rm(raw, { force: true }); // VACUUM INTO refuses to overwrite
  // The path is built by this module, never from user input; quotes are doubled for the SQL literal anyway.
  await client.execute(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  // Compress next to the final name and rename at the end: a snapshot cut short (full disk, a deploy killing the
  // process) must never be left looking like today's finished backup.
  const partial = `${target}.partial`;
  try {
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(partial));
    await rename(partial, target);
  } finally {
    await rm(raw, { force: true });
    await rm(partial, { force: true });
  }
  return (await stat(target)).size;
}

export type BackupFile = { name: string; day: string; bytes: number };

export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupsDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: BackupFile[] = [];
  for (const name of names) {
    const match = NAME.exec(name);
    if (match) files.push({ name, day: match[1], bytes: (await stat(path.join(dir, name))).size });
  }
  return files.sort((a, b) => b.day.localeCompare(a.day));
}

/** Creates today's snapshot if it does not exist yet, then prunes old ones. Safe to call as often as you like. */
export async function ensureDailyBackup(): Promise<'created' | 'exists' | 'unsupported'> {
  if (!backupsSupported()) return 'unsupported';
  const today = athensDay();
  // leftovers of a run that was interrupted: an uncompressed copy or a half-written archive
  for (const name of await readdir(backupsDir()).catch(() => [] as string[])) {
    if (/^shop-\d{4}-\d{2}-\d{2}\.db(\.gz\.partial)?$/.test(name)) await rm(path.join(backupsDir(), name), { force: true });
  }
  const existing = await listBackups();
  if (existing.some((f) => f.day === today)) return 'exists';
  await writeSnapshot(path.join(backupsDir(), `shop-${today}.db.gz`));
  for (const old of (await listBackups()).slice(KEEP)) await rm(path.join(backupsDir(), old.name), { force: true });
  return 'created';
}

/** For the dashboard: the day of the newest snapshot, and whether the daily run is keeping up (today or yesterday). */
export async function backupStatus(): Promise<{ newest: string | null; fresh: boolean }> {
  if (!backupsSupported()) return { newest: null, fresh: true };
  const newest = (await listBackups())[0]?.day ?? null;
  return { newest, fresh: newest !== null && newest >= athensDay(new Date(Date.now() - 36 * 3600 * 1000)) };
}
