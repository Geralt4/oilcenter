import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Breadcrumbs } from '@/components/store/product-listing';
import { getBrands } from '@/lib/catalog';

export const metadata: Metadata = {
  title: 'Μάρκες',
  description: 'Castrol, Motul, Mobil, Shell, Valvoline, Liqui Moly, Aral, Selenia, accelerate και πολλές ακόμη μάρκες λιπαντικών και χημικών.',
  alternates: { canonical: '/brands' },
};

export default async function BrandsPage() {
  const brands = await getBrands();
  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Μάρκες', href: '/brands' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Οι μάρκες μας</h1>
      <p className="mt-3 max-w-2xl text-ink-600">Συνεργαζόμαστε με τους μεγαλύτερους κατασκευαστές λιπαντικών και χημικών αυτοκινήτου. Επιλέξτε μάρκα για να δείτε τη γκάμα της.</p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {brands.map((b) => (
          <li key={b.id}>
            <Link href={`/brand/${b.slug}`} className="group flex h-full items-start justify-between gap-4 rounded-2xl border border-line bg-white p-5 shadow-tile transition-[box-shadow,border-color] hover:border-oil-400 hover:shadow-lift">
              <span>
                <span className="font-display text-2xl font-extrabold tracking-tight text-ink-900">{b.name}</span>
                {b.country && <span className="eyebrow ml-2 text-[0.6875rem] text-ink-400">{b.country}</span>}
                {b.description && <span className="mt-1.5 block text-sm leading-relaxed text-ink-600">{b.description}</span>}
                <span className="mt-2 block text-sm font-semibold text-ink-800">{b.productCount} προϊόντα</span>
              </span>
              <ArrowUpRight className="h-5 w-5 shrink-0 text-ink-300 transition-colors group-hover:text-oil-600" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
