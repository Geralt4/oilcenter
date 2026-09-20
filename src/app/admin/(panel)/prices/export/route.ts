import { asc, eq } from 'drizzle-orm';
import { getAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { brands, products, variants } from '@/lib/db/schema';

/** sku;brand;product;pack;price;stock;verified — semicolon + BOM so Greek Excel opens it correctly on double-click. */
export async function GET() {
  if (!(await getAdmin())) return new Response('Unauthorized', { status: 401 });

  const rows = await db
    .select({ v: variants, productName: products.name, brandName: brands.name })
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .leftJoin(brands, eq(products.brandId, brands.id))
    .orderBy(asc(brands.name), asc(products.name), asc(variants.sort));

  const cell = (value: string | number | null) => {
    const s = String(value ?? '');
    // neutralise spreadsheet formula injection, then quote
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    ['sku', 'brand', 'product', 'pack', 'price', 'stock', 'verified'].join(';'),
    ...rows.map(({ v, productName, brandName }) => [v.sku, brandName, productName, v.label, (v.priceCents / 100).toFixed(2).replace('.', ','), v.trackStock ? v.stock : '', v.priceVerified ? 'yes' : 'no'].map(cell).join(';')),
  ];
  return new Response(`﻿${lines.join('\r\n')}`, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="oilcenter-prices-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' },
  });
}
