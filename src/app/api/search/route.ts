import { NextResponse } from 'next/server';
import { matchCode, suggestProducts } from '@/lib/catalog';

export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').slice(0, 80);
  if (q.trim().length < 2) return NextResponse.json({ items: [] });
  const products = await suggestProducts(q, 6);
  return NextResponse.json({
    items: products.map((p) => ({
      slug: p.slug,
      name: p.name,
      brandName: p.brand?.name ?? null,
      imageUrl: p.imageUrl,
      // null = no size of this product has a confirmed price yet («Καλέστε για τιμή»)
      minPriceCents: p.hasPrice ? p.minPriceCents : null,
      multiplePrices: p.hasPrice && (p.minPriceCents !== p.maxPriceCents || p.variants.some((v) => !v.priced)),
      // set when the visitor typed a manufacturer code or a barcode: the row then says which size it belongs to
      code: matchCode(p, q),
    })),
  });
}
