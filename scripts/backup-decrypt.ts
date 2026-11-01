import './env';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { decryptBackup } from '../src/lib/backup-crypto';

/*
 * Opens a snapshot that is stored on the volume (DATA_DIR/backups/shop-YYYY-MM-DD.db.gz.enc, or a pre-migrate-….db.gz.enc):
 *   npm run backup:decrypt -- ./shop-2026-11-02.db.gz.enc ./restored/shop.db      → plain SQLite file
 * Needs BACKUP_ENCRYPTION_KEY (the same key as off-site backups; one of the two offline copies, or `railway run -- …`).
 * A copy that is already in B2 is fetched and opened by `npm run backup:pull`.
 */
async function main() {
  const [inArg, outArg] = process.argv.slice(2);
  if (!inArg || !outArg) {
    console.error('Usage: npm run backup:decrypt -- <stored-snapshot.db.gz.enc> <output-file>');
    process.exit(1);
  }
  const out = path.resolve(outArg);
  await mkdir(path.dirname(out), { recursive: true });
  const plain = decryptBackup(await readFile(path.resolve(inArg)));
  if (/\.gz\.enc$/.test(inArg)) {
    const gz = `${out}.gz`;
    await writeFile(gz, plain);
    try {
      await pipeline(createReadStream(gz), createGunzip(), createWriteStream(out));
    } finally {
      await rm(gz, { force: true });
    }
  } else {
    await writeFile(out, plain);
  }
  console.log(`Wrote ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Decrypt failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
