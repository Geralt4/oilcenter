import type { NextConfig } from 'next';

// Static security headers. The Content-Security-Policy is deliberately NOT among them: it needs a
// per-request nonce, and only src/proxy.ts can mint one (gate 3 there). The old policy lived here with
// script-src 'unsafe-inline', which would have let any future XSS run free; the nonce policy in the proxy
// drops that. Everything below is static and applies to every response.

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // libSQL ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ['@libsql/client', 'libsql', 'sharp', 'nodemailer'],
  experimental: {
    serverActions: {
      // Admin product form uploads photos straight from a phone camera. Next applies one body-size limit
      // to ALL server actions, so this ceiling also covers the public forms (contact, checkout, …); those are
      // further bounded by their zod field limits and per-IP rate limiting, so the practical exposure is small.
      bodySizeLimit: '32mb',
    },
    // src/proxy.ts runs in front of /admin too, and Next buffers a request body for the proxy only up to this size
    // (10 MB by default): without it a save with a few phone photos reached the action cut short.
    proxyClientMaxBodySize: '32mb',
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
          // No Cross-Origin-Resource-Policy on purpose: the Skroutz feed embeds /catalog/* product photos
          // from skroutz.gr, and CORP would block that. COOP below still cuts the window-based attacks.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          // Keeps this origin in its own process group, so a cross-origin page cannot be rearranged into
          // sharing one with it (a prerequisite for several side-channel attacks).
          { key: 'Origin-Agent-Cluster', value: '?1' },
          // Two years; browsers only honour it over HTTPS, so it is inert on local http. Once the bare oilcenter.gr
          // is served here too (redirecting to www), includeSubDomains pins EVERY *.oilcenter.gr to HTTPS for two
          // years in each browser that saw it — fine, because the old Papaki hosting and its mail./ftp. hosts are
          // being deleted, but any future subdomain must be HTTPS from day one. Never add `preload`: it is
          // effectively irreversible.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
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
