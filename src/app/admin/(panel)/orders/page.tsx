import Link from 'next/link';
import { and, count, desc, eq, like, or, type SQL } from 'drizzle-orm';
import { PageHeader, PaymentBadge, StatusBadge, td, th } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { orders, type OrderStatus } from '@/lib/db/schema';
import { ORDER_STATUS_LABELS } from '@/lib/orders';
import { PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/pricing';
import { cn, formatDateTime, formatPrice } from '@/lib/utils';

export const metadata = { title: 'Παραγγελίες' };
const PER_PAGE = 30;

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  const status = (Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).find((s) => s === sp.status);
  const q = (sp.q ?? '').trim().slice(0, 80);
  const page = Math.max(1, Number(sp.page) || 1);

  const filters: SQL[] = [];
  if (status) filters.push(eq(orders.status, status));
  if (q) filters.push(or(like(orders.number, `%${q.toUpperCase()}%`), like(orders.email, `%${q.toLowerCase()}%`), like(orders.lastName, `%${q}%`), like(orders.phone, `%${q}%`))!);
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [{ n: total }], byStatus] = await Promise.all([
    db.select().from(orders).where(where).orderBy(desc(orders.createdAt)).limit(PER_PAGE).offset((page - 1) * PER_PAGE),
    db.select({ n: count() }).from(orders).where(where),
    db.select({ status: orders.status, n: count() }).from(orders).groupBy(orders.status),
  ]);
  const counts = new Map(byStatus.map((r) => [r.status, r.n]));
  const href = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, q, ...params })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/orders?${s}` : '/admin/orders';
  };
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <PageHeader title="Παραγγελίες" description={`${total} ${total === 1 ? 'παραγγελία' : 'παραγγελίες'}`}>
        <form className="flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder="Αριθμός, e-mail, επώνυμο, τηλέφωνο" className="field h-10 w-72 max-w-full text-sm" />
          <button type="submit" className="h-10 cursor-pointer rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white hover:bg-ink-700">Αναζήτηση</button>
        </form>
      </PageHeader>

      <nav aria-label="Φίλτρο κατάστασης" className="no-scrollbar mb-4 flex gap-1.5 overflow-x-auto">
        <Link href={href({ status: undefined, page: undefined })} className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium', !status ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>Όλες</Link>
        {(Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).map((s) => (
          <Link key={s} href={href({ status: s, page: undefined })} className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium', status === s ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-line hover:bg-ink-50')}>
            {ORDER_STATUS_LABELS[s]} <span className="tabular opacity-60">{counts.get(s) ?? 0}</span>
          </Link>
        ))}
      </nav>

      <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-tile">
        <table className="w-full min-w-[52rem]">
          <thead><tr className="border-b border-line bg-ink-50"><th className={th}>Παραγγελία</th><th className={th}>Πελάτης</th><th className={th}>Αποστολή / πληρωμή</th><th className={th}>Κατάσταση</th><th className={th}>Πληρωμή</th><th className={cn(th, 'text-right')}>Σύνολο</th></tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((o) => (
              <tr key={o.id} className="hover:bg-ink-50">
                <td className={td}><Link href={`/admin/orders/${o.id}`} className="tabular font-semibold text-petrol-500 hover:underline">{o.number}</Link><span className="block text-xs text-ink-500">{formatDateTime(o.createdAt)}</span></td>
                <td className={td}>{o.firstName} {o.lastName}{o.isTest && <span className="ml-1.5 rounded bg-petrol-100 px-1.5 py-0.5 text-[0.625rem] font-bold text-petrol-700">TEST</span>}<span className="tabular block text-xs text-ink-500">{o.phone}</span></td>
                <td className={td}>{SHIPPING_LABELS[o.shippingMethod]}<span className="block text-xs text-ink-500">{PAYMENT_LABELS[o.paymentMethod]}</span></td>
                <td className={td}><StatusBadge status={o.status} /></td>
                <td className={td}><PaymentBadge status={o.paymentStatus} /></td>
                <td className={cn(td, 'tabular text-right font-semibold')}>{formatPrice(o.totalCents)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-ink-500">Δεν βρέθηκαν παραγγελίες.</td></tr>}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Σελίδες">
          {page > 1 ? <Link href={href({ page: String(page - 1) })} className="font-semibold text-petrol-500 hover:underline">← Νεότερες</Link> : <span />}
          <span className="tabular text-ink-500">Σελίδα {page} / {pages}</span>
          {page < pages ? <Link href={href({ page: String(page + 1) })} className="font-semibold text-petrol-500 hover:underline">Παλαιότερες →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
