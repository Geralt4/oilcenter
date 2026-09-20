import { asc } from 'drizzle-orm';
import { getAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { launchSignups } from '@/lib/db/schema';

/** email;date — the people to notify when online ordering opens. Semicolon + BOM so Greek Excel opens it on double-click. */
export async function GET() {
  if (!(await getAdmin())) return new Response('Unauthorized', { status: 401 });
  const rows = await db.select().from(launchSignups).orderBy(asc(launchSignups.createdAt));
  const lines = ['email;date', ...rows.map((r) => `${r.email};${r.createdAt.toISOString().slice(0, 10)}`)];
  return new Response(`﻿${lines.join('\r\n')}`, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="oilcenter-notify-list-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' },
  });
}
