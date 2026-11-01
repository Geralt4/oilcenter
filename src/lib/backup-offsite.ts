import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { backupsDir, backupsSupported, writeSnapshot } from '@/lib/backup';
import { decryptBackup, ENCRYPTED_SUFFIX, encryptBackup } from '@/lib/backup-crypto';

/*
 * Off-site backups to Backblaze B2, encrypted before they leave the machine.
 *
 *   DATA_DIR/backups/shop-YYYY-MM-DD.db.gz.enc      local snapshot, encrypted with the same key (src/lib/backup.ts); a plain .db.gz only without a key
 *   B2: shop-YYYY-MM-DD.db.gz.enc                   encrypted full-database copy, 14 newest kept
 *   B2: shop-YYYY-MM-DD-HHMMSS.db.gz.enc            snapshot taken at boot / «backup now», 7 newest kept
 *   B2: uploads-YYYY-MM-DD.tar.gz.enc               product photos + safety data sheets, newest copy of 14 days kept
 *
 * Encryption: see backup-crypto.ts. The key must NOT be kept in the B2 account: whoever reads the bucket must still not be able to read customer data.
 *
 * The uploader is deliberately dumb: it never deletes a local file, never runs without full configuration,
 * and its failures only log — they must never take the shop down. Every B2 call has a deadline (offsiteLimits), so a
 * hung connection fails the run instead of freezing it; a run that is still marked as running after offsiteLimits.staleMs
 * is taken for dead.
 */

export const offsiteConfigured = () => Boolean(process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET && process.env.BACKUP_ENCRYPTION_KEY);

// the encryption itself lives in backup-crypto.ts (shared with the copies stored on the volume); re-exported for the restore script and the tests
export { decryptBackup, encryptBackup };

// ─── Backblaze B2 (native API v2, plain fetch — no SDK) ─────────────────────
/** Which part of a run a B2 failure belongs to. Named in the error message, so the one log line says where it went wrong. */
export type OffsiteStep = 'authorize' | 'bucket' | 'list' | 'upload URL' | 'upload' | 'cleanup';

export class B2Error extends Error {
  constructor(readonly step: OffsiteStep, readonly timedOut: boolean, message: string) {
    super(message);
    this.name = 'B2Error';
  }
}

/**
 * Limits in milliseconds. Read at call time (and mutable) so that a test can shorten them; production never changes them.
 *   callMs         every call except the upload: B2's API answers in well under 2 s, 30 s only ends a hang
 *   uploadBaseMs + uploadPerMibMs per MiB of body, capped at uploadMaxMs: a floor of about 2 Mbit/s, ten times slower than usual
 *   staleMs        a run marked as running for longer than this is taken for dead (see ensureOffsiteBackup)
 */
export const offsiteLimits = { callMs: 30_000, uploadBaseMs: 60_000, uploadPerMibMs: 4_000, uploadMaxMs: 30 * 60_000, staleMs: 2 * 60 * 60_000 };

export function uploadTimeoutMs(bytes: number): number {
  return Math.min(offsiteLimits.uploadMaxMs, offsiteLimits.uploadBaseMs + Math.ceil(bytes / (1024 * 1024)) * offsiteLimits.uploadPerMibMs);
}

const duration = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/**
 * One B2 round trip: the request AND reading the answer share one deadline, so a call that connects and then stalls is cut off too.
 * Returns the body text of a 2xx answer; a timeout, a network error or a non-2xx status becomes a B2Error that names the step.
 */
