import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { client, DATABASE_URL } from '@/lib/db';
import { backupKeyConfigured, decryptBackup, ENCRYPTED_SUFFIX, encryptBackup } from '@/lib/backup-crypto';

/*
 * Database snapshots. `VACUUM INTO` writes a consistent copy of the SQLite file while the shop keeps running
 * (copying shop.db by hand would miss whatever still sits in the write-ahead log).
 *
 *   DATA_DIR/backups/shop-2026-09-20.db.gz.enc   one per day, the newest 14 are kept
 *
 * These live on the same disk as the database, so they protect against a bad edit or a corrupted file, NOT against
 * losing the disk. A snapshot holds customer details, password hashes and authenticator secrets, so with BACKUP_ENCRYPTION_KEY
 * set (it always is where off-site backups run) it is encrypted before it is stored: a copy of the volume, a stray file or a
 * leaked listing does not give the data away. Without a key the file stays a plain .db.gz as before: treat it accordingly.
 * Open a stored copy with `npm run backup:decrypt` (backup-crypto.ts has the format).
 *
 * The admin «download a backup» is a plain gzip on purpose (writeSnapshot with encrypt: false): it sits behind the identity
 * confirmation and a rate limit, and the owner can open it himself.
 */

const KEEP = 14;
/** a daily snapshot, stored plain or encrypted */
const DAILY = /^shop-(\d{4}-\d{2}-\d{2})\.db\.gz(\.enc)?$/;
/** snapshots of any kind that older versions of the shop stored in plain: daily, boot / «backup now» (…-HHMMSS) */
const PLAIN_SNAPSHOT = /^(shop-\d{4}-\d{2}-\d{2}(-\d{6})?|pre-migrate-[\w-]+)\.db\.gz$/;

export const backupsDir = () => path.resolve(process.env.DATA_DIR || './data', 'backups');
export const backupsSupported = () => DATABASE_URL.startsWith('file:');

const athensDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(date);

export type WrittenSnapshot = { file: string; bytes: number; encrypted: boolean };

/**
 * Writes a gzipped snapshot for `target` (absolute path ending in .db.gz). With a backup key (and unless `encrypt` is false) the
 * file written is `<target>.enc`; the plain intermediate files exist only while the snapshot is being made and are removed in every
 * case (a run killed half-way leaves them until the next daily run clears them). Returns the file written.
 */
export async function writeSnapshot(target: string, opts: { encrypt?: boolean } = {}): Promise<WrittenSnapshot> {
  if (!backupsSupported()) throw new Error('Snapshots are only available for a local SQLite database.');
  const encrypt = opts.encrypt ?? backupKeyConfigured();
  await mkdir(path.dirname(target), { recursive: true });
  const raw = target.replace(/\.gz$/, '');
  await rm(raw, { force: true }); // VACUUM INTO refuses to overwrite
  // The path is built by this module, never from user input; quotes are doubled for the SQL literal anyway.
  await client.execute(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  // Compress next to the final name and rename at the end: a snapshot cut short (full disk, a deploy killing the
  // process) must never be left looking like today's finished backup.
  const partial = `${target}.partial`;
  const final = encrypt ? `${target}${ENCRYPTED_SUFFIX}` : target;
  const finalPartial = `${final}.partial`;
  try {
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(partial));
    if (encrypt) {
      await writeFile(finalPartial, encryptBackup(await readFile(partial)));
      await rm(partial, { force: true });
      await rename(finalPartial, final);
    } else {
      await rename(partial, final);
    }
  } finally {
    await rm(raw, { force: true });
    await rm(partial, { force: true });
    await rm(finalPartial, { force: true });
  }
  return { file: final, bytes: (await stat(final)).size, encrypted: encrypt };
}

/**
 * Snapshots that an older version stored in plain are encrypted once a key is set: each is sealed, read back from disk and
 * compared with the original, and only then is the plain file removed. A file that cannot be verified stays as it is.
 */
