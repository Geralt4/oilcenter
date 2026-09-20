import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getAdmin } from '@/lib/auth/session';
import { randomToken } from '@/lib/auth/password';
import { backupsDir, backupsSupported, writeSnapshot } from '@/lib/backup';

/** A fresh, gzipped snapshot of the whole database as a download. Admin only: it holds customer details and password hashes. */
export async function GET() {
  if (!(await getAdmin())) return new Response('Unauthorized', { status: 401 });
  if (!backupsSupported()) return new Response('Snapshots are only available for a local SQLite database.', { status: 501 });

  const temp = path.join(backupsDir(), `download-${randomToken(8).toLowerCase()}.db.gz`);
  try {
    await writeSnapshot(temp);
    const body = await readFile(temp);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="oilcenter-backup-${stamp}.db.gz"`, 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' },
    });
  } finally {
    await rm(temp, { force: true });
  }
}
