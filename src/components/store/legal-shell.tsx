import Link from 'next/link';
import { Breadcrumbs } from '@/components/store/product-listing';
import { getSettings } from '@/lib/settings.server';

const PAGES = [
  { href: '/shipping-payments', label: 'Αποστολές & πληρωμές', shopOnly: true },
  { href: '/returns', label: 'Επιστροφές & υπαναχώρηση', shopOnly: true },
  { href: '/terms', label: 'Όροι χρήσης' },
  { href: '/privacy', label: 'Πολιτική απορρήτου' },
  { href: '/cookies', label: 'Cookies' },
];

/*
 * NOTE FOR THE SITE OWNER: the texts rendered inside this shell are good-faith templates written
 * around Greek / EU consumer law (N. 2251/1994, Directive 2011/83/EU, GDPR). They are NOT legal
 * advice. Have a lawyer review them, and fill in ΑΦΜ / ΔΟΥ / ΓΕΜΗ in /admin/settings, before launch.
 */
export async function LegalShell({ href, title, updated, children }: { href: string; title: string; updated: string; children: React.ReactNode }) {
  // catalogue mode: the two pages about buying online are not part of the site (lib/catalogue-mode.ts)
  const { storefront } = await getSettings();
  const pages = PAGES.filter((p) => storefront.ordersEnabled || !('shopOnly' in p) || p.href === href);
  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: title, href }]} />
      <div className="mt-6 grid gap-10 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Πληροφορίες" className="lg:sticky lg:top-44 lg:self-start">
          <ul className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
            {pages.map((p) => (
              <li key={p.href} className="shrink-0">
                <Link href={p.href} aria-current={p.href === href ? 'page' : undefined} className={p.href === href ? 'block rounded-xl bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white' : 'block rounded-xl px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-100'}>
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="max-w-3xl">
          <h1 className="display text-4xl sm:text-5xl">{title}</h1>
          <p className="mt-2 text-sm text-ink-500">Τελευταία ενημέρωση: {updated}</p>
          <div className="prose-oc mt-6">{children}</div>
        </article>
      </div>
    </div>
  );
}
