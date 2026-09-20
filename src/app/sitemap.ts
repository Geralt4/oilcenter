import type { MetadataRoute } from 'next';
import { eq } from 'drizzle-orm';
import { getBrands, getCategoryTree, type CategoryNode } from '@/lib/catalog';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { siteUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [tree, brands, productRows] = await Promise.all([getCategoryTree(), getBrands(), db.select({ slug: products.slug, updatedAt: products.updatedAt }).from(products).where(eq(products.isActive, true))]);
  const flat = (nodes: CategoryNode[]): CategoryNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

  return [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/products`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/brands`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/contact`, changeFrequency: 'yearly', priority: 0.7 },
    { url: `${base}/about`, changeFrequency: 'yearly', priority: 0.6 },
    ...['shipping-payments', 'returns', 'terms', 'privacy', 'cookies'].map((p) => ({ url: `${base}/${p}`, changeFrequency: 'yearly' as const, priority: 0.2 })),
    ...flat(tree).filter((c) => c.productCount > 0).map((c) => ({ url: `${base}/category/${c.slug}`, changeFrequency: 'weekly' as const, priority: 0.8 })),
    ...brands.map((b) => ({ url: `${base}/brand/${b.slug}`, changeFrequency: 'weekly' as const, priority: 0.6 })),
    ...productRows.map((p) => ({ url: `${base}/product/${p.slug}`, lastModified: p.updatedAt, changeFrequency: 'weekly' as const, priority: 0.7 })),
  ];
}