export async function encryptStoredSnapshots(): Promise<{ converted: number; kept: string[] }> {
  const result = { converted: 0, kept: [] as string[] };
  if (!backupKeyConfigured()) return result;
  const dir = backupsDir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!PLAIN_SNAPSHOT.test(name)) continue;
    const plainFile = path.join(dir, name);
    const sealedFile = `${plainFile}${ENCRYPTED_SUFFIX}`;
    try {
      const plain = await readFile(plainFile);
      const existing = await readFile(sealedFile).catch(() => null);
      if (!existing) {
        await writeFile(`${sealedFile}.partial`, encryptBackup(plain));
        await rename(`${sealedFile}.partial`, sealedFile);
      }
      // the check is on what is on disk now, not on what was just computed
      if (!decryptBackup(await readFile(sealedFile)).equals(plain)) throw new Error('the encrypted copy does not decrypt to the original');
      await rm(plainFile, { force: true });
      if (!existing) result.converted++;
    } catch (err) {
      await rm(`${sealedFile}.partial`, { force: true });
      result.kept.push(name);
      console.error(`[backup] could not encrypt the stored snapshot ${name}; it stays as it is: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export type BackupFile = { name: string; day: string; bytes: number; encrypted: boolean };

/** One entry per day, newest first. A day that exists in both forms (a conversion that has not finished) shows the encrypted one. */
export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupsDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const byDay = new Map<string, BackupFile>();
  for (const name of names) {
    const match = DAILY.exec(name);
    if (!match) continue;
    const entry: BackupFile = { name, day: match[1], bytes: (await stat(path.join(dir, name))).size, encrypted: Boolean(match[2]) };
    const known = byDay.get(entry.day);
    if (!known || (entry.encrypted && !known.encrypted)) byDay.set(entry.day, entry);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** Creates today's snapshot if it does not exist yet, then prunes old ones. Safe to call as often as you like. */
export async function ensureDailyBackup(): Promise<'created' | 'exists' | 'unsupported'> {
  if (!backupsSupported()) return 'unsupported';
  const today = athensDay();
  // leftovers of a run that was interrupted: an uncompressed copy or a half-written archive
  for (const name of await readdir(backupsDir()).catch(() => [] as string[])) {
    if (/^shop-\d{4}-\d{2}-\d{2}\.db(\.gz(\.enc)?\.partial)?$/.test(name)) await rm(path.join(backupsDir(), name), { force: true });
  }
  // plain snapshots from before the backup key was set (or before this version) are encrypted first; a failure here never stops the day's backup
  await encryptStoredSnapshots().catch((err) => console.error('[backup] encrypting stored snapshots failed', err instanceof Error ? err.message : err));
  const existing = await listBackups();
  if (existing.some((f) => f.day === today)) return 'exists';
  await writeSnapshot(path.join(backupsDir(), `shop-${today}.db.gz`));
  await pruneDaily();
  return 'created';
}

/** Keeps the newest KEEP days; every file of an older day goes (plain or encrypted). */
async function pruneDaily(): Promise<void> {
  const days = (await listBackups()).map((f) => f.day);
  const old = new Set(days.slice(KEEP));
  for (const name of await readdir(backupsDir()).catch(() => [] as string[])) {
    const match = DAILY.exec(name);
    if (match && old.has(match[1])) await rm(path.join(backupsDir(), name), { force: true });
  }
}

/** For the dashboard: the day of the newest snapshot, and whether the daily run is keeping up (today or yesterday). */
export async function backupStatus(): Promise<{ newest: string | null; fresh: boolean }> {
  if (!backupsSupported()) return { newest: null, fresh: true };
  const newest = (await listBackups())[0]?.day ?? null;
  return { newest, fresh: newest !== null && newest >= athensDay(new Date(Date.now() - 36 * 3600 * 1000)) };
}
