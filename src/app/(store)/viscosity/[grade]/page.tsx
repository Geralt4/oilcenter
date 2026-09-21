import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { Phone } from 'lucide-react';
import { ProductListing } from '@/components/store/product-listing';
import { getViscosities, getViscosityBySlug, viscosityLabel, type ViscosityInfo } from '@/lib/catalog';
import type { RawSearchParams } from '@/lib/listing-params';
import { getSettings } from '@/lib/settings.server';
import { formatPrice, telHref } from '@/lib/utils';

/*
 * One indexable page per SAE grade («λάδια 5W-30» is how people search). A filtered /products view cannot
 * do this job: it is noindex with /products as its canonical.
 */
type Props = { params: Promise<{ grade: string }>; searchParams: Promise<RawSearchParams> };

const KIND_LABELS = { engine: 'Λάδια κινητήρα', gear: 'Βαλβολίνες' } as const;
const heading = (v: ViscosityInfo) => `${KIND_LABELS[v.kind]} ${viscosityLabel(v.grade)}`;

/** "Castrol, Mobil και Aral" */
function greekList(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} και ${items[items.length - 1]}` : (items[0] ?? '');
}

function brandPhrase(v: ViscosityInfo): string {
  const shown = v.brands.slice(0, 5);
  if (shown.length === 0) return '';
  return ` από ${v.brands.length > shown.length ? `${shown.join(', ')} και άλλες μάρκες` : greekList(shown)}`;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ grade }, sp] = await Promise.all([params, searchParams]);
  const v = await getViscosityBySlug(grade);
  if (!v) return {};
  return {
    title: heading(v),
    // no price here: prices move every few days and a search-result snippet outlives them
    description: `${v.count === 1 ? '1 λιπαντικό' : `${v.count} λιπαντικά`} ${viscosityLabel(v.grade)}${brandPhrase(v)}. Παραλαβή από το κατάστημα στη Θεσσαλονίκη ή αποστολή σε όλη την Ελλάδα.`,
    alternates: { canonical: `/viscosity/${v.slug}` },
    robots: Object.keys(sp).length > 0 ? { index: false, follow: true } : undefined,
  };
}

export default async function ViscosityPage({ params, searchParams }: Props) {
  const [{ grade }, sp] = await Promise.all([params, searchParams]);
  const v = await getViscosityBySlug(grade);
  if (!v) notFound();
  if (grade !== v.slug) permanentRedirect(`/viscosity/${v.slug}`);

  const [all, { shop }] = await Promise.all([getViscosities(), getSettings()]);
  const siblings = all.filter((o) => o.kind === v.kind);
  const label = viscosityLabel(v.grade);
  const multigrade = /^\d+W-\d+$/.test(v.grade);

  return (
    <ProductListing
      pathname={`/viscosity/${v.slug}`}
      searchParams={sp}
      scope={{ viscosity: v.grade }}
      title={heading(v)}
      eyebrow="Ιξώδες (SAE)"
      description={`${v.count === 1 ? '1 προϊόν' : `${v.count} προϊόντα`}${brandPhrase(v)}${v.minPriceCents !== null ? `, από ${formatPrice(v.minPriceCents)}` : ''}. Το ιξώδες δεν αρκεί από μόνο του: ελέγξτε και τις προδιαγραφές που ζητά ο κατασκευαστής του οχήματός σας.`}
      crumbs={[{ name: 'Ιξώδες', href: '/viscosity' }, { name: label, href: `/viscosity/${v.slug}` }]}
      footer={
        <section aria-labelledby="about-grade" className="mt-14 max-w-3xl">
          <h2 id="about-grade" className="display text-2xl sm:text-3xl">{multigrade ? `Τι σημαίνει ${v.grade};` : 'Πριν διαλέξετε'}</h2>
          <div className="prose-oc mt-4">
            {multigrade && (
              <p>
                Ο πρώτος αριθμός, μαζί με το W (winter), δείχνει πόσο εύκολα ρέει το λιπαντικό στο κρύο: όσο μικρότερος, τόσο πιο γρήγορα φτάνει παντού στην κρύα εκκίνηση. Ο δεύτερος αριθμός δείχνει το ιξώδες στη θερμοκρασία λειτουργίας.
                {v.kind === 'gear' && ' Η κλίμακα των βαλβολινών (SAE J306) είναι διαφορετική από των λαδιών κινητήρα (SAE J300), γι’ αυτό οι αριθμοί τους δεν συγκρίνονται μεταξύ τους.'}
              </p>
            )}
            <p>
              Το ιξώδες δεν αρκεί από μόνο του. Δύο λιπαντικά {label} μπορεί να καλύπτουν διαφορετικές προδιαγραφές
              {v.kind === 'gear' ? ' (π.χ. API GL-4 ή GL-5, εγκρίσεις κατασκευαστών)' : ' (ACEA, API, εγκρίσεις κατασκευαστών όπως VW 504 00 ή MB 229.51)'}, και ο κατασκευαστής του οχήματός σας ζητά συγκεκριμένες. Ακολουθήστε το βιβλίο συντήρησης — ή ρωτήστε μας και θα σας πούμε με σιγουριά.
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-sm font-semibold">
            <a href={telHref(shop.phone)} className="tabular flex h-11 items-center gap-2 rounded-xl bg-ink-900 px-4 text-white hover:bg-ink-700">
              <Phone className="h-4 w-4" />
              {shop.phone}
            </a>
            <Link href="/contact" className="flex h-11 items-center rounded-xl border border-ink-200 bg-white px-4 text-ink-900 hover:border-ink-400">Στείλτε μας τα στοιχεία του οχήματος</Link>
          </div>
        </section>
      }
    >
      {siblings.length > 1 && (
        <ul className="no-scrollbar -mx-4 mt-6 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          {siblings.map((o) => (
            <li key={o.slug} className="shrink-0">
              <Link
                href={`/viscosity/${o.slug}`}
                aria-current={o.slug === v.slug ? 'page' : undefined}
                className={
                  o.slug === v.slug
                    ? 'tabular flex h-11 items-center gap-2 rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white'
                    : 'tabular flex h-11 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-800 shadow-tile hover:border-oil-400'
                }
              >
                {o.grade}
                <span className="text-xs font-medium opacity-60">{o.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ProductListing>
  );
}
