import './env';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { decryptBackup } from '../src/lib/backup-offsite';

/*
 * Restore helper — download one encrypted object from B2, decrypt it and write the plain file.
 *   npm run backup:pull -- shop-2026-10-17.db.gz.enc ./restored/shop.db           → plain SQLite file
 *   npm run backup:pull -- uploads-2026-10-17.tar.gz.enc ./restored/uploads.tar   → plain tar
 *
 * Needs the same B2_* variables as the uploader AND BACKUP_ENCRYPTION_KEY — i.e. one of the two
 * offline copies of the key. Steps for a full restore are in README → "Off-site backups".
 */
async function b2Download(name: string): Promise<Buffer> {
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', { headers: { Authorization: `Basic ${basic}` } });
  if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status}`);
  const auth = (await authRes.json()) as { authorizationToken: string; downloadUrl: string };

  // b2_download_file_by_name lives on the download host, not the API host
  const url = `${auth.downloadUrl}/file/${encodeURIComponent(process.env.B2_BUCKET ?? '')}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Authorization: auth.authorizationToken } });
  if (!res.ok) throw new Error(`B2 download failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const [name, outArg] = process.argv.slice(2);
  if (!name || !outArg) {
    console.error('Usage: npm run backup:pull -- <object-name> <output-file>');
    process.exit(1);
  }
  const out = path.resolve(outArg);
  await mkdir(path.dirname(out), { recursive: true });
  const sealed = await b2Download(name);
  const plain = decryptBackup(sealed);
  if (name.endsWith('.gz.enc')) {
    const gz = `${out}.gz`;
    await writeFile(gz, plain);
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(out));
    const { rm } = await import('node:fs/promises');
    await rm(gz, { force: true });
  } else {
    await writeFile(out, plain);
  }
  console.log(`Wrote ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Restore failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
