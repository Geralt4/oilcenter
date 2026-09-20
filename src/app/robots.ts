import type { MetadataRoute } from 'next';
import { getSettings } from '@/lib/settings.server';
import { siteUrl } from '@/lib/site-url';

export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  // While the shop is in demo mode its prices are placeholders: keep the whole site out of search engines.
  const { storefront } = await getSettings();
  if (storefront.demoMode) return { rules: [{ userAgent: '*', disallow: '/' }] };

  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/', '/feeds/', '/cart', '/checkout', '/order/', '/order-status', '/account', '/login', '/register', '/forgot-password', '/reset-password', '/wishlist'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
