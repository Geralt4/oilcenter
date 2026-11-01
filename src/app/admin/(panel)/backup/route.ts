import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { redirect } from 'next/navigation';
import { getAdmin, hasSudoSession } from '@/lib/auth/session';
import { randomToken } from '@/lib/auth/password';
import { backupsDir, backupsSupported, writeSnapshot } from '@/lib/backup';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * A fresh, gzipped snapshot of the whole database as a download. It holds customer details, password
 * hashes and authenticator secrets, so a logged-in session alone is not enough: the administrator must
 * have re-entered password + code within the last five minutes, in THIS session.
 */
export async function GET() {
  const admin = await getAdmin();
  if (!admin) return new Response('Unauthorized', { status: 401 });
  if (!(await hasSudoSession())) redirect('/admin/settings?sudo=1');
  const limited = await rateLimit(`admin-download:${await clientIp()}:${admin.id}`, 5, 10 * 60 * 1000);
  if (!limited.ok) return new Response('Too many download attempts. Try again later.', { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });
  if (!backupsSupported()) return new Response('Snapshots are only available for a local SQLite database.', { status: 501 });

  const temp = path.join(backupsDir(), `download-${randomToken(8).toLowerCase()}.db.gz`);
  try {
    // the download stays a plain gzip: it sits behind the identity confirmation, and the owner opens it himself
    await writeSnapshot(temp, { encrypt: false });
    const body = await readFile(temp);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="oilcenter-backup-${stamp}.db.gz"`, 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' },
    });
  } finally {
    await rm(temp, { force: true });
  }
}
