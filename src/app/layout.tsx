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

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Oil Center — Λιπαντικά Αυτοκινήτου & Μοτοσυκλέτας | Τσακιρίδης, Θεσσαλονίκη',
    template: '%s | Oil Center',
  },
  description:
    'Λιπαντικά κινητήρα, βαλβολίνες, αντιψυκτικά και χημικά από Castrol, Motul, Mobil, Valvoline, Shell, Liqui Moly και accelerate. Αποστολή σε όλη την Ελλάδα, παραλαβή από το κατάστημα στη Θεσσαλονίκη.',
  applicationName: 'Oil Center',
  authors: [{ name: 'Τσακιρίδης Ηλίας' }],
  openGraph: {
    type: 'website',
    locale: 'el_GR',
    siteName: 'Oil Center — Τσακιρίδης',
    url: SITE_URL,
  },
  formatDetection: { telephone: true, address: true, email: true },
  alternates: { canonical: '/' },
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
