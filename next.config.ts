import type { NextConfig } from 'next';

// Baseline Content-Security-Policy. A nonce-based policy would be stricter, but the CSP guide for this
// Next version notes that nonces force every page into dynamic rendering (no static/CDN caching), which is
// not worth it here. 'unsafe-inline' is required for the scripts/styles Next injects; the other directives
// still block the high-value vectors — off-site script origins, <base> injection, framing, form hijacking.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  // the store-location map is an embedded Google Maps iframe
  "frame-src https://www.google.com",
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // libSQL ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ['@libsql/client', 'libsql', 'sharp', 'nodemailer'],
  experimental: {
    serverActions: {
      // Admin product form uploads photos straight from a phone camera. Next applies one body-size limit
      // to ALL server actions, so this ceiling also covers the public forms (contact, checkout, …); those are
      // further bounded by their zod field limits and per-IP rate limiting, so the practical exposure is small.
      bodySizeLimit: '25mb',
    },
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    qualities: [75, 85],
    localPatterns: [
      { pathname: '/catalog/**', search: '' },
      { pathname: '/media/**', search: '' },
      { pathname: '/shop/**', search: '' },
    ],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          // Two years; browsers only honour it over HTTPS, so it is inert on local http.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        ],
      },
      {
        source: '/catalog/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
  // Keep whatever search equity the 2015 static site still has.
  async redirects() {
    const brandPages = ['accelerate', 'castrol', 'aral', 'shell', 'valvoline', 'mobil', 'selenia', 'motul'];
    return [
      { source: '/index.html', destination: '/', permanent: true },
      { source: '/contact.html', destination: '/contact', permanent: true },
      { source: '/fotos.html', destination: '/about', permanent: true },
      { source: '/chemicals.html', destination: '/category/chimika-prostheta', permanent: true },
      { source: '/parts.html', destination: '/products', permanent: true },
      { source: '/total.html', destination: '/products', permanent: true },
      { source: '/elf.html', destination: '/products', permanent: true },
      ...brandPages.map((b) => ({ source: `/${b}.html`, destination: `/brand/${b}`, permanent: true })),
    ];
  },
};

export default nextConfig;
