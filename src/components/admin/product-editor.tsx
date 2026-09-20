import Image from 'next/image';
import Link from 'next/link';
import { asc } from 'drizzle-orm';
import { ExternalLink, Star, Trash2, TriangleAlert } from 'lucide-react';
import { deleteProduct, imageAction, saveProduct } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { VariantsEditor, type VariantRow } from '@/components/admin/variants-editor';
import { BASE_TYPE_LABELS } from '@/lib/catalog';
import { db } from '@/lib/db';
import { brands, categories, type Product, type ProductImage, type Variant } from '@/lib/db/schema';
import { centsToInput } from '@/lib/utils';

type Props = { product?: Product & { images: ProductImage[]; variants: Variant[] }; created?: boolean };

export async function ProductEditor({ product, created }: Props) {
  const [brandRows, categoryRows] = await Promise.all([db.select().from(brands).orderBy(asc(brands.name)), db.select().from(categories).orderBy(asc(categories.sort))]);
  const parents = new Map(categoryRows.map((c) => [c.id, c.name]));

  const rows: VariantRow[] = (product?.variants ?? []).map((v) => ({
    id: v.id, label: v.label, sku: v.sku, price: centsToInput(v.priceCents), compareAt: centsToInput(v.compareAtCents), stock: v.stock, trackStock: v.trackStock, availability: v.availability,
    weightGrams: v.weightGrams, barcode: v.barcode ?? '', mpn: v.mpn ?? '', imageUrl: v.imageUrl ?? '', isActive: v.isActive, priceVerified: v.priceVerified,
  }));

  return (
    <>
      <PageHeader title={product ? product.name : 'Νέο προϊόν'} description={product ? `/product/${product.slug}` : 'Συμπληρώστε τα στοιχεία και τουλάχιστον μία συσκευασία.'}>
        {product && <Link href={`/product/${product.slug}`} target="_blank" className="flex h-10 items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50"><ExternalLink className="h-4 w-4" />Προβολή</Link>}
      </PageHeader>

      {created && <p role="status" className="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">Το προϊόν δημιουργήθηκε.</p>}
      {product?.internalNotes && (
        <div className="mb-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div><strong>Προς έλεγχο:</strong><p className="mt-1 whitespace-pre-line">{product.internalNotes}</p><p className="mt-2 text-amber-800">Διορθώστε ό,τι χρειάζεται και σβήστε τη σημείωση (κάτω, «Εσωτερικές σημειώσεις») για να φύγει από τη λίστα ελέγχου.</p></div>
        </div>
      )}

      {product && product.images.length > 0 && (
        <Card title="Φωτογραφίες" description="Η πρώτη είναι η κύρια. Νέες φωτογραφίες προσθέτετε από τη φόρμα παρακάτω." className="mb-6">
          <ul className="flex flex-wrap gap-3">
            {product.images.map((img, i) => (
              <li key={img.id} className="w-28">
                <span className="relative block aspect-square overflow-hidden rounded-xl border border-line bg-white"><Image src={img.url} alt="" fill sizes="112px" className="object-contain p-1.5" />{i === 0 && <span className="absolute top-1 left-1 rounded bg-oil-500 px-1.5 py-0.5 text-[0.625rem] font-bold text-ink-950">ΚΥΡΙΑ</span>}</span>
                <form action={imageAction} className="mt-1.5 flex justify-between gap-1">
                  <input type="hidden" name="imageId" value={img.id} />
                  <button type="submit" name="op" value="primary" disabled={i === 0} title="Ορισμός ως κύρια" className="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-lg text-ink-500 hover:bg-ink-100 disabled:cursor-default disabled:opacity-30"><Star className="h-4 w-4" /></button>
                  <button type="submit" name="op" value="delete" title="Διαγραφή φωτογραφίας" className="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-lg text-ink-500 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </form>
                <p className="text-center text-xs text-ink-400">Φωτό {i + 1}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AdminForm action={saveProduct} submitLabel={product ? 'Αποθήκευση προϊόντος' : 'Δημιουργία προϊόντος'} stickyBar className="space-y-6">
        {product && <input type="hidden" name="id" value={product.id} />}

        <Card title="Βασικά στοιχεία">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Ονομασία (χωρίς τη μάρκα)" className="md:col-span-2"><input name="name" required defaultValue={product?.name} placeholder="EDGE 5W-30 LL" className="field" /></Field>
            <Field label="Μάρκα"><select name="brandId" defaultValue={product?.brandId ?? ''} className="field cursor-pointer"><option value="">—</option>{brandRows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="Κατηγορία"><select name="categoryId" defaultValue={product?.categoryId ?? ''} className="field cursor-pointer"><option value="">—</option>{categoryRows.map((c) => <option key={c.id} value={c.id}>{c.parentId ? `${parents.get(c.parentId)} › ` : ''}{c.name}</option>)}</select></Field>
            <Field label="Ιξώδες (SAE)" hint="π.χ. 5W-30. Είναι το βασικό φίλτρο αναζήτησης."><input name="viscosity" defaultValue={product?.viscosity ?? ''} placeholder="5W-30" className="field tabular" /></Field>
            <Field label="Τύπος λιπαντικού"><select name="baseType" defaultValue={product?.baseType ?? ''} className="field cursor-pointer"><option value="">—</option>{Object.entries(BASE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Σύντομη περιγραφή" className="md:col-span-2"><input name="shortDescription" defaultValue={product?.shortDescription ?? ''} className="field" /></Field>
            <Field label="Περιγραφή" hint="Αφήστε κενή γραμμή ανάμεσα στις παραγράφους." className="md:col-span-2"><textarea name="description" rows={6} defaultValue={product?.description ?? ''} className="field resize-y" /></Field>
            <Field label="Προδιαγραφές & εγκρίσεις" hint="Μία ανά γραμμή, ΑΚΡΙΒΩΣ όπως αναγράφονται στη συσκευασία (π.χ. ACEA C3, VW 504 00 / 507 00). Λάθος έγκριση = λάθος λάδι στον κινητήρα του πελάτη." className="md:col-span-2"><textarea name="specs" rows={5} defaultValue={(product?.specs ?? []).join('\n')} className="field tabular resize-y" /></Field>
          </div>
        </Card>

        <Card title="Συσκευασίες, τιμές & απόθεμα" description="Κάθε συσκευασία (1L, 4L, 20L…) έχει δική της τιμή, βάρος αποστολής και απόθεμα.">
          <VariantsEditor initial={rows} images={(product?.images ?? []).map((i) => i.url)} />
        </Card>

        <Card title="Προσθήκη φωτογραφιών" description="Τραβήξτε το προϊόν σε ανοιχτόχρωμο φόντο. Το σύστημα καθαρίζει το φόντο, κεντράρει και φέρνει όλες τις φωτογραφίες στο ίδιο μέγεθος.">
          <input type="file" name="images" accept="image/*" multiple className="block w-full cursor-pointer text-sm text-ink-700 file:mr-4 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-ink-900 file:px-4 file:text-sm file:font-semibold file:text-white hover:file:bg-ink-700" />
        </Card>

        <Card title="Προβολή & SEO">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 md:col-span-2">
              <Check name="isActive" label="Ενεργό (εμφανίζεται στο κατάστημα)" defaultChecked={product?.isActive ?? true} />
              <Check name="isFeatured" label="Προτεινόμενο (αρχική σελίδα, πρώτο στις λίστες)" defaultChecked={product?.isFeatured ?? false} />
            </div>
            <Field label="Διεύθυνση σελίδας (slug)" hint="Αφήστε το κενό για αυτόματη δημιουργία. Μην το αλλάζετε σε προϊόν που ήδη φαίνεται στο Google."><input name="slug" defaultValue={product?.slug ?? ''} className="field tabular" /></Field>
            <Field label="Επιπλέον λέξεις αναζήτησης" hint="Συνώνυμα με τα οποία το ψάχνουν οι πελάτες."><input name="keywords" placeholder="π.χ. λαδι vw golf tdi" className="field" /></Field>
            <Field label="Τίτλος για Google (προαιρετικό)"><input name="metaTitle" defaultValue={product?.metaTitle ?? ''} className="field" /></Field>
            <Field label="Περιγραφή για Google (προαιρετικό)"><input name="metaDescription" defaultValue={product?.metaDescription ?? ''} className="field" /></Field>
            <Field label="Εσωτερικές σημειώσεις" hint="Δεν εμφανίζονται στους πελάτες. Όσο υπάρχει κείμενο εδώ, το προϊόν μένει στη λίστα «προς έλεγχο»." className="md:col-span-2"><textarea name="internalNotes" rows={3} defaultValue={product?.internalNotes ?? ''} className="field resize-y" /></Field>
          </div>
        </Card>
      </AdminForm>

      {product && (
        <form action={deleteProduct} className="mt-10 border-t border-line pt-6">
          <input type="hidden" name="id" value={product.id} />
          <ConfirmButton message={`Οριστική διαγραφή του «${product.name}»; Οι παλιές παραγγελίες που το περιέχουν δεν επηρεάζονται.`} className="flex h-10 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-sm font-semibold text-red-700 hover:bg-red-50">
            <Trash2 className="h-4 w-4" />Διαγραφή προϊόντος
          </ConfirmButton>
          <p className="mt-1 px-3.5 text-xs text-ink-500">Αν απλώς δεν το έχετε προσωρινά, προτιμήστε να το κάνετε ανενεργό.</p>
        </form>
      )}
    </>
  );
}
