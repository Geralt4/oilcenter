import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveCartLines } from '@/lib/catalog';
import { readJsonLimited } from '@/lib/form-size';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const Body = z.object({
  lines: z.array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().positive().max(999) })).max(100),
});

/** Re-prices a browser cart against the database. The response is what the drawer / cart page display. */
export async function POST(request: Request) {
  const limited = rateLimit(`cart:${await clientIp()}`, 60, 5 * 60 * 1000);
  if (!limited.ok) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterSec) } });

  // 100 cart lines cannot legitimately serialise past 32 KB; the cap is enforced while streaming.
  const body = await readJsonLimited(request, 32 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.tooLarge ? 'too_large' : 'invalid_cart' }, { status: body.tooLarge ? 413 : 400 });

  const parsed = Body.safeParse(body.value);
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
              availability: l.availability ?? undefined,
            },
    })),
  });
}
