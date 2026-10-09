import Link from 'next/link';
import { desc, inArray } from 'drizzle-orm';
import { Download } from 'lucide-react';
import { deleteSignup } from '@/app/admin/actions';
import { ConfirmButton } from '@/components/admin/admin-form';
import { Card, PageHeader } from '@/components/admin/ui';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { brands, categories, launchSignups, products } from '@/lib/db/schema';
import { dailySeries, topKeys, total } from '@/lib/stats';
import { cn, formatDate } from '@/lib/utils';

export const metadata = { title: 'Στατιστικά' };

const PERIODS = [7, 30, 60, 90];
const CLICK_LABELS: Record<string, string> = { call: 'Κλήση στο κατάστημα', directions: 'Οδηγίες / χάρτης', skroutz: 'Skroutz', instagram: 'Instagram', email: 'E-mail' };

type Row = { label: string; n: number; href?: string };

function TopList({ title, description, rows, empty }: { title: string; description?: string; rows: Row[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Card title={title} description={description}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500">{empty}</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="relative flex items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-1.5 text-sm">
              <span className="absolute inset-y-0 left-0 rounded-lg bg-oil-100" style={{ width: `${(r.n / max) * 100}%` }} aria-hidden="true" />
              {r.href ? <Link href={r.href} className="relative min-w-0 truncate font-medium text-ink-900 hover:underline">{r.label}</Link> : <span className="relative min-w-0 truncate font-medium text-ink-900">{r.label}</span>}
              <span className="tabular relative shrink-0 font-semibold text-ink-700">{r.n}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default async function AdminStatsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 30;

  const [series, visitors, pageviews, closedCheckout, signupsInPeriod, topProducts, topCategories, topBrands, searches, emptySearches, sources, devices, clicks, carts, signups] = await Promise.all([
    dailySeries(days),
    total('visitor', days),
    total('pageview', days),
    total('checkout_closed', days),
    total('signup', days),
    topKeys('product', days, 15),
    topKeys('category', days, 10),
    topKeys('brand', days, 10),
    topKeys('search', days, 15),
    topKeys('search_empty', days, 15),
    topKeys('source', days, 10),
    topKeys('device', days, 5),
    topKeys('click', days, 10),
    topKeys('cart', days, 10),
    db.select().from(launchSignups).orderBy(desc(launchSignups.createdAt)).limit(200),
  ]);

  // slugs → names
  const productSlugs = [...new Set([...topProducts, ...carts].map((r) => r.key))];
  const [productRows, categoryRows, brandRows] = await Promise.all([
    productSlugs.length ? db.select({ id: products.id, slug: products.slug, name: products.name, brandId: products.brandId }).from(products).where(inArray(products.slug, productSlugs)) : [],
    db.select({ slug: categories.slug, name: categories.name }).from(categories),
    db.select({ id: brands.id, slug: brands.slug, name: brands.name }).from(brands),
  ]);
  const brandName = new Map(brandRows.map((b) => [b.id, b.name]));
  const productBySlug = new Map(productRows.map((p) => [p.slug, p]));
  const productRow = (r: { key: string; n: number }): Row => {
    const p = productBySlug.get(r.key);
    return p ? { label: `${p.brandId ? `${brandName.get(p.brandId) ?? ''} ` : ''}${p.name}`, n: r.n, href: `/admin/products/${p.id}` } : { label: r.key, n: r.n };
  };
  const named = (rows: Array<{ key: string; n: number }>, names: Map<string, string>): Row[] => rows.map((r) => ({ label: names.get(r.key) ?? r.key, n: r.n }));

  const peak = Math.max(1, ...series.map((d) => d.visitors));
  const hasData = pageviews > 0;

  return (
    <>
      <PageHeader title="Στατιστικά" description="Πόσοι μπαίνουν στο site, τι κοιτάνε και τι ψάχνουν. Χωρίς cookies και χωρίς στοιχεία επισκεπτών: μετριούνται μόνο σύνολα ανά ημέρα.">
        <nav aria-label="Περίοδος" className="flex gap-1.5">
          {PERIODS.map((p) => (
            <Link key={p} href={`/admin/stats?days=${p}`} className={cn('rounded-full px-3.5 py-1.5 text-sm font-medium', p === days ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>
              {p} ημέρες
            </Link>
          ))}
        </nav>
      </PageHeader>

      {!hasData && (
        <p className="mb-6 rounded-2xl border border-dashed border-ink-200 bg-white p-6 text-sm text-ink-600">
          Δεν υπάρχουν ακόμη μετρήσεις για αυτή την περίοδο. Οι δικές σας επισκέψεις δεν μετριούνται όσο είστε συνδεδεμένος στη διαχείριση, ούτε οι επισκέψεις από ρομπότ μηχανών αναζήτησης.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Επισκέπτες', value: visitors, hint: 'μοναδικοί ανά ημέρα' },
          { label: 'Προβολές σελίδων', value: pageviews, hint: visitors ? `${(pageviews / visitors).toFixed(1).replace('.', ',')} ανά επισκέπτη` : '' },
          { label: 'Έφτασαν ως το ταμείο', value: closedCheckout, hint: 'ενώ οι παραγγελίες ήταν κλειστές' },
          { label: 'Ζήτησαν ειδοποίηση', value: signupsInPeriod, hint: `${signups.length} συνολικά` },
        ].map((k) => (
          <Card key={k.label}>
            <p className="text-sm font-medium text-ink-500">{k.label}</p>
            <p className="tabular mt-1 text-3xl font-bold text-ink-950">{k.value}</p>
            <p className="text-sm text-ink-600">{k.hint || ' '}</p>
          </Card>
        ))}
      </div>

      <Card title="Επισκέπτες ανά ημέρα" className="mt-6">
        <div className="flex h-40 items-end gap-[3px]" role="img" aria-label={`Επισκέπτες ανά ημέρα, τελευταίες ${days} ημέρες`}>
          {series.map((d) => (
            <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${formatDate(new Date(`${d.day}T12:00:00`))}: ${d.visitors} επισκέπτες, ${d.pageviews} προβολές`}>
              <div className={cn('w-full rounded-t', d.visitors ? 'bg-oil-500 group-hover:bg-oil-600' : 'bg-ink-100')} style={{ height: d.visitors ? `${Math.max(4, (d.visitors / peak) * 100)}%` : '2px' }} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-ink-500">
          <span>{formatDate(new Date(`${series[0].day}T12:00:00`))}</span>
          <span>μέγιστο: {peak === 1 && !visitors ? 0 : peak} την ημέρα</span>
          <span>σήμερα</span>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <TopList title="Τι έψαξαν και ΔΕΝ βρήκαν" description="Προϊόντα που ζητούν οι πελάτες και δεν υπάρχουν στο site — οι πρώτοι υποψήφιοι για προσθήκη." rows={emptySearches.map((r) => ({ label: r.key, n: r.n }))} empty="Καμία αναζήτηση χωρίς αποτέλεσμα." />
        <TopList title="Τι έψαξαν" rows={searches.map((r) => ({ label: r.key, n: r.n }))} empty="Καμία αναζήτηση ακόμη." />
        <TopList title="Προϊόντα με τις περισσότερες προβολές" rows={topProducts.map(productRow)} empty="Καμία προβολή προϊόντος ακόμη." />
        <TopList title="Μπήκαν στο καλάθι" description="Πόσες φορές πατήθηκε «προσθήκη στο καλάθι» — η πιο καθαρή ένδειξη ότι κάποιος ήθελε να αγοράσει online." rows={carts.map(productRow)} empty="Καμία προσθήκη στο καλάθι ακόμη." />
        <TopList title="Κατηγορίες" rows={named(topCategories, new Map(categoryRows.map((c) => [c.slug, c.name])))} empty="Καμία προβολή κατηγορίας ακόμη." />
        <TopList title="Μάρκες" rows={named(topBrands, new Map(brandRows.map((b) => [b.slug, b.name])))} empty="Καμία προβολή μάρκας ακόμη." />
        <TopList title="Από πού ήρθαν" description="«Απευθείας» σημαίνει ότι έγραψαν τη διεύθυνση, σκάναραν QR ή πάτησαν σύνδεσμο από εφαρμογή." rows={sources.map((r) => ({ label: r.key, n: r.n }))} empty="Καμία επίσκεψη ακόμη." />
        <TopList title="Τι πάτησαν για να σας βρουν" rows={named(clicks, new Map(Object.entries(CLICK_LABELS)))} empty="Κανένα κλικ σε τηλέφωνο, χάρτη ή social ακόμη." />
        <TopList title="Συσκευή" rows={devices.map((r) => ({ label: r.key, n: r.n }))} empty="Καμία επίσκεψη ακόμη." />

        <Card title={`Θέλουν ειδοποίηση όταν ανοίξουν οι παραγγελίες (${signups.length})`} description="Χρησιμοποιήστε αυτά τα e-mail μόνο για να τους ενημερώσετε ότι άνοιξαν οι online παραγγελίες. Αν κάποιος ζητήσει διαγραφή, σβήστε τον από εδώ.">
          {signups.length === 0 ? (
            <p className="text-sm text-ink-500">Καμία εγγραφή ακόμη.</p>
          ) : (
            <>
              <ul className="max-h-72 divide-y divide-line overflow-y-auto text-sm">
                {signups.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate font-medium text-ink-900">{s.email}</span>
                    <span className="flex shrink-0 items-center gap-3 text-xs text-ink-500">
                      {formatDate(s.createdAt)}
                      <form action={deleteSignup}>
                        <input type="hidden" name="id" value={s.id} />
                        <ConfirmButton message={`Διαγραφή του ${s.email};`} className="cursor-pointer font-medium text-red-700 hover:underline">Διαγραφή</ConfirmButton>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
              <a href="/admin/stats/signups" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50"><Download className="h-4 w-4" />Εξαγωγή CSV</a>
            </>
          )}
        </Card>
      </div>

      <p className="mt-6 max-w-3xl text-xs text-ink-500">
        Πώς μετράμε: κάθε επισκέπτης μετρά μία φορά την ημέρα, χωρίς cookies και χωρίς να αποθηκεύεται η διεύθυνσή του. Δεν μετριούνται ρομπότ, όσοι έχουν ζητήσει από τον browser τους «να μην παρακολουθούνται», ούτε εσείς όσο είστε συνδεδεμένος στη διαχείριση. Οι αριθμοί είναι ενδεικτικοί της τάσης, όχι λογιστικά ακριβείς.
      </p>
    </>
  );
}
