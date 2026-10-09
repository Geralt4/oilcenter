'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AVAILABILITY, AVAILABILITY_SHORT, type Availability } from '@/lib/availability';

export type VariantRow = {
  id?: number;
  label: string;
  sku: string;
  price: string;
  compareAt: string;
  stock: number;
  trackStock: boolean;
  availability: Availability;
  weightGrams: number;
  barcode: string;
  mpn: string;
  imageUrl: string;
  isActive: boolean;
  priceVerified: boolean;
};

const blank = (): VariantRow => ({ label: '', sku: '', price: '', compareAt: '', stock: 0, trackStock: false, availability: 'in_stock', weightGrams: 0, barcode: '', mpn: '', imageUrl: '', isActive: true, priceVerified: true });

/** Edits a product's pack sizes. The rows travel to the server action as JSON in one hidden field. */
export function VariantsEditor({ initial, images }: { initial: VariantRow[]; images: string[] }) {
  const [rows, setRows] = useState<VariantRow[]>(initial.length ? initial : [blank()]);
  const patch = (i: number, change: Partial<VariantRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const cell = 'field h-10 px-2.5 text-sm';

  return (
    <div>
      {/* a photo deleted since this row was loaded is no longer a choice: never send its dead link back */}
      <input type="hidden" name="variants" value={JSON.stringify(rows.map((r) => (r.imageUrl && !images.includes(r.imageUrl) ? { ...r, imageUrl: '' } : r)))} />
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        <table className="w-full min-w-[80rem] border-separate border-spacing-y-1.5 text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold tracking-wide text-ink-500 uppercase">
              <th className="pr-2">Συσκευασία</th><th className="pr-2">Τιμή €</th><th className="pr-2">Αρχική €</th><th className="pr-2">Βάρος (g)</th><th className="pr-2">Απόθεμα</th><th className="pr-2">Διαθεσιμότητα</th><th className="pr-2">Κωδικός (SKU)</th><th className="pr-2">Barcode (EAN)</th><th className="pr-2">Κωδ. κατασκευαστή</th><th className="pr-2">Φωτογραφία</th><th className="pr-2">Ενεργή</th><th className="pr-2">Τιμή ΟΚ</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? `new-${i}`}>
                <td className="pr-2"><input value={r.label} onChange={(e) => patch(i, { label: e.target.value })} placeholder="1L" aria-label="Συσκευασία" className={`${cell} w-20`} /></td>
                <td className="pr-2"><input value={r.price} onChange={(e) => patch(i, { price: e.target.value, priceVerified: true })} inputMode="decimal" placeholder="12,90" aria-label="Τιμή" className={`${cell} tabular w-24`} /></td>
                <td className="pr-2"><input value={r.compareAt} onChange={(e) => patch(i, { compareAt: e.target.value })} inputMode="decimal" placeholder="—" aria-label="Αρχική τιμή" className={`${cell} tabular w-24`} /></td>
                <td className="pr-2"><input value={r.weightGrams || ''} onChange={(e) => patch(i, { weightGrams: Number(e.target.value) || 0 })} inputMode="numeric" aria-label="Βάρος σε γραμμάρια" className={`${cell} tabular w-24`} /></td>
                <td className="pr-2">
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={r.trackStock} onChange={(e) => patch(i, { trackStock: e.target.checked })} title="Παρακολούθηση αποθέματος" aria-label="Παρακολούθηση αποθέματος" className="h-4 w-4 cursor-pointer accent-ink-900" />
                    <input value={r.trackStock ? r.stock : ''} disabled={!r.trackStock} onChange={(e) => patch(i, { stock: Math.max(0, Math.round(Number(e.target.value)) || 0) })} inputMode="numeric" placeholder="∞" aria-label="Τεμάχια" className={`${cell} tabular w-16`} />
                  </div>
                </td>
                <td className="pr-2">
                  <select value={r.availability} onChange={(e) => patch(i, { availability: e.target.value as Availability })} aria-label="Διαθεσιμότητα" className={`${cell} w-44 cursor-pointer`}>
                    {AVAILABILITY.map((a) => <option key={a} value={a}>{AVAILABILITY_SHORT[a]}</option>)}
                  </select>
                </td>
                <td className="pr-2"><input value={r.sku} onChange={(e) => patch(i, { sku: e.target.value.toUpperCase() })} placeholder="αυτόματα" aria-label="SKU" className={`${cell} tabular w-52`} /></td>
                <td className="pr-2"><input value={r.barcode} onChange={(e) => patch(i, { barcode: e.target.value })} inputMode="numeric" aria-label="Barcode (EAN)" className={`${cell} tabular w-36`} /></td>
                <td className="pr-2"><input value={r.mpn} onChange={(e) => patch(i, { mpn: e.target.value })} aria-label="Κωδικός κατασκευαστή (MPN)" className={`${cell} tabular w-28`} /></td>
                <td className="pr-2">
                  <select value={images.includes(r.imageUrl) ? r.imageUrl : ''} onChange={(e) => patch(i, { imageUrl: e.target.value })} aria-label="Φωτογραφία συσκευασίας" className={`${cell} w-28 cursor-pointer`}>
                    <option value="">1η φωτό</option>
                    {images.map((url, n) => <option key={url} value={url}>Φωτό {n + 1}</option>)}
                  </select>
                </td>
                <td className="pr-2 text-center"><input type="checkbox" checked={r.isActive} onChange={(e) => patch(i, { isActive: e.target.checked })} aria-label="Ενεργή" className="h-4 w-4 cursor-pointer accent-ink-900" /></td>
                <td className="pr-2 text-center"><input type="checkbox" checked={r.priceVerified} onChange={(e) => patch(i, { priceVerified: e.target.checked })} aria-label="Η τιμή είναι επιβεβαιωμένη" className="h-4 w-4 cursor-pointer accent-emerald-600" /></td>
                <td><button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))} disabled={rows.length === 1} aria-label="Αφαίρεση συσκευασίας" className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-ink-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setRows((rs) => [...rs, blank()])} className="mt-2 flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-petrol-500 hover:bg-petrol-50">
        <Plus className="h-4 w-4" />Προσθήκη συσκευασίας
      </button>
      <p className="mt-2 text-xs text-ink-500">Τσεκάρετε το κουτάκι στο «Απόθεμα» μόνο αν θέλετε να μετράτε τεμάχια: όταν φτάσει στο 0 η συσκευασία εμφανίζεται «Εξαντλήθηκε». Χωρίς τσεκ πωλείται ελεύθερα, και το τι βλέπει ο πελάτης το ορίζει η «Διαθεσιμότητα»: «Μη διαθέσιμο» = φαίνεται με την τιμή του αλλά δεν μπαίνει στο καλάθι. Το barcode και ο κωδικός κατασκευαστή βρίσκονται στην ετικέτα της συσκευασίας· τα χρειάζεται το Skroutz για να αναγνωρίσει το προϊόν.</p>
    </div>
  );
}
