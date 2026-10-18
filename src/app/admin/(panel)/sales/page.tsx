import { and, desc, eq } from 'drizzle-orm';
import { Trash2 } from 'lucide-react';
import { deleteSale, saveSale } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { DiscountTargets } from '@/components/admin/discount-targets';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { loadTargetOptions } from '@/lib/admin-targets';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { products, sales, variants, type Sale } from '@/lib/db/schema';
import { matchesTargets } from '@/lib/discounts';
import { loadCategoryPaths, saleActiveAt } from '@/lib/sales';
import { centsToInput, cn, formatAthensDate, formatPrice } from '@/lib/utils';

export const metadata = { title: 'Προσφορές' };

// a server component that runs once per request: reading the clock here is not a re-render hazard
const clock = () => Date.now();

type Options = Awaited<ReturnType<typeof loadTargetOptions>>;

function SaleFields({ sale, options }: { sale?: Sale; options: Options }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {sale && <input type="hidden" name="id" value={sale.id} />}
      <Field label="Όνομα" hint="Εσωτερική ονομασία, δεν φαίνεται στους πελάτες."><input name="name" required defaultValue={sale?.name} placeholder="Φθινοπωρινή προσφορά Motul" className="field" /></Field>
      <Field label="Τύπος">
        <select name="type" defaultValue={sale?.type ?? 'percent'} className="field cursor-pointer">
          <option value="percent">Ποσοστό %</option><option value="fixed">Σταθερό ποσό € ανά συσκευασία</option>
        </select>
      </Field>
      <Field label="Αξία" hint="Ποσοστό (έως 90) ή ποσό σε € (π.χ. 2,00)."><input name="value" required inputMode="decimal" defaultValue={sale ? (sale.type === 'fixed' ? centsToInput(sale.value) : sale.value) : ''} className="field tabular" /></Field>
      <div className="grid grid-cols-2 gap-3 md:col-span-2">
        <Field label="Από"><input type="date" name="startsAt" defaultValue={formatAthensDate(sale?.startsAt)} className="field" /></Field>
        <Field label="Έως (και αυτή η μέρα)"><input type="date" name="endsAt" defaultValue={formatAthensDate(sale?.endsAt)} className="field" /></Field>
      </div>
      <div className="flex items-end"><Check name="isActive" label="Ενεργή" defaultChecked={sale?.isActive ?? true} /></div>
      <div className="md:col-span-3">
        <DiscountTargets
          brands={options.brands}
          categories={options.categories}
          products={(sale?.productIds ?? []).flatMap((id) => options.productName(id) ?? [])}
          brandIds={sale?.brandIds ?? []}
          categoryIds={sale?.categoryIds ?? []}
        />
      </div>
    </div>
  );
}

function status(s: Sale, now: number): { label: string; tone: string } {
  if (!s.isActive) return { label: 'Ανενεργή', tone: 'bg-ink-100 text-ink-600' };
  if (s.endsAt && s.endsAt.getTime() < now) return { label: 'Έληξε', tone: 'bg-ink-100 text-ink-600' };
  if (s.startsAt && s.startsAt.getTime() > now) return { label: 'Προγραμματισμένη', tone: 'bg-amber-100 text-amber-900' };
  return { label: 'Ενεργή τώρα', tone: 'bg-emerald-100 text-emerald-800' };
}

export default async function AdminSalesPage() {
  await requireAdmin();
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt));
  const [options, paths, productRows, sizeRows] = await Promise.all([
    loadTargetOptions([...new Set(rows.flatMap((s) => s.productIds))]),
    loadCategoryPaths(),
    db.select({ id: products.id, brandId: products.brandId, categoryId: products.categoryId }).from(products).where(eq(products.isActive, true)),
    db.select({ productId: variants.productId }).from(variants).where(and(eq(variants.isActive, true), eq(variants.priceVerified, true))),
  ]);
  const sizesOf = new Map<number, number>();
  for (const v of sizeRows) sizesOf.set(v.productId, (sizesOf.get(v.productId) ?? 0) + 1);
  const covered = (s: Sale) =>
    productRows
      .filter((p) => matchesTargets(s, { productId: p.id, brandId: p.brandId, categoryPath: p.categoryId !== null ? (paths.get(p.categoryId) ?? [p.categoryId]) : [] }))
      .reduce((sum, p) => sum + (sizesOf.get(p.id) ?? 0), 0);
  const now = clock();
  const describe = (s: Sale) => (s.type === 'percent' ? `−${s.value}%` : `−${formatPrice(s.value)}`);

  return (
    <>
      <PageHeader title="Προσφορές" description="Αυτόματες εκπτώσεις σε επιλεγμένα προϊόντα, μάρκες ή κατηγορίες. Η τιμή στο site πέφτει μόνη της, με τη συνηθισμένη τιμή διαγραμμένη. Δεν χρειάζεται κωδικός." />
      <ul className="space-y-2">
        {rows.map((s) => {
          const st = status(s, now);
          const live = saleActiveAt(s, now);
          return (
            <li key={s.id}>
              <details className="group rounded-xl border border-line bg-white open:shadow-tile">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="font-display text-lg font-bold text-ink-950">{s.name}</span>
                  <span className="text-sm font-semibold text-ink-700">{describe(s)}</span>
                  <span className="text-sm text-ink-500">{options.scope(s, '')}</span>
                  <span className="flex-1" />
                  <span className="tabular text-sm text-ink-500">{covered(s)} συσκευασίες{live ? '' : ' (όταν ισχύει)'}</span>
                  <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', st.tone)}>{st.label}</span>
                </summary>
                <div className="border-t border-line p-4">
                  <AdminForm action={saveSale} size="sm"><SaleFields sale={s} options={options} /></AdminForm>
                  <form action={deleteSale} className="mt-3">
                    <input type="hidden" name="id" value={s.id} />
                    <ConfirmButton message={`Διαγραφή της προσφοράς «${s.name}»; Οι τιμές θα επανέλθουν αμέσως.`} className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" />Διαγραφή</ConfirmButton>
                  </form>
                </div>
              </details>
            </li>
          );
        })}
        {rows.length === 0 && <li className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center text-sm text-ink-500">Δεν υπάρχουν προσφορές.</li>}
      </ul>
      <Card title="Νέα προσφορά" className="mt-8"><AdminForm action={saveSale} submitLabel="Δημιουργία" resetOnSuccess><SaleFields options={options} /></AdminForm></Card>
    </>
  );
}
