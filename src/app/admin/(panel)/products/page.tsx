import Image from 'next/image';
import Link from 'next/link';
import { asc } from 'drizzle-orm';
import { Plus, TriangleAlert } from 'lucide-react';
import { PageHeader, td, th } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { db } from '@/lib/db';
import { brands, categories, productImages, products, variants } from '@/lib/db/schema';
import { cn, formatPrice, normalizeText } from '@/lib/utils';

export const metadata = { title: 'Προϊόντα' };
const PER_PAGE = 40;

export default async function AdminProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string; filter?: string; page?: string; deleted?: string }> }) {
  const sp = await searchParams;
  const [productRows, variantRows, imageRows, brandRows, categoryRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.name)),
    db.select().from(variants).orderBy(asc(variants.sort)),
    db.select().from(productImages).orderBy(asc(productImages.sort)),
    db.select().from(brands).orderBy(asc(brands.name)),
    db.select().from(categories),
  ]);
  const brandName = new Map(brandRows.map((b) => [b.id, b.name]));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const firstImage = new Map<number, string>();
  for (const i of imageRows) if (!firstImage.has(i.productId)) firstImage.set(i.productId, i.url);
  const byProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);

  const terms = normalizeText(sp.q ?? '').split(' ').filter(Boolean);
  const brandId = Number(sp.brand) || null;
  let list = productRows.filter((p) => terms.every((t) => p.searchText.includes(t)) && (!brandId || p.brandId === brandId));
  if (sp.filter === 'review') list = list.filter((p) => p.internalNotes);
  if (sp.filter === 'inactive') list = list.filter((p) => !p.isActive);
  if (sp.filter === 'unverified') list = list.filter((p) => (byProduct.get(p.id) ?? []).some((v) => !v.priceVerified));
  if (sp.filter === 'soldout') list = list.filter((p) => (byProduct.get(p.id) ?? []).some((v) => v.trackStock && v.stock <= 0));

  const page = Math.max(1, Number(sp.page) || 1);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const shown = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const href = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, brand: sp.brand, filter: sp.filter, ...params })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/products?${s}` : '/admin/products';
  };
  const chips = [
    { key: undefined, label: 'Όλα' },
    { key: 'review', label: 'Προς έλεγχο' },
    { key: 'unverified', label: 'Ενδεικτική τιμή' },
    { key: 'soldout', label: 'Εξαντλημένα' },
    { key: 'inactive', label: 'Ανενεργά' },
  ];

  return (
    <>
      <PageHeader title="Προϊόντα" description={`${list.length} από ${productRows.length}`}>
        <Link href="/admin/products/new" className={buttonClass({ size: 'sm' })}><Plus className="h-4 w-4" />Νέο προϊόν</Link>
      </PageHeader>
      {sp.deleted && <p role="status" className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">Το προϊόν διαγράφηκε.</p>}

      <form className="mb-4 flex flex-wrap gap-2">
        {sp.filter && <input type="hidden" name="filter" value={sp.filter} />}
        <input name="q" defaultValue={sp.q ?? ''} placeholder="Αναζήτηση: όνομα, ιξώδες, προδιαγραφή…" className="field h-10 w-80 max-w-full text-sm" />
        <select name="brand" defaultValue={sp.brand ?? ''} className="field h-10 w-44 cursor-pointer py-0 text-sm"><option value="">Όλες οι μάρκες</option>{brandRows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <button type="submit" className="h-10 cursor-pointer rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white hover:bg-ink-700">Φίλτρο</button>
      </form>
      <nav className="no-scrollbar mb-4 flex gap-1.5 overflow-x-auto" aria-label="Γρήγορα φίλτρα">
        {chips.map((c) => <Link key={c.label} href={href({ filter: c.key, page: undefined })} className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium', sp.filter === c.key || (!sp.filter && !c.key) ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>{c.label}</Link>)}
      </nav>

      <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-tile">
        <table className="w-full min-w-[50rem]">
          <thead><tr className="border-b border-line bg-ink-50"><th className={th}>Προϊόν</th><th className={th}>Κατηγορία</th><th className={th}>Συσκευασίες & τιμές</th><th className={th}>Κατάσταση</th></tr></thead>
          <tbody className="divide-y divide-line">
            {shown.map((p) => {
              const vs = byProduct.get(p.id) ?? [];
              const image = firstImage.get(p.id);
              return (
                <tr key={p.id} className="hover:bg-ink-50">
                  <td className={td}>
                    <Link href={`/admin/products/${p.id}`} className="flex items-center gap-3">
                      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-line bg-white">{image && <Image src={image} alt="" fill sizes="48px" className="object-contain p-0.5" />}</span>
                      <span><span className="block text-xs font-semibold tracking-wide text-ink-400 uppercase">{p.brandId ? brandName.get(p.brandId) : '—'}</span><span className="font-semibold text-petrol-500 hover:underline">{p.name}</span></span>
                    </Link>
                  </td>
                  <td className={td}>{p.categoryId ? categoryName.get(p.categoryId) : <span className="text-red-600">Χωρίς κατηγορία</span>}</td>
                  <td className={td}>
                    <span className="flex flex-wrap gap-1">
                      {vs.map((v) => (
                        <span key={v.id} className={cn('tabular rounded-md px-1.5 py-0.5 text-xs', !v.isActive ? 'bg-ink-100 text-ink-400 line-through' : v.priceVerified ? 'bg-ink-100 text-ink-800' : 'bg-amber-100 text-amber-900')} title={v.priceVerified ? 'Επιβεβαιωμένη τιμή' : 'Ενδεικτική τιμή'}>
                          {v.label} · {formatPrice(v.priceCents)}{v.trackStock ? ` · ${v.stock} τεμ.` : ''}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={td}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', p.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-600')}>{p.isActive ? 'Ενεργό' : 'Ανενεργό'}</span>
                      {p.isFeatured && <span className="rounded-full bg-oil-100 px-2.5 py-1 text-xs font-semibold text-oil-800">Προτεινόμενο</span>}
                      {p.internalNotes && <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900" title={p.internalNotes}><TriangleAlert className="h-3 w-3" />Έλεγχος</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={4} className="px-4 py-12 text-center text-sm text-ink-500">Δεν βρέθηκαν προϊόντα.</td></tr>}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Σελίδες">
          {page > 1 ? <Link href={href({ page: String(page - 1) })} className="font-semibold text-petrol-500 hover:underline">← Προηγούμενη</Link> : <span />}
          <span className="tabular text-ink-500">Σελίδα {page} / {pages}</span>
          {page < pages ? <Link href={href({ page: String(page + 1) })} className="font-semibold text-petrol-500 hover:underline">Επόμενη →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
