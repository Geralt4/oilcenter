import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { backupsDir, backupsSupported, writeSnapshot } from '@/lib/backup';

/*
 * Off-site backups to Backblaze B2, encrypted before they leave the machine.
 *
 *   DATA_DIR/backups/shop-YYYY-MM-DD.db.gz          local snapshot (src/lib/backup.ts)
 *   B2: shop-YYYY-MM-DD.db.gz.enc                   encrypted full-database copy, 14 newest kept
 *   B2: shop-YYYY-MM-DD-HHMMSS.db.gz.enc            snapshot taken at boot / «backup now», 7 newest kept
 *   B2: uploads-YYYY-MM-DD.tar.gz.enc               product photos + safety data sheets, newest copy of 14 days kept
 *
 * Encryption: AES-256-GCM (OpenSSL, via node:crypto), random 96-bit nonce per file. File layout:
 *
 *   "OCBK1" | 12-byte nonce | 16-byte GCM tag | ciphertext
 *
 * BACKUP_ENCRYPTION_KEY is a base64 32-byte key. It lives in the Railway variables (the app must encrypt
 * with it) AND in two offline copies (owner + developer) — the app copy is lost with the platform, the
 * offline copies are what make a restore possible after losing everything. The key must NOT be kept in
 * the B2 account: whoever reads the bucket must still not be able to read customer data.
 *
 * The uploader is deliberately dumb: it never deletes a local file, never runs without full configuration,
 * and its failures only log — they must never take the shop down.
 */

const MAGIC = Buffer.from('OCBK1');
const NONCE = 12;
const TAG = 16;

export const offsiteConfigured = () => Boolean(process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET && process.env.BACKUP_ENCRYPTION_KEY);

function encryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes base64 (generate: openssl rand -base64 32)');
  return key;
}

export function encryptBackup(plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
}

export function decryptBackup(sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + NONCE + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Oil Center backup file (magic header missing).');
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE);
  const tag = sealed.subarray(MAGIC.length + NONCE, MAGIC.length + NONCE + TAG);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAuthTag(tag); // authenticated: a flipped byte anywhere fails here, never returns wrong plaintext
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + NONCE + TAG)), decipher.final()]);
}

// ─── Backblaze B2 (native API v2, plain fetch — no SDK) ─────────────────────
type B2Auth = { apiUrl: string; authorizationToken: string; accountId: string };

async function b2Call<T>(auth: B2Auth, operation: string, body: unknown): Promise<T> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/${operation}`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`B2 ${operation} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function b2Auth(): Promise<B2Auth> {
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', { headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) throw new Error(`B2 authorize failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { apiUrl: string; authorizationToken: string; accountId: string };
  return { apiUrl: json.apiUrl, authorizationToken: json.authorizationToken, accountId: json.accountId };
}

async function b2BucketId(auth: B2Auth): Promise<string> {
  const res = await b2Call<{ buckets: Array<{ bucketId: string; bucketName: string }> }>(auth, 'b2_list_buckets', { accountId: auth.accountId, bucketName: process.env.B2_BUCKET });
  const bucket = res.buckets.find((b) => b.bucketName === process.env.B2_BUCKET);
  if (!bucket) throw new Error(`B2 bucket "${process.env.B2_BUCKET}" not found for this application key.`);
  return bucket.bucketId;
}

