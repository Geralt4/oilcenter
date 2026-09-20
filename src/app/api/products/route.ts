import { NextResponse } from 'next/server';
import { getProductsByIds } from '@/lib/catalog';

/** Product summaries by id — used by the (device-local) wishlist. */
export async function GET(request: Request) {
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 60);
  return NextResponse.json({ products: await getProductsByIds(ids) });
}
