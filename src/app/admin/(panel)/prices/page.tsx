import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { Download } from 'lucide-react';
import { importPricesCsv, savePrices } from '@/app/admin/actions';
import { AdminForm } from '@/components/admin/admin-form';
import { Card, PageHeader, td, th } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { brands, products, variants } from '@/lib/db/schema';
import { centsToInput, cn } from '@/lib/utils';

export const metadata = { title: 'Τιμές & απόθεμα' };

export default async function AdminPricesPage({ searchParams }: { searchParams: Promise<{ brand?: string; filter?: string }> }) {
  const sp = await searchParams;
  const [rows, brandRows] = await Promise.all([
    db
      .select({ v: variants, productId: products.id, productName: products.name, brandId: products.brandId, brandName: brands.name })
      .from(variants)
      .innerJoin(products, eq(variants.productId, products.id))
      .leftJoin(brands, eq(products.brandId, brands.id))
      .orderBy(asc(brands.name), asc(products.name), asc(variants.sort)),
    db.select().from(brands).orderBy(asc(brands.name)),
  ]);

  const brandId = Number(sp.brand) || null;
  const onlyUnverified = sp.filter === 'unverified';
  const shown = rows.filter((r) => (!brandId || r.brandId === brandId) && (!onlyUnverified || !r.v.priceVerified));
  const unverifiedTotal = rows.filter((r) => !r.v.priceVerified).length;
  const href = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ brand: sp.brand, filter: sp.filter, ...params })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/prices?${s}` : '/admin/prices';
  };

  return (
    <>
      <PageHeader title="Τιμές & απόθεμα" description={unverifiedTotal ? `${unverifiedTotal} από ${rows.length} συσκευασίες έχουν ακόμη ενδεικτική τιμή (κίτρινες γραμμές).` : `Όλες οι ${rows.length} τιμές είναι επιβεβαιωμένες.`}>
        <a href="/admin/prices/export" className="flex h-10 items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50"><Download className="h-4 w-4" />Εξαγωγή CSV</a>
      </PageHeader>

      <Card title="Μαζική ενημέρωση από Excel" description="Κατεβάστε το CSV, συμπληρώστε τις στήλες price (και προαιρετικά stock) στο Excel, αποθηκεύστε ως CSV και ανεβάστε το εδώ. Όσοι κωδικοί ενημερωθούν σημειώνονται ως επιβεβαιωμένοι." className="mb-6">
        <AdminForm action={importPricesCsv} submitLabel="Εισαγωγή CSV" variant="dark" size="sm">
          <input type="file" name="file" accept=".csv,text/csv" required className="block w-full cursor-pointer text-sm text-ink-700 file:mr-4 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-ink-100 file:px-4 file:text-sm file:font-semibold file:text-ink-900 hover:file:bg-ink-200" />
        </AdminForm>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav className="no-scrollbar flex gap-1.5 overflow-x-auto" aria-label="Φίλτρα">
          <Link href={href({ filter: undefined })} className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium', !onlyUnverified ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>Όλες</Link>
          <Link href={href({ filter: 'unverified' })} className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium', onlyUnverified ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>Μόνο ενδεικτικές ({unverifiedTotal})</Link>
        </nav>
        <form className="ml-auto flex gap-2">
          {sp.filter && <input type="hidden" name="filter" value={sp.filter} />}
          <select name="brand" defaultValue={sp.brand ?? ''} className="field h-10 w-44 cursor-pointer py-0 text-sm"><option value="">Όλες οι μάρκες</option>{brandRows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <button type="submit" className="h-10 cursor-pointer rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white hover:bg-ink-700">Εμφάνιση</button>
        </form>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">Καμία συσκευασία με αυτά τα φίλτρα.</p>
      ) : (
        <AdminForm action={savePrices} submitLabel={`Αποθήκευση τιμών (${shown.length})`} stickyBar>
          <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-tile">
            <table className="w-full min-w-[44rem]">
              <thead><tr className="border-b border-line bg-ink-50"><th className={th}>Προϊόν</th><th className={th}>Συσκ.</th><th className={th}>Κωδικός</th><th className={th}>Τιμή € (με ΦΠΑ)</th><th className={cn(th, 'text-center')}>Επιβεβαιωμένη</th></tr></thead>
              <tbody className="divide-y divide-line">
                {shown.map(({ v, productId, productName, brandName }) => (
                  <tr key={v.id} className={cn(!v.priceVerified && 'bg-amber-50')}>
                    <td className={td}><Link href={`/admin/products/${productId}`} className="hover:underline"><span className="text-xs font-semibold tracking-wide text-ink-400 uppercase">{brandName ?? '—'}</span> <span className="font-medium text-ink-900">{productName}</span></Link></td>
                    <td className={cn(td, 'tabular font-semibold')}>{v.label}</td>
                    <td className={cn(td, 'tabular text-xs text-ink-500')}>{v.sku}</td>
                    <td className={td}><input name={`price-${v.id}`} defaultValue={centsToInput(v.priceCents)} inputMode="decimal" aria-label={`Τιμή ${productName} ${v.label}`} className="field tabular h-9 w-28 px-2.5 text-sm" /></td>
                    <td className={cn(td, 'text-center')}><input type="checkbox" name={`verified-${v.id}`} defaultChecked={v.priceVerified} aria-label="Επιβεβαιωμένη τιμή" className="h-[1.125rem] w-[1.125rem] cursor-pointer accent-emerald-600" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-500">Όταν αλλάζετε μια τιμή, σημειώνεται αυτόματα ως επιβεβαιωμένη. Αν η ενδεικτική τιμή είναι ήδη σωστή, απλώς τσεκάρετε το κουτάκι.</p>
        </AdminForm>
      )}
    </>
  );
}
