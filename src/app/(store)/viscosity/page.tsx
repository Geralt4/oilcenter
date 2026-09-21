import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '@/components/store/product-listing';
import { getViscosities, type ViscosityInfo } from '@/lib/catalog';
import { formatPrice } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Λιπαντικά ανά ιξώδες (SAE)',
  description: 'Βρείτε λάδι κινητήρα ή βαλβολίνη με βάση το ιξώδες που ζητά το βιβλίο συντήρησης: 5W-30, 5W-40, 10W-40, 75W-90 και όλα τα υπόλοιπα.',
  alternates: { canonical: '/viscosity' },
};

function Grades({ title, items }: { title: string; items: ViscosityInfo[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="display text-2xl sm:text-3xl">{title}</h2>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((v) => (
          <li key={v.slug}>
            <Link href={`/viscosity/${v.slug}`} className="block rounded-2xl border border-line bg-white p-4 shadow-tile transition-colors hover:border-oil-400">
              <span className="tabular block font-display text-2xl font-bold text-ink-950">{v.grade}</span>
              <span className="mt-1 block text-sm text-ink-600">
                {v.count === 1 ? '1 προϊόν' : `${v.count} προϊόντα`}
                {v.minPriceCents !== null && <> · από <span className="tabular">{formatPrice(v.minPriceCents)}</span></>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function ViscosityIndexPage() {
  const all = await getViscosities();
  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Ιξώδες', href: '/viscosity' }]} />
      <header className="mt-5 max-w-3xl">
        <p className="eyebrow text-oil-700">Κατάλογος</p>
        <h1 className="display mt-1 text-4xl sm:text-5xl">Λιπαντικά ανά ιξώδες</h1>
        <p className="mt-3 leading-relaxed text-ink-600">Το ιξώδες (π.χ. 5W-30) το γράφει το βιβλίο συντήρησης του οχήματός σας. Διαλέξτε το και δείτε ό,τι έχουμε — μαζί με τις προδιαγραφές που καλύπτει κάθε προϊόν.</p>
      </header>
      <Grades title="Λάδια κινητήρα" items={all.filter((v) => v.kind === 'engine')} />
      <Grades title="Βαλβολίνες & κιβώτια" items={all.filter((v) => v.kind === 'gear')} />
    </div>
  );
}
