import Link from 'next/link';
import { asc, desc, eq, max } from 'drizzle-orm';
import { Download } from 'lucide-react';
import { importPricesCsv } from '@/app/admin/actions';
import { AdminForm } from '@/components/admin/admin-form';
import { PriceEditor, type PriceRow } from '@/components/admin/price-editor';
import { PageHeader } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { brands, priceChanges, products, variants, type PriceChangeSource } from '@/lib/db/schema';
import { cn, formatDateTime, formatPrice } from '@/lib/utils';

export const metadata = { title: 'Τιμές' };

const SOURCE_LABELS: Record<PriceChangeSource, string> = { editor: 'Τιμές', product: 'Καρτέλα προϊόντος', csv: 'Εισαγωγή CSV', skroutz: 'Τιμοκατάλογος Skroutz' };

export default async function AdminPricesPage({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string; filter?: string }> }) {
  const sp = await searchParams;
  // ids are autoincrement, so the highest id per variant is its newest change
  const newest = db.select({ id: max(priceChanges.id).as('newest_id') }).from(priceChanges).groupBy(priceChanges.variantId).as('newest');
  const [rows, latest, changes] = await Promise.all([
    db
      .select({ v: variants, productId: products.id, productName: products.name, brandName: brands.name })
      .from(variants)
      .innerJoin(products, eq(variants.productId, products.id))
      .leftJoin(brands, eq(products.brandId, brands.id))
      .orderBy(asc(brands.name), asc(products.name), asc(variants.sort)),
    db.select({ variantId: priceChanges.variantId, oldCents: priceChanges.oldCents, createdAt: priceChanges.createdAt }).from(priceChanges).innerJoin(newest, eq(priceChanges.id, newest.id)),
    db
      .select({ c: priceChanges, label: variants.label, productId: products.id, productName: products.name, brandName: brands.name })
      .from(priceChanges)
      .innerJoin(variants, eq(priceChanges.variantId, variants.id))
      .innerJoin(products, eq(variants.productId, products.id))
      .leftJoin(brands, eq(products.brandId, brands.id))
      .orderBy(desc(priceChanges.id))
      .limit(30),
  ]);

  // → "άλλαξε 18/9 · ήταν 42,90 €" next to each box
  const lastChange = new Map(latest.map((c) => [c.variantId, { previousCents: c.oldCents, changedAt: c.createdAt.getTime() }]));

  const editorRows: PriceRow[] = rows.map(({ v, productId, productName, brandName }) => ({
    id: v.id,
    productId,
    brand: brandName,
    product: productName,
    label: v.label,
    sku: v.sku,
    priceCents: v.priceCents,
    verified: v.priceVerified,
    availability: v.availability,
    previousCents: lastChange.get(v.id)?.previousCents ?? null,
    changedAt: lastChange.get(v.id)?.changedAt ?? null,
  }));
  const unverifiedTotal = editorRows.filter((r) => !r.verified).length;

  return (
    <>
      <PageHeader
        title="Τιμές & διαθεσιμότητα"
        description={`Βρείτε το προϊόν, γράψτε τη νέα τιμή στο κουτάκι και πατήστε «Αποθήκευση» (ή Enter). Δίπλα σε κάθε τιμή ορίζετε και τη διαθεσιμότητα: αν τελείωσε μια συσκευασία, βάλτε «Μη διαθέσιμο» — μένει στο site με την τιμή της, αλλά δεν μπαίνει στο καλάθι ούτε στέλνεται στο Skroutz. Οι αλλαγές ισχύουν αμέσως.${unverifiedTotal ? ` ${unverifiedTotal} από ${editorRows.length} τιμές είναι ακόμη ενδεικτικές.` : ''}`}
      />

      <PriceEditor rows={editorRows} initialQuery={sp.q ?? ''} initialBrand={sp.brand ?? ''} initialOnlyUnverified={sp.filter === 'unverified'} initialOnlyWaiting={sp.filter === 'waiting'} />

      <section className="mt-10" aria-labelledby="recent-changes">
        <h2 id="recent-changes" className="text-base font-semibold text-ink-900">Τελευταίες αλλαγές τιμών</h2>
        {changes.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-ink-200 bg-white p-6 text-sm text-ink-500">Δεν έχει αλλάξει ακόμη καμία τιμή. Κάθε αλλαγή θα καταγράφεται εδώ, με την προηγούμενη τιμή.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white text-sm shadow-tile">
            {changes.map(({ c, label, productId, productName, brandName }) => {
              const pct = ((c.newCents - c.oldCents) / c.oldCents) * 100;
              return (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
                  <Link href={`/admin/products/${productId}`} className="min-w-0 flex-1 basis-56 hover:underline">
                    <span className="text-xs font-semibold tracking-wide text-ink-400 uppercase">{brandName ?? '—'}</span>{' '}
                    <span className="font-medium text-ink-900">{productName}</span> <span className="tabular text-ink-600">{label}</span>
                  </Link>
                  <span className="tabular whitespace-nowrap">
                    <span className="text-ink-400 line-through">{formatPrice(c.oldCents)}</span> → <span className="font-semibold text-ink-900">{formatPrice(c.newCents)}</span>{' '}
                    <span className={cn('text-xs', pct > 0 ? 'text-red-700' : 'text-emerald-700')}>{pct > 0 ? '+' : ''}{pct.toFixed(1).replace('.', ',')}%</span>
                  </span>
                  <span className="w-full text-xs whitespace-nowrap text-ink-400 sm:w-52 sm:text-right">{formatDateTime(c.createdAt)} · {SOURCE_LABELS[c.source] ?? c.source}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10 rounded-2xl border border-line bg-white p-5 shadow-tile" aria-labelledby="csv-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 id="csv-title" className="text-base font-semibold text-ink-900">Μαζική ενημέρωση από Excel</h2>
            <p className="mt-1 text-sm text-ink-600">Για πολλές αλλαγές μαζί (π.χ. νέος τιμοκατάλογος προμηθευτή): κατεβάστε το CSV, αλλάξτε τη στήλη price (και προαιρετικά stock) στο Excel, αποθηκεύστε ως CSV και ανεβάστε το εδώ.</p>
          </div>
          <a href="/admin/prices/export" className="flex h-10 items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50"><Download className="h-4 w-4" />Εξαγωγή CSV</a>
        </div>
        <AdminForm action={importPricesCsv} submitLabel="Εισαγωγή CSV" variant="dark" size="sm" className="mt-4">
          <input type="file" name="file" accept=".csv,text/csv" required className="block w-full cursor-pointer text-sm text-ink-700 file:mr-4 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-ink-100 file:px-4 file:text-sm file:font-semibold file:text-ink-900 hover:file:bg-ink-200" />
        </AdminForm>
      </section>
    </>
  );
}
