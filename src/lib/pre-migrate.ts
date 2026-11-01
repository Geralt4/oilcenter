import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decryptBackup } from '@/lib/backup-crypto';

/*
 * The decisions behind the snapshot taken before pending migrations (scripts/pre-migrate-snapshot.ts, run by the Docker CMD
 * before `db:migrate`). Pure pieces live here so they can be tested without starting anything.
 */

export type JournalEntry = { idx: number; when: number; tag: string };

/** Pre-migration snapshots on the volume, plain or sealed. */
export const PRE_MIGRATE_FILE = /^pre-migrate-[\w-]+\.db\.gz(\.enc)?$/;
export const KEEP_PRE_MIGRATE = 5;

export async function readJournal(folder = './drizzle'): Promise<JournalEntry[]> {
  const journal = JSON.parse(await readFile(path.resolve(folder, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  return journal.entries;
}

/**
 * The migrations `db:migrate` would apply. drizzle's own rule: an entry runs when its timestamp is newer than the newest one
 * recorded in the database (`lastAppliedAt`, null = nothing recorded yet, so everything).
 */
export function pendingMigrations(entries: JournalEntry[], lastAppliedAt: number | null): JournalEntry[] {
  return entries.filter((e) => lastAppliedAt === null || lastAppliedAt < e.when);
}

/** pre-migrate-20261102-101530-23to24.db.gz: the time (UTC), how many migrations were applied, and how many there will be. */
export function preMigrateName(now: Date, applied: number, total: number): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `pre-migrate-${stamp}-${applied}to${total}.db.gz`;
}

/** The files to delete so that only the newest `keep` snapshots stay (a plain and a sealed copy of one snapshot count once). */
export function expiredPreMigrate(names: string[], keep = KEEP_PRE_MIGRATE): string[] {
  const base = (n: string) => n.replace(/\.enc$/, '');
  const bases = [...new Set(names.filter((n) => PRE_MIGRATE_FILE.test(n)).map(base))].sort();
  const old = new Set(bases.slice(0, Math.max(0, bases.length - keep)));
  return names.filter((n) => PRE_MIGRATE_FILE.test(n) && old.has(base(n)));
}

/** Reads the file back: sealed ones are decrypted, then it must be a gzip of a SQLite file. Throws when it is not. */
export async function verifySnapshotFile(file: string, encrypted: boolean): Promise<void> {
  const bytes = await readFile(file);
  if (bytes.length === 0) throw new Error('the snapshot file is empty');
  const gz = encrypted ? decryptBackup(bytes) : bytes;
  const db = gunzipSync(gz);
  if (db.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('the snapshot is not a SQLite database');
}
