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

const MAX_TOKENS = 12;
const TTL_MS = 6 * 60 * 60 * 1000;

export const isUploadKind = (value: string): value is UploadKind => value in UPLOAD_LIMITS;

export const stagingDir = () => path.resolve(process.env.DATA_DIR || './data', 'uploads', '.staging');

/** Stream a request body with a hard byte cap; null when the cap is crossed or the body is unreadable. */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
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
export async function claimUpload(token: string, kind: UploadKind, adminId: number): Promise<{ file: string; originalName: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [row] = await db
    .update(pendingUploads)
    .set({ claimedAt: new Date() })
    .where(and(eq(pendingUploads.token, token), eq(pendingUploads.kind, kind), eq(pendingUploads.adminId, adminId), isNull(pendingUploads.claimedAt), gt(pendingUploads.expiresAt, new Date())))
    .returning({ token: pendingUploads.token, originalName: pendingUploads.originalName });
  if (!row) return null;
  return { file: path.join(stagingDir(), row.token), originalName: row.originalName ?? 'file' };
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

export const MAX_UPLOAD_TOKENS = MAX_TOKENS;
