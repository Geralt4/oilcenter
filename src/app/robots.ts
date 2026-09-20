import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/', '/cart', '/checkout', '/order/', '/order-status', '/account', '/login', '/register', '/forgot-password', '/reset-password', '/wishlist'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
