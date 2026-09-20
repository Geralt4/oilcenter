import { NextResponse } from 'next/server';
import { count } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/** Liveness + database check for the hosting platform's health probe. Reveals nothing sensitive. */
export async function GET() {
  try {
    const [{ n }] = await db.select({ n: count() }).from(products);
    return NextResponse.json({ ok: true, products: n }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
