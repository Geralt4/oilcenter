import { asc, eq } from 'drizzle-orm';
import { getAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { brands, products, variants } from '@/lib/db/schema';
import { buildPriceCsv } from '@/lib/price-csv';

/** The price list as a spreadsheet (lib/price-csv.ts); the same file can be uploaded back in Admin → Τιμές. */
export async function GET() {
  if (!(await getAdmin())) return new Response('Unauthorized', { status: 401 });

  const rows = await db
    .select({ v: variants, productName: products.name, brandName: brands.name })
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .leftJoin(brands, eq(products.brandId, brands.id))
    .orderBy(asc(brands.name), asc(products.name), asc(variants.sort));

  const csv = buildPriceCsv(rows.map(({ v, productName, brandName }) => ({ sku: v.sku, brand: brandName, product: productName, pack: v.label, priceCents: v.priceCents, stock: v.stock, trackStock: v.trackStock, priceVerified: v.priceVerified, availability: v.availability })));
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="oilcenter-prices-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' },
  });
}
