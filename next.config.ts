import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // libSQL ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ['@libsql/client', 'libsql', 'sharp', 'nodemailer'],
  experimental: {
    serverActions: {
      // Admin product form uploads photos straight from a phone camera.
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