async function b2Upload(auth: B2Auth, bucketId: string, name: string, data: Buffer): Promise<void> {
  const { uploadUrl, authorizationToken } = await b2Call<{ uploadUrl: string; authorizationToken: string }>(auth, 'b2_get_upload_url', { bucketId });
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(name),
      'Content-Type': 'application/octet-stream',
      'X-Bz-Content-Sha1': createHash('sha1').update(data).digest('hex'),
    },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`B2 upload ${name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function b2List(auth: B2Auth, bucketId: string, prefix: string): Promise<Array<{ fileName: string; fileId: string }>> {
  const out: Array<{ fileName: string; fileId: string }> = [];
  let startFileName: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await b2Call<{ files: Array<{ fileName: string; fileId: string }>; nextFileName: string | null }>(auth, 'b2_list_file_names', {
      bucketId, prefix, maxFileCount: 1000, ...(startFileName ? { startFileName } : {}),
    });
    out.push(...res.files.map((f) => ({ fileName: f.fileName, fileId: f.fileId })));
    if (!res.nextFileName) break;
    startFileName = res.nextFileName;
  }
  return out;
}

type RemoteVersion = { fileName: string; fileId: string; uploadTimestamp: number };

/** Every VERSION (not only the latest name) — B2 keeps old versions, and leaving them would defeat retention. */
async function b2ListVersions(auth: B2Auth, bucketId: string, prefix: string): Promise<RemoteVersion[]> {
  const out: RemoteVersion[] = [];
  let startFileName: string | undefined;
  let startFileId: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await b2Call<{ files: RemoteVersion[]; nextFileName: string | null; nextFileId: string | null }>(auth, 'b2_list_file_versions', {
      bucketId, prefix, maxFileCount: 1000, ...(startFileName && startFileId ? { startFileName, startFileId } : {}),
    });
    out.push(...res.files.map((f) => ({ fileName: f.fileName, fileId: f.fileId, uploadTimestamp: f.uploadTimestamp })));
    if (!res.nextFileName || !res.nextFileId) break;
    startFileName = res.nextFileName;
    startFileId = res.nextFileId;
  }
  return out;
}

/** Newest-first keep of VERSIONS in one family; returns the ones to delete. Pure, so it is tested. */
export function expiredVersions<T extends { fileName: string; uploadTimestamp: number }>(versions: T[], prefix: string, keep: number): T[] {
  return versions
    .filter((v) => v.fileName.startsWith(prefix) && v.fileName.endsWith('.enc'))
    .sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
    .slice(keep);
}

/**
 * Keep the newest version of the newest `keepNames` file names in one family; returns the versions to delete. Every boot
 * re-uploads the day's archive under the same name, so counting versions instead of names would let a few deploys push
 * the older days out of the retention window.
 */
export function expiredPerName<T extends { fileName: string; uploadTimestamp: number }>(versions: T[], prefix: string, keepNames: number): T[] {
  const kept = new Set<string>();
  const doomed: T[] = [];
  for (const v of versions.filter((v) => v.fileName.startsWith(prefix) && v.fileName.endsWith('.enc')).sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)) {
    if (!kept.has(v.fileName) && kept.size < keepNames) kept.add(v.fileName);
    else doomed.push(v);
  }
  return doomed;
}

/** What pruneRemote deletes. Pure, so it is tested. Boot snapshots (shop-YYYY-MM-DD-HHMMSS) never count against the daily copies. */
export function expiredBackups<T extends { fileName: string; uploadTimestamp: number }>(versions: T[]): T[] {
  const daily = versions.filter((v) => /^shop-\d{4}-\d{2}-\d{2}\.db\.gz\.enc$/.test(v.fileName));
  const boot = versions.filter((v) => /^shop-\d{4}-\d{2}-\d{2}-\d{6}\.db\.gz\.enc$/.test(v.fileName));
  return [...expiredVersions(daily, 'shop-', KEEP_DB), ...expiredVersions(boot, 'shop-', KEEP_BOOT_DB), ...expiredPerName(versions, 'uploads-', KEEP_UPLOADS)];
}

async function pruneRemote(auth: B2Auth, bucketId: string): Promise<void> {
  const versions = await b2ListVersions(auth, bucketId, '');
  const doomed = expiredBackups(versions);
  for (const v of doomed) await b2Call(auth, 'b2_delete_file_version', { fileName: v.fileName, fileId: v.fileId });
}

// ─── Retention (pure, so it can be tested without B2) ───────────────────────
/** Newest-first keep of `names` matching `prefix…suffix`: returns the ones that must be DELETED. */
export function expired(names: string[], prefix: string, suffix: string, keep: number): string[] {
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
    .sort((a, b) => b.localeCompare(a)) // ISO dates sort lexicographically
    .slice(keep);
}

// ─── Orchestration ──────────────────────────────────────────────────────────
type OffsiteStatus = { at: number; ok: boolean; object: string | null; error?: string };
const statusFile = () => path.join(backupsDir(), 'offsite.json');
const exec = promisify(execFile);
let running = false;

async function writeStatus(status: OffsiteStatus): Promise<void> {
  await mkdir(backupsDir(), { recursive: true });
  await writeFile(statusFile(), JSON.stringify(status)).catch(() => undefined);
}

export async function offsiteStatus(): Promise<OffsiteStatus | null> {
  try {
    return JSON.parse(await readFile(statusFile(), 'utf8')) as OffsiteStatus;
  } catch {
    return null;
  }
}

/** Fresh = a successful upload within the last 36 h (one missed nightly run is tolerated, two are not). */
export function offsiteIsFresh(status: OffsiteStatus | null): boolean {
  return Boolean(status?.ok && Date.now() - status.at < 36 * 3600 * 1000);
}

/** Newest local database snapshot, if any. */
async function newestLocalSnapshot(): Promise<{ name: string; file: string } | null> {
  const names = (await readdir(backupsDir()).catch(() => [] as string[])).filter((n) => /^shop-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(n)).sort();
  const name = names.at(-1);
  return name ? { name, file: path.join(backupsDir(), name) } : null;
}

/** Photos + SDS as one tarball. Returns null when there is nothing to archive. */
async function packUploads(): Promise<{ name: string; file: string } | null> {
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const uploads = path.join(dataDir, 'uploads');
  if ((await readdir(uploads).catch(() => [] as string[])).length === 0) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
  const name = `uploads-${day}.tar.gz`;
  const file = path.join(backupsDir(), name);
  await mkdir(backupsDir(), { recursive: true });
  try {
    // tar is essential in Debian (node:*-slim includes it). gzip inside tar keeps this dependency-free.
    await exec('tar', ['-C', dataDir, '-czf', file, 'uploads']);
    return { name, file };
  } catch (err) {
    await rm(file, { force: true });
    throw new Error(`Could not pack uploads/ into ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const KEEP_DB = 14;
