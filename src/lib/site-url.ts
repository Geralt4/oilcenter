/**
 * Public origin of the site, without a trailing slash. Used for e-mail links, the sitemap,
 * canonical URLs and payment-gateway return URLs.
 *
 * SITE_URL always wins. When it is not set, fall back to the variable the hosting platform
 * injects, so a fresh deployment works before anyone has configured anything.
 */
export function siteUrl(): string {
  const explicit = process.env.SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const host =
    process.env.RAILWAY_PUBLIC_DOMAIN || // Railway
    process.env.VERCEL_PROJECT_PRODUCTION_URL || // Vercel (stable production domain)
    process.env.VERCEL_URL || // Vercel (per-deployment)
    (process.env.FLY_APP_NAME ? `${process.env.FLY_APP_NAME}.fly.dev` : ''); // Fly.io
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''); // Render

  return `http://localhost:${process.env.PORT || 3000}`;
}
