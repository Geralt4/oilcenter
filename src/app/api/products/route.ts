import { NextResponse } from 'next/server';
import { getProductsByIds } from '@/lib/catalog';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/** Product summaries by id — used by the (device-local) wishlist. */
export async function GET(request: Request) {
  const limited = rateLimit(`products:${await clientIp()}`, 60, 5 * 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 60);
  return NextResponse.json({ products: await getProductsByIds(ids) });
}
