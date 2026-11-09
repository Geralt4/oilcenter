import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { siteUrl } from '@/lib/site-url';
import './globals.css';
import { OG_BASE, OG_IMAGE } from '@/lib/seo';

// Both families have a proper Greek subset, which most display faces do not. The files are in the repo
// (not fetched during `next build`); scripts/build-fonts lists their source and checks them.
// Each family is a Latin file plus a Greek file, chained in globals.css (--font-sans, --font-display). Only the
// Greek one keeps the metric-adjusted fallback face: that face covers Greek too, so on the Latin one it would
// catch Greek text before the Greek file was tried.
const textLatin = localFont({
  src: './fonts/commissioner-latin.woff2',
  weight: '100 900',
  variable: '--font-text-latin',
  display: 'swap',
  adjustFontFallback: false,
});
const textGreek = localFont({
  src: './fonts/commissioner-greek.woff2',
  weight: '100 900',
  variable: '--font-text-greek',
  display: 'swap',
});

const displayLatin = localFont({
  src: './fonts/sofia-sans-condensed-latin.woff2',
  weight: '600 800',
  variable: '--font-display-latin',
  display: 'swap',
  adjustFontFallback: false,
});
const displayGreek = localFont({
  src: './fonts/sofia-sans-condensed-greek.woff2',
  weight: '600 800',
  variable: '--font-display-greek',
  display: 'swap',
});

const SITE_URL = siteUrl();

// Render everything at request time, the 404 page included. Without this the default /_not-found page is
// prerendered during `next build`, where SITE_URL is not visible (Railway passes variables to a Dockerfile build
// only through ARG), and its canonical/og:url would carry http://localhost:3000 for good. Every other segment
// is already dynamic, so nothing else changes.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Oil Center Τσακιρίδης — Λιπαντικά Αυτοκινήτου, Θεσσαλονίκη',
    template: '%s | Oil Center',
  },
  description:
    // says nothing about delivery: that sentence is added by the store layout only while online ordering is open
    'Λιπαντικά κινητήρα, βαλβολίνες, αντιψυκτικά, χημικά και ανταλλακτικά από Castrol, Motul, Mobil, Valvoline, Shell, Liqui Moly και accelerate. Κατάστημα στη Θεσσαλονίκη, με συμβουλή για το σωστό λάδι.',
  applicationName: 'Oil Center',
  authors: [{ name: 'Τσακιρίδης Ηλίας' }],
  openGraph: { ...OG_BASE, images: [OG_IMAGE] },
  twitter: { card: 'summary_large_image' },
  formatDetection: { telephone: true, address: true, email: true },
  // No default canonical here: a page that has none (cart, checkout, account, 404) must not claim the home page.
  // Every indexable page declares its own; the home page does so in (store)/page.tsx.
};

export const viewport: Viewport = {
  themeColor: '#11141a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el" className={`${textLatin.variable} ${textGreek.variable} ${displayLatin.variable} ${displayGreek.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
