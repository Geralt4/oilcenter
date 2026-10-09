import { asc, count } from 'drizzle-orm';
import { Trash2 } from 'lucide-react';
import { deleteTaxon, saveBrand } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { brands, products, type Brand } from '@/lib/db/schema';

export const metadata = { title: 'Μάρκες' };

function BrandFields({ brand }: { brand?: Brand }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {brand && <input type="hidden" name="id" value={brand.id} />}
      <Field label="Όνομα"><input name="name" required defaultValue={brand?.name} className="field" /></Field>
      <Field label="Χώρα"><input name="country" defaultValue={brand?.country ?? ''} className="field" /></Field>
      <Field label="Περιγραφή" className="md:col-span-2"><textarea name="description" rows={2} defaultValue={brand?.description ?? ''} className="field resize-y" /></Field>
      <Field label="Slug" hint={brand ? 'Κενό = μένει όπως είναι.' : 'Κενό = αυτόματα από το όνομα.'}><input key={brand?.slug ?? ''} name="slug" defaultValue={brand?.slug ?? ''} placeholder={brand?.slug} className="field tabular" /></Field>
      <Field label="Σειρά εμφάνισης"><input name="sort" inputMode="numeric" defaultValue={brand?.sort ?? 0} className="field tabular" /></Field>
      <div className="md:col-span-2"><Check name="isFeatured" label="Εμφάνιση στην αρχική σελίδα" defaultChecked={brand?.isFeatured ?? false} /></div>
    </div>
  );
}

export default async function AdminBrandsPage() {
  await requireAdmin();
  const [rows, counts] = await Promise.all([db.select().from(brands).orderBy(asc(brands.sort), asc(brands.name)), db.select({ id: products.brandId, n: count() }).from(products).groupBy(products.brandId)]);
  const n = new Map(counts.map((c) => [c.id, c.n]));

  return (
    <>
      <PageHeader title="Μάρκες" description={`${rows.length} μάρκες`} />
      <ul className="space-y-2">
        {rows.map((b) => (
          <li key={b.id}>
            <details className="group rounded-xl border border-line bg-white open:shadow-tile">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="flex-1 font-semibold text-ink-900">{b.name}{b.isFeatured && <span className="ml-2 rounded-full bg-oil-100 px-2 py-0.5 text-xs font-semibold text-oil-800">αρχική</span>}</span>
                <span className="tabular text-sm text-ink-500">{n.get(b.id) ?? 0} προϊόντα</span>
                <span className="text-sm font-semibold text-petrol-500 group-open:hidden">Επεξεργασία</span>
              </summary>
              <div className="border-t border-line p-4">
                <AdminForm action={saveBrand} size="sm"><BrandFields brand={b} /></AdminForm>
                <form action={deleteTaxon} className="mt-3">
                  <input type="hidden" name="id" value={b.id} /><input type="hidden" name="kind" value="brand" />
                  <ConfirmButton message={`Διαγραφή της μάρκας «${b.name}»; Τα προϊόντα της θα μείνουν χωρίς μάρκα.`} className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" />Διαγραφή</ConfirmButton>
                </form>
              </div>
            </details>
          </li>
        ))}
      </ul>
      <Card title="Νέα μάρκα" className="mt-8"><AdminForm action={saveBrand} submitLabel="Προσθήκη" resetOnSuccess><BrandFields /></AdminForm></Card>
    </>
  );
}
