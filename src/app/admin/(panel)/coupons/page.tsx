import { desc } from 'drizzle-orm';
import { Trash2 } from 'lucide-react';
import { deleteCoupon, saveCoupon } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { coupons, type Coupon } from '@/lib/db/schema';
import { centsToInput, cn, formatPrice } from '@/lib/utils';

export const metadata = { title: 'Κουπόνια' };

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

function CouponFields({ coupon }: { coupon?: Coupon }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {coupon && <input type="hidden" name="id" value={coupon.id} />}
      <Field label="Κωδικός"><input name="code" required defaultValue={coupon?.code} placeholder="KALOKAIRI10" className="field tabular uppercase" /></Field>
      <Field label="Τύπος">
        <select name="type" defaultValue={coupon?.type ?? 'percent'} className="field cursor-pointer">
          <option value="percent">Ποσοστό %</option><option value="fixed">Σταθερό ποσό €</option><option value="free_shipping">Δωρεάν μεταφορικά</option>
        </select>
      </Field>
      <Field label="Αξία" hint="Ποσοστό (π.χ. 10) ή ποσό σε € (π.χ. 5,00)."><input name="value" inputMode="decimal" defaultValue={coupon ? (coupon.type === 'fixed' ? centsToInput(coupon.value) : coupon.value || '') : ''} className="field tabular" /></Field>
      <Field label="Ελάχιστη αγορά €"><input name="minSubtotal" inputMode="decimal" defaultValue={coupon?.minSubtotalCents ? centsToInput(coupon.minSubtotalCents) : ''} className="field tabular" /></Field>
      <Field label="Μέγιστες χρήσεις" hint="Κενό = απεριόριστες."><input name="maxUses" inputMode="numeric" defaultValue={coupon?.maxUses ?? ''} className="field tabular" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Από"><input type="date" name="startsAt" defaultValue={iso(coupon?.startsAt ?? null)} className="field" /></Field>
        <Field label="Έως"><input type="date" name="endsAt" defaultValue={iso(coupon?.endsAt ?? null)} className="field" /></Field>
      </div>
      <div className="md:col-span-3"><Check name="isActive" label="Ενεργό" defaultChecked={coupon?.isActive ?? true} /></div>
    </div>
  );
}

export default async function AdminCouponsPage() {
  const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt));
  const describe = (c: Coupon) => (c.type === 'percent' ? `−${c.value}%` : c.type === 'fixed' ? `−${formatPrice(c.value)}` : 'Δωρεάν μεταφορικά');

  return (
    <>
      <PageHeader title="Κουπόνια" description="Εκπτωτικοί κωδικοί που συμπληρώνει ο πελάτης στο ταμείο." />
      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id}>
            <details className="group rounded-xl border border-line bg-white open:shadow-tile">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="tabular font-display text-lg font-bold text-ink-950">{c.code}</span>
                <span className="text-sm font-semibold text-ink-700">{describe(c)}</span>
                {c.minSubtotalCents > 0 && <span className="text-sm text-ink-500">άνω των {formatPrice(c.minSubtotalCents)}</span>}
                <span className="flex-1" />
                <span className="tabular text-sm text-ink-500">{c.usedCount}{c.maxUses !== null ? ` / ${c.maxUses}` : ''} χρήσεις</span>
                <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', c.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-600')}>{c.isActive ? 'Ενεργό' : 'Ανενεργό'}</span>
              </summary>
              <div className="border-t border-line p-4">
                <AdminForm action={saveCoupon} size="sm"><CouponFields coupon={c} /></AdminForm>
                <form action={deleteCoupon} className="mt-3">
                  <input type="hidden" name="id" value={c.id} />
                  <ConfirmButton message={`Διαγραφή του κουπονιού ${c.code};`} className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" />Διαγραφή</ConfirmButton>
                </form>
              </div>
            </details>
          </li>
        ))}
        {rows.length === 0 && <li className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center text-sm text-ink-500">Δεν υπάρχουν κουπόνια.</li>}
      </ul>
      <Card title="Νέο κουπόνι" className="mt-8"><AdminForm action={saveCoupon} submitLabel="Δημιουργία" resetOnSuccess><CouponFields /></AdminForm></Card>
    </>
  );
}
