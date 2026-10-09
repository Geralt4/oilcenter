import type { Metadata, Viewport } from 'next';
import { Commissioner, Sofia_Sans_Condensed } from 'next/font/google';
import { siteUrl } from '@/lib/site-url';
import './globals.css';

// Both families ship a proper Greek subset, which most display faces do not.
const text = Commissioner({
  subsets: ['latin', 'greek'],
  variable: '--font-text',
  display: 'swap',
});

const display = Sofia_Sans_Condensed({
  subsets: ['latin', 'greek'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
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
    default: 'Oil Center — Λιπαντικά Αυτοκινήτου & Μοτοσυκλέτας | Τσακιρίδης, Θεσσαλονίκη',
    template: '%s | Oil Center',
  },
  description:
    // says nothing about delivery: that sentence is added by the store layout only while online ordering is open
    'Λιπαντικά κινητήρα, βαλβολίνες, αντιψυκτικά και χημικά από Castrol, Motul, Mobil, Valvoline, Shell, Liqui Moly και accelerate. Κατάστημα στη Θεσσαλονίκη, με συμβουλή για το σωστό λάδι.',
  applicationName: 'Oil Center',
  authors: [{ name: 'Τσακιρίδης Ηλίας' }],
  openGraph: {
    type: 'website',
    locale: 'el_GR',
    siteName: 'Oil Center — Τσακιρίδης',
    url: SITE_URL,
  },
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
    <html lang="el" className={`${text.variable} ${display.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
