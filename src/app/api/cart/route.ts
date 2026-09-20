import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveCartLines } from '@/lib/catalog';

const Body = z.object({
  lines: z.array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().positive().max(999) })).max(100),
});

/** Re-prices a browser cart against the database. The response is what the drawer / cart page display. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_cart' }, { status: 400 });

  const resolved = await resolveCartLines(parsed.data.lines);
  return NextResponse.json({
    lines: resolved.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      issue: l.issue,
      snapshot:
        l.issue === 'unavailable'
          ? null
          : {
              productId: l.productId,
              slug: l.slug,
              name: l.name,
              brandName: l.brandName,
              variantLabel: l.variantLabel,
              imageUrl: l.imageUrl,
              unitPriceCents: l.unitPriceCents,
              weightGrams: l.unitWeightGrams,
              maxQuantity: l.maxQuantity,
            },
    })),
  });
}