// snapshots written at boot / «backup now» (same count as the local copies kept in pushSnapshotNow)
const KEEP_BOOT_DB = 7;
// Days kept equal to the database count: a database snapshot without its matching uploads archive is not a
// complete recovery set (photos and SDS files live only on the volume).
const KEEP_UPLOADS = 14;

/**
 * Uploads today's snapshot(s) that are not off-site yet and prunes old remote copies.
 * Safe to call hourly; does nothing when unconfigured or when today's object already exists.
 */
export async function ensureOffsiteBackup(): Promise<'uploaded' | 'exists' | 'unconfigured' | 'no-snapshot'> {
  if (!offsiteConfigured() || !backupsSupported()) return 'unconfigured';
  if (running) return 'exists';
  running = true;
  try {
    const auth = await b2Auth();
    const bucketId = await b2BucketId(auth);
    const remote = await b2List(auth, bucketId, '');

    const snapshot = await newestLocalSnapshot();
    if (!snapshot) return 'no-snapshot';
    const dbObject = `${snapshot.name}.enc`;
    let uploaded = false;
    if (!remote.some((f) => f.fileName === dbObject)) {
      await b2Upload(auth, bucketId, dbObject, encryptBackup(await readFile(snapshot.file)));
      uploaded = true;
    }

    // today's uploads archive: only packed when the day's object is not off-site yet
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
    const uploadsObject = `uploads-${day}.tar.gz.enc`;
    if (!remote.some((f) => f.fileName === uploadsObject)) {
      const pack = await packUploads();
      if (pack) {
        await b2Upload(auth, bucketId, uploadsObject, encryptBackup(await readFile(pack.file)));
        uploaded = true;
        // the local tarball exists only for this upload; the local disk keeps the DB snapshots only
        await rm(pack.file, { force: true });
      }
    }

    // retention: newest versions first, keep N per family, delete the rest (B2 keeps every upload as a version)
    await pruneRemote(auth, bucketId);

    if (uploaded) await writeStatus({ at: Date.now(), ok: true, object: dbObject });
    return uploaded ? 'uploaded' : 'exists';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeStatus({ at: Date.now(), ok: false, object: null, error: message.slice(0, 500) });
    throw err;
  } finally {
    running = false;
  }
}

/**
 * The explicit "backup now" path. Unlike ensureOffsiteBackup(), it never reuses an existing snapshot:
 * it writes a NEW uniquely named snapshot (…-HHMMSS.db.gz), uploads exactly that file, prunes versions
 * and records the result. Used after setup changes so the recovery point includes them.
 */
export async function pushSnapshotNow(): Promise<{ object: string }> {
  if (!offsiteConfigured()) throw new Error('Off-site backups are not configured.');
  if (!backupsSupported()) throw new Error('Snapshots are only available for a local SQLite database.');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const name = `shop-${day}-${time}.db.gz`;
  const file = path.join(backupsDir(), name);
  await writeSnapshot(file);
  try {
    const auth = await b2Auth();
    const bucketId = await b2BucketId(auth);
    const object = `${name}.enc`;
    await b2Upload(auth, bucketId, object, encryptBackup(await readFile(file)));
    // A database snapshot without its matching files is not a complete recovery set: refresh the uploads
    // archive in the same run (same object name, new version — pruning understands versions).
    const pack = await packUploads();
    if (pack) {
      await b2Upload(auth, bucketId, `${pack.name}.enc`, encryptBackup(await readFile(pack.file)));
      await rm(pack.file, { force: true });
    }
    await pruneRemote(auth, bucketId);
    await writeStatus({ at: Date.now(), ok: true, object });
    // keep the local manual snapshots bounded too
    const manual = (await readdir(backupsDir())).filter((n) => /^shop-\d{4}-\d{2}-\d{2}-\d{6}\.db\.gz$/.test(n)).sort();
    for (const old of manual.slice(0, Math.max(0, manual.length - 7))) await rm(path.join(backupsDir(), old), { force: true });
    return { object };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeStatus({ at: Date.now(), ok: false, object: null, error: message.slice(0, 500) });
    throw err;
  }
}
