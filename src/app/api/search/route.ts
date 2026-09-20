import { NextResponse } from 'next/server';
import { suggestProducts } from '@/lib/catalog';

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
      minPriceCents: p.minPriceCents,
      multiplePrices: p.minPriceCents !== p.maxPriceCents,
    })),
  });
}
