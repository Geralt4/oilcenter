import type { Metadata } from 'next';
import { ClipboardList, Phone, PhoneCall, SearchCheck } from 'lucide-react';
import { OilFinderForm } from '@/components/store/oil-finder-form';
import { Breadcrumbs } from '@/components/store/product-listing';
import { getProductBySlug } from '@/lib/catalog';
import { getSettings } from '@/lib/settings.server';
import { telHref } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Ποιο λάδι χρειάζεται το όχημά μου;',
  description: 'Πείτε μας μάρκα, μοντέλο, έτος και κινητήρα και σας λέμε ποιο λιπαντικό ζητά ο κατασκευαστής — ιξώδες και προδιαγραφή. Oil Center, Θεσσαλονίκη.',
  alternates: { canonical: '/find-my-oil' },
};

type Props = { searchParams: Promise<{ product?: string | string[] }> };

const steps = [
  { icon: ClipboardList, title: 'Μας λέτε τι οδηγείτε', text: 'Μάρκα, μοντέλο, έτος και καύσιμο. Αν ξέρετε και τον κινητήρα, ακόμη καλύτερα.' },
  { icon: SearchCheck, title: 'Βρίσκουμε τι ζητά ο κατασκευαστής', text: 'Ιξώδες και προδιαγραφή, όχι «κάτι που κάνει». Το λάθος λάδι το πληρώνει ο κινητήρας.' },
  { icon: PhoneCall, title: 'Σας καλούμε', text: 'Με το σωστό προϊόν, την τιμή του και το αν το έχουμε στο ράφι.' },
];

export default async function FindMyOilPage({ searchParams }: Props) {
  const { product: wanted } = await searchParams;
  const slug = Array.isArray(wanted) ? wanted[0] : wanted;
  const [{ shop }, hit] = await Promise.all([getSettings(), slug ? getProductBySlug(slug) : null]);
  const product = hit ? { slug: hit.slug, name: [hit.brand?.name, hit.name].filter(Boolean).join(' ') } : null;

  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Ποιο λάδι;', href: '/find-my-oil' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Ποιο λάδι χρειάζεται το όχημά μου;</h1>
      <p className="mt-3 max-w-2xl text-ink-600">Δεν χρειάζεται να ξέρετε ιξώδη και προδιαγραφές. Πείτε μας τι οδηγείτε και σας λέμε ακριβώς ποιο λιπαντικό ζητά ο κατασκευαστής του.</p>

      <section className="mt-8 grid gap-8 rounded-3xl border border-line bg-white p-6 shadow-tile sm:p-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <ol className="space-y-5">
            {steps.map(({ icon: Icon, title, text }, i) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-100 text-oil-800">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold text-ink-900"><span className="tabular text-ink-500">{i + 1}.</span> {title}</p>
                  <p className="text-sm text-ink-600">{text}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-6 rounded-2xl bg-ink-50 p-4 text-sm leading-relaxed text-ink-700">
            <strong className="font-semibold text-ink-900">Πού τα βρίσκω;</strong> Στην άδεια κυκλοφορίας: <span className="tabular">D.1</span> μάρκα, <span className="tabular">D.3</span> μοντέλο, <span className="tabular">B</span> πρώτη άδεια, <span className="tabular">P.1</span> κυβισμός, <span className="tabular">P.3</span> καύσιμο.
          </p>

          <a href={telHref(shop.phone)} className="mt-4 flex items-center gap-3 rounded-2xl bg-ink-900 p-4 text-white transition-colors hover:bg-ink-800">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-500 text-ink-950">
              <Phone className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">Βιάζεστε;</span>
              <span className="text-sm text-ink-300">Ένα τηλεφώνημα στο <span className="tabular font-semibold text-oil-300">{shop.phone}</span> είναι ο πιο γρήγορος τρόπος.</span>
            </span>
          </a>
        </div>

        <OilFinderForm product={product} />
      </section>
    </div>
  );
}