async function b2Request(step: OffsiteStep, url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new B2Error(step, true, `B2 ${step} timed out after ${duration(timeoutMs)}`);
    throw new B2Error(step, false, `B2 ${step} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new B2Error(step, false, `B2 ${step} failed: ${res.status} ${text.slice(0, 300)}`);
  return text;
}

function parseJson<T>(step: OffsiteStep, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new B2Error(step, false, `B2 ${step} failed: the answer was not JSON`);
  }
}

type B2Auth = { apiUrl: string; authorizationToken: string; accountId: string };

async function b2Call<T>(auth: B2Auth, step: OffsiteStep, operation: string, body: unknown): Promise<T> {
  const text = await b2Request(step, `${auth.apiUrl}/b2api/v2/${operation}`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, offsiteLimits.callMs);
  return parseJson<T>(step, text);
}

async function b2Auth(): Promise<B2Auth> {
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
  const text = await b2Request('authorize', 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account', { headers: { Authorization: `Basic ${basic}` } }, offsiteLimits.callMs);
  const json = parseJson<{ apiUrl: string; authorizationToken: string; accountId: string }>('authorize', text);
  return { apiUrl: json.apiUrl, authorizationToken: json.authorizationToken, accountId: json.accountId };
}

async function b2BucketId(auth: B2Auth): Promise<string> {
  const res = await b2Call<{ buckets: Array<{ bucketId: string; bucketName: string }> }>(auth, 'bucket', 'b2_list_buckets', { accountId: auth.accountId, bucketName: process.env.B2_BUCKET });
  const bucket = res.buckets.find((b) => b.bucketName === process.env.B2_BUCKET);
  if (!bucket) throw new Error(`B2 bucket "${process.env.B2_BUCKET}" not found for this application key.`);
  return bucket.bucketId;
}

async function b2Upload(auth: B2Auth, bucketId: string, name: string, data: Buffer): Promise<void> {
  const { uploadUrl, authorizationToken } = await b2Call<{ uploadUrl: string; authorizationToken: string }>(auth, 'upload URL', 'b2_get_upload_url', { bucketId });
  await b2Request('upload', uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(name),
      'Content-Type': 'application/octet-stream',
      'X-Bz-Content-Sha1': createHash('sha1').update(data).digest('hex'),
    },
    body: new Uint8Array(data),
  }, uploadTimeoutMs(data.length));
}

async function b2List(auth: B2Auth, bucketId: string, prefix: string): Promise<Array<{ fileName: string; fileId: string }>> {
  const out: Array<{ fileName: string; fileId: string }> = [];
  let startFileName: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await b2Call<{ files: Array<{ fileName: string; fileId: string }>; nextFileName: string | null }>(auth, 'list', 'b2_list_file_names', {
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
    const res = await b2Call<{ files: RemoteVersion[]; nextFileName: string | null; nextFileId: string | null }>(auth, 'cleanup', 'b2_list_file_versions', {
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
  for (const v of doomed) await b2Call(auth, 'cleanup', 'b2_delete_file_version', { fileName: v.fileName, fileId: v.fileId });
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
/** `at` is the last attempt that wrote a status; `lastOkAt` is the last successful upload, kept through failures. */
export type OffsiteStatus = { at: number; ok: boolean; object: string | null; error?: string; lastOkAt?: number };
const statusFile = () => path.join(backupsDir(), 'offsite.json');
const exec = promisify(execFile);
// When the run that is working now started (null = none), and a number per run so that a run taken for dead cannot end its successor.
let runningSince: number | null = null;
let lastRun = 0;

async function writeStatus(status: OffsiteStatus): Promise<void> {
  const previous = await offsiteStatus();
  const lastOkAt = status.ok ? status.at : (previous?.lastOkAt ?? (previous?.ok ? previous.at : undefined));
  await mkdir(backupsDir(), { recursive: true });
  await writeFile(statusFile(), JSON.stringify({ ...status, ...(lastOkAt !== undefined ? { lastOkAt } : {}) })).catch(() => undefined);
}

export async function offsiteStatus(): Promise<OffsiteStatus | null> {
  try {
    return JSON.parse(await readFile(statusFile(), 'utf8')) as OffsiteStatus;
  } catch {
    return null;
  }
}

/** When the newest successful upload happened, also when a later attempt failed. Files written before `lastOkAt` existed still read right. */
export function lastOffsiteSuccess(status: OffsiteStatus | null): number | null {
  return status?.lastOkAt ?? (status?.ok ? status.at : null);
}

/**
 * Fresh = a successful upload within the last 26 h. The night's copy is made by the first hourly run after midnight, so
 * successes are about 24 h apart; 26 h only trips when two hourly runs in a row have failed.
 */
export function offsiteIsFresh(status: OffsiteStatus | null): boolean {
  const last = lastOffsiteSuccess(status);
  return last !== null && Date.now() - last < 26 * 3600 * 1000;
}

/**
 * Newest local daily database snapshot, if any. `encrypted`: the file on the volume is already sealed with the backup key, so it is
 * uploaded as it is (sealing it again would make a file only a double decryption could open). The B2 name is the same either way.
 */
async function newestLocalSnapshot(): Promise<{ name: string; file: string; encrypted: boolean; object: string } | null> {
  // '.db.gz' sorts before '.db.gz.enc' of the same day, so the sealed copy wins when both exist
  const names = (await readdir(backupsDir()).catch(() => [] as string[])).filter((n) => /^shop-\d{4}-\d{2}-\d{2}\.db\.gz(\.enc)?$/.test(n)).sort();
  const name = names.at(-1);
  if (!name) return null;
  const encrypted = name.endsWith(ENCRYPTED_SUFFIX);
  return { name, file: path.join(backupsDir(), name), encrypted, object: encrypted ? name : `${name}${ENCRYPTED_SUFFIX}` };
}

/** What goes to B2 for a local snapshot file: the bytes as stored if they are sealed already, else sealed now. */
async function sealedBytes(file: string, alreadyEncrypted: boolean): Promise<Buffer> {
  const bytes = await readFile(file);
  return alreadyEncrypted ? bytes : encryptBackup(bytes);
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
  if (runningSince !== null) {
    const age = Date.now() - runningSince;
    if (age < offsiteLimits.staleMs) return 'exists';
    // every B2 call has a deadline, so a run this old is stuck somewhere else (tar, the disk): do not let it block the backups for good
    console.warn(`[backup] an off-site run has been marked as running for ${Math.round(age / 60_000)} min (limit ${Math.round(offsiteLimits.staleMs / 60_000)} min) — treating it as dead and starting a new one`);
  }
  const thisRun = ++lastRun;
  runningSince = Date.now();
  try {
    const auth = await b2Auth();
    const bucketId = await b2BucketId(auth);
    const remote = await b2List(auth, bucketId, '');

    const snapshot = await newestLocalSnapshot();
    if (!snapshot) return 'no-snapshot';
    const dbObject = snapshot.object;
    let uploaded = false;
    if (!remote.some((f) => f.fileName === dbObject)) {
      await b2Upload(auth, bucketId, dbObject, await sealedBytes(snapshot.file, snapshot.encrypted));
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
    if (lastRun === thisRun) runningSince = null;
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
  const written = await writeSnapshot(path.join(backupsDir(), name));
  try {
    const auth = await b2Auth();
    const bucketId = await b2BucketId(auth);
    const object = `${name}${ENCRYPTED_SUFFIX}`;
    await b2Upload(auth, bucketId, object, await sealedBytes(written.file, written.encrypted));
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
    const manual = (await readdir(backupsDir())).filter((n) => /^shop-\d{4}-\d{2}-\d{2}-\d{6}\.db\.gz(\.enc)?$/.test(n)).sort();
    for (const old of manual.slice(0, Math.max(0, manual.length - 7))) await rm(path.join(backupsDir(), old), { force: true });
    return { object };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeStatus({ at: Date.now(), ok: false, object: null, error: message.slice(0, 500) });
    throw err;
  }
}
