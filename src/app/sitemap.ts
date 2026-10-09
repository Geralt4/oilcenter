import type { MetadataRoute } from 'next';
import { eq } from 'drizzle-orm';
import { getBrands, getCategoryTree, getViscosities, type CategoryNode } from '@/lib/catalog';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { siteUrl } from '@/lib/seo';
import { getSettings } from '@/lib/settings.server';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [tree, brands, viscosities, settings, productRows] = await Promise.all([getCategoryTree(), getBrands(), getViscosities(), getSettings(), db.select({ slug: products.slug, updatedAt: products.updatedAt }).from(products).where(eq(products.isActive, true))]);
  const flat = (nodes: CategoryNode[]): CategoryNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

  return [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/products`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/brands`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/find-my-oil`, changeFrequency: 'yearly', priority: 0.7 },
    ...(settings.storefront.b2bPage ? [{ url: `${base}/professionals`, changeFrequency: 'yearly' as const, priority: 0.6 }] : []),
    { url: `${base}/contact`, changeFrequency: 'yearly', priority: 0.7 },
    { url: `${base}/about`, changeFrequency: 'yearly', priority: 0.6 },
    // the shipping and returns pages exist only while the shop takes online orders (lib/catalogue-mode.ts)
    ...[...(settings.storefront.ordersEnabled ? ['shipping-payments', 'returns'] : []), 'terms', 'privacy', 'cookies'].map((p) => ({ url: `${base}/${p}`, changeFrequency: 'yearly' as const, priority: 0.2 })),
    ...flat(tree).filter((c) => c.productCount > 0).map((c) => ({ url: `${base}/category/${c.slug}`, changeFrequency: 'weekly' as const, priority: 0.8 })),
    ...brands.map((b) => ({ url: `${base}/brand/${b.slug}`, changeFrequency: 'weekly' as const, priority: 0.6 })),
    { url: `${base}/viscosity`, changeFrequency: 'monthly', priority: 0.5 },
    // a grade with a single product is that product's page all over again
    ...viscosities.filter((v) => v.count >= 2).map((v) => ({ url: `${base}/viscosity/${v.slug}`, changeFrequency: 'weekly' as const, priority: 0.7 })),
    ...productRows.map((p) => ({ url: `${base}/product/${p.slug}`, lastModified: p.updatedAt, changeFrequency: 'weekly' as const, priority: 0.7 })),
  ];
}
