import { asc, count, eq } from 'drizzle-orm';
import { Trash2 } from 'lucide-react';
import { deleteTaxon, saveCategory } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { CATEGORY_ICONS, CategoryIcon } from '@/components/category-icon';
import { db } from '@/lib/db';
import { categories, products, type Category } from '@/lib/db/schema';

export const metadata = { title: 'Κατηγορίες' };

function CategoryFields({ category, parents }: { category?: Category; parents: Category[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {category && <input type="hidden" name="id" value={category.id} />}
      <Field label="Όνομα"><input name="name" required defaultValue={category?.name} className="field" /></Field>
      <Field label="Ανήκει στην"><select name="parentId" defaultValue={category?.parentId ?? ''} className="field cursor-pointer"><option value="">— (κύρια κατηγορία)</option>{parents.filter((p) => p.id !== category?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Εικονίδιο"><select name="icon" defaultValue={category?.icon ?? 'engine'} className="field cursor-pointer">{Object.entries(CATEGORY_ICONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      <Field label="Σειρά εμφάνισης"><input name="sort" inputMode="numeric" defaultValue={category?.sort ?? 0} className="field tabular" /></Field>
      <Field label="Περιγραφή (εμφανίζεται στη σελίδα της κατηγορίας και στο Google)" className="md:col-span-2"><textarea name="description" rows={2} defaultValue={category?.description ?? ''} className="field resize-y" /></Field>
      <Field label="Slug" hint="Κενό = αυτόματα από το όνομα."><input name="slug" defaultValue={category?.slug ?? ''} className="field tabular" /></Field>
      <div className="flex items-end pb-2"><Check name="isActive" label="Ενεργή" defaultChecked={category?.isActive ?? true} /></div>
    </div>
  );
}

export default async function AdminCategoriesPage() {
  const [rows, counts] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.sort), asc(categories.name)),
    db.select({ id: products.categoryId, n: count() }).from(products).where(eq(products.isActive, true)).groupBy(products.categoryId),
  ]);
  const n = new Map(counts.map((c) => [c.id, c.n]));
  const roots = rows.filter((c) => !c.parentId);

  const Row = ({ c, child }: { c: Category; child?: boolean }) => (
    <li className={child ? 'ml-6 border-l-2 border-line pl-4' : ''}>
      <details className="group rounded-xl border border-line bg-white open:shadow-tile">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-100 text-ink-700"><CategoryIcon name={c.icon} className="h-4 w-4" /></span>
          <span className="flex-1 font-semibold text-ink-900">{c.name}{!c.isActive && <span className="ml-2 text-xs font-normal text-ink-400">(ανενεργή)</span>}</span>
          <span className="tabular text-sm text-ink-500">{n.get(c.id) ?? 0} προϊόντα</span>
          <span className="text-sm font-semibold text-petrol-500 group-open:hidden">Επεξεργασία</span>
        </summary>
        <div className="border-t border-line p-4">
          <AdminForm action={saveCategory} size="sm"><CategoryFields category={c} parents={roots} /></AdminForm>
          <form action={deleteTaxon} className="mt-3">
            <input type="hidden" name="id" value={c.id} /><input type="hidden" name="kind" value="category" />
            <ConfirmButton message={`Διαγραφή της κατηγορίας «${c.name}»; Τα προϊόντα της θα μείνουν χωρίς κατηγορία.`} className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" />Διαγραφή</ConfirmButton>
          </form>
        </div>
      </details>
    </li>
  );

  return (
    <>
      <PageHeader title="Κατηγορίες" description="Δύο επίπεδα: κύριες κατηγορίες και υποκατηγορίες. Τα προϊόντα μπαίνουν συνήθως σε υποκατηγορία." />
      <ul className="space-y-2">
        {roots.map((root) => (
          <div key={root.id} className="space-y-2">
            <Row c={root} />
            {rows.filter((c) => c.parentId === root.id).map((child) => <Row key={child.id} c={child} child />)}
          </div>
        ))}
      </ul>
      <Card title="Νέα κατηγορία" className="mt-8">
        <AdminForm action={saveCategory} submitLabel="Προσθήκη" resetOnSuccess><CategoryFields parents={roots} /></AdminForm>
      </Card>
    </>
  );
}
