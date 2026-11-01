import './env';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expiredPreMigrate, pendingMigrations, preMigrateName, readJournal, verifySnapshotFile } from '../src/lib/pre-migrate';

/*
 * Runs in the Docker CMD BEFORE `db:migrate`:  db:snapshot && db:migrate && db:seed && db:patch && start
 *
 * A snapshot is taken ONLY when migrations are pending (the journal has entries newer than the newest one recorded in the
 * database, drizzle's own rule). If it cannot be taken or does not verify, this script exits 1 and the chain stops: no snapshot,
 * no migration. A start with nothing to migrate, a new database or a remote database never depends on any of it.
 *
 *   SKIP_PREMIGRATE_SNAPSHOT=1   one-off escape hatch: migrate without the snapshot (logged loudly)
 *
 * The file is DATA_DIR/backups/pre-migrate-<time>-<applied>to<total>.db.gz(.enc), encrypted when BACKUP_ENCRYPTION_KEY is set;
 * the newest 5 are kept. Open one with `npm run backup:decrypt`.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL || 'file:./data/shop.db';
  if (!url.startsWith('file:')) {
    console.log('[pre-migrate] hosted database: its provider keeps the copies, nothing to do here.');
    return;
  }
  // before anything opens the database: opening a missing file would create it
  if (!existsSync(path.resolve(url.slice('file:'.length)))) {
    console.log('[pre-migrate] no database file yet (a new install): nothing to protect.');
    return;
  }
  const { client } = await import('../src/lib/db');
  let lastAppliedAt: number | null = null;
  try {
    const rows = (await client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows;
    lastAppliedAt = rows.length ? Number(rows[0]!.created_at) : null;
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) {
      console.log('[pre-migrate] no migrations table yet (a new database): nothing to protect.');
      return;
    }
    throw err;
  }
  if (lastAppliedAt === null) {
    console.log('[pre-migrate] no migration recorded yet (a new database): nothing to protect.');
    return;
  }
  const entries = await readJournal();
  const pending = pendingMigrations(entries, lastAppliedAt);
  if (pending.length === 0) {
    console.log('[pre-migrate] nothing to migrate: no snapshot needed.');
    return;
  }

  // from here on the next step changes the database
  const list = pending.map((e) => e.tag).join(', ');
  if (process.env.SKIP_PREMIGRATE_SNAPSHOT === '1') {
    console.warn(`[pre-migrate] WARNING: ${pending.length} migration(s) pending (${list}) and SKIP_PREMIGRATE_SNAPSHOT=1: migrating WITHOUT a snapshot. Remove the variable after this start.`);
    return;
  }
  const { backupsDir, backupsSupported, writeSnapshot } = await import('../src/lib/backup');
  if (!backupsSupported()) return;
  const name = preMigrateName(new Date(), entries.length - pending.length, entries.length);
  const written = await writeSnapshot(path.join(backupsDir(), name));
  await verifySnapshotFile(written.file, written.encrypted);
  for (const old of expiredPreMigrate(await readdir(backupsDir()))) await rm(path.join(backupsDir(), old), { force: true });
  console.log(`[pre-migrate] ${pending.length} migration(s) pending (${list}). Snapshot ${path.basename(written.file)} written and verified (${written.bytes} bytes${written.encrypted ? ', encrypted' : ''}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[pre-migrate] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.error('[pre-migrate] The migration was NOT run: no snapshot, no migration. Fix the cause (disk space, the volume), or set SKIP_PREMIGRATE_SNAPSHOT=1 for ONE start to migrate without a snapshot.');
    process.exit(1);
  });
