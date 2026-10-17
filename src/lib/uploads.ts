import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { pendingUploads } from '@/lib/db/schema';
import { randomToken } from '@/lib/auth/password';

/*
 * Staged uploads.
 *
 * Large files (phone photos, SDS PDFs, CSV imports) no longer travel through ordinary server actions:
 * they go to /api/admin/upload, which authenticates first and enforces a streamed byte cap. The route
 * stores the bytes under DATA_DIR/uploads/.staging and returns an opaque, single-use token bound to the
 * administrator and file kind. A save/import action CLAIMS the token (atomic UPDATE), moves the file
 * into its final place and records it. Expired or abandoned tokens are swept hourly.
 */

export type UploadKind = 'photo' | 'sds' | 'price-csv' | 'code-csv';

export const UPLOAD_LIMITS: Record<UploadKind, number> = {
  photo: 20 * 1024 * 1024,
  sds: 10 * 1024 * 1024,
  'price-csv': 2 * 1024 * 1024,
  'code-csv': 2 * 1024 * 1024,
};

const KINDS = Object.keys(UPLOAD_LIMITS) as UploadKind[];
const TTL_MS = 6 * 60 * 60 * 1000;

/** Own-property allowlist — `in` would also accept inherited names such as "toString". */
export const isUploadKind = (value: string): value is UploadKind => (KINDS as string[]).includes(value);

export const uploadLimit = (kind: UploadKind): number => {
  const value = Object.hasOwn(UPLOAD_LIMITS, kind) ? UPLOAD_LIMITS[kind] : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Same-origin/CSRF guard for the upload endpoint (which is intentionally outside the proxy). */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser client; authentication is still required
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

export const stagingDir = () => path.resolve(process.env.DATA_DIR || './data', 'uploads', '.staging');

/** Stream a request body with a hard byte cap and a deadline; null when either is crossed. */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number, deadlineMs = 60_000): Promise<Buffer | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > deadlineMs) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/** Store bytes in the staging area and register their single-use token. */
export async function stageUpload(adminId: number, kind: UploadKind, originalName: string, data: Buffer): Promise<string> {
  const token = randomToken(18);
  await mkdir(stagingDir(), { recursive: true });
  await writeFile(path.join(stagingDir(), token), data, { mode: 0o600 });
  await db.insert(pendingUploads).values({
    token,
    adminId,
    kind,
    originalName: originalName.slice(0, 160),
    bytes: data.byteLength,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return token;
}

/**
 * Atomically claim a token. Returns the staged file path, or null when the token is unknown, expired,
 * already claimed, of another kind, or belongs to another administrator. The UPDATE ... WHERE is the
 * whole check: two concurrent saves cannot both claim the same upload.
 */
export async function claimUpload(token: string, kind: UploadKind, adminId: number): Promise<{ token: string; file: string; originalName: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [row] = await db
    .update(pendingUploads)
    .set({ claimedAt: new Date() })
    .where(and(eq(pendingUploads.token, token), eq(pendingUploads.kind, kind), eq(pendingUploads.adminId, adminId), isNull(pendingUploads.claimedAt), gt(pendingUploads.expiresAt, new Date())))
    .returning({ token: pendingUploads.token, originalName: pendingUploads.originalName });
  if (!row) return null;
  return { token: row.token, file: path.join(stagingDir(), row.token), originalName: row.originalName ?? 'file' };
}

/**
 * Hand a claimed upload back so a failed save can be retried. `file` is moved back to staging when
 * it had already been moved into its final place (photos/SDS). The token becomes claimable again
 * until its original expiry.
 */
export async function releaseUpload(token: string, file?: string): Promise<void> {
  if (file) await rename(file, path.join(stagingDir(), token)).catch(() => undefined);
  await db.update(pendingUploads).set({ claimedAt: null }).where(eq(pendingUploads.token, token)).catch(() => undefined);
}

/** CSV imports read the staged bytes in place; on success the row and file are removed for good. */
export async function finishUpload(token: string): Promise<void> {
  await rm(path.join(stagingDir(), token), { force: true }).catch(() => undefined);
  await db.delete(pendingUploads).where(eq(pendingUploads.token, token)).catch(() => undefined);
}

/** Move a claimed staged file to its final destination (same filesystem: rename, no copy). */
export async function moveClaimed(file: string, destDir: string, name: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const target = path.join(destDir, name);
  await rename(file, target);
  return target;
}

export async function discardStaged(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined);
}

/** Hourly housekeeping: remove expired/old staging rows and their bytes. Never touches claimed-and-moved files. */
export async function sweepStaging(): Promise<void> {
  const cutoff = new Date(Date.now() - TTL_MS);
  const rows = await db
    .select({ token: pendingUploads.token })
    .from(pendingUploads)
    .where(or(lt(pendingUploads.expiresAt, new Date()), lt(pendingUploads.createdAt, cutoff)))
    .limit(200);
  for (const row of rows) {
    await rm(path.join(stagingDir(), row.token), { force: true }).catch(() => undefined);
    await db.delete(pendingUploads).where(eq(pendingUploads.token, row.token));
  }
}

export async function readStagedText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
