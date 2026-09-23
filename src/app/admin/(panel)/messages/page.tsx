import Link from 'next/link';
import { count, desc, eq } from 'drizzle-orm';
import { Mail, Phone, Trash2 } from 'lucide-react';
import { messageAction } from '@/app/admin/actions';
import { ConfirmButton } from '@/components/admin/admin-form';
import { PageHeader } from '@/components/admin/ui';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { contactMessages, type EnquiryKind } from '@/lib/db/schema';
import { ENQUIRY_KINDS, ENQUIRY_KIND_LABELS } from '@/lib/enquiries';
import { cn, formatDateTime } from '@/lib/utils';

export const metadata = { title: 'Μηνύματα' };

type Props = { searchParams: Promise<{ kind?: string | string[] }> };

export default async function AdminMessagesPage({ searchParams }: Props) {
  await requireAdmin();
  const { kind: wanted } = await searchParams;
  const kind = ENQUIRY_KINDS.find((k) => k === (Array.isArray(wanted) ? wanted[0] : wanted)) ?? null;

  const [rows, totals] = await Promise.all([
    db.select().from(contactMessages).where(kind ? eq(contactMessages.kind, kind) : undefined).orderBy(desc(contactMessages.createdAt)).limit(200),
    db.select({ kind: contactMessages.kind, n: count() }).from(contactMessages).groupBy(contactMessages.kind),
  ]);
  const perKind = new Map<EnquiryKind, number>(totals.map((t) => [t.kind, t.n]));
  const all = totals.reduce((n, t) => n + t.n, 0);
  // a filter nobody has used yet is just noise: show a kind once it has a message (or is the one being viewed)
  const chips = [{ key: null as EnquiryKind | null, label: 'Όλα', n: all }, ...ENQUIRY_KINDS.filter((k) => perKind.has(k) || k === kind).map((k) => ({ key: k as EnquiryKind | null, label: ENQUIRY_KIND_LABELS[k], n: perKind.get(k) ?? 0 }))];

  return (
    <>
      <PageHeader title="Μηνύματα" description="Όσα στέλνουν οι επισκέπτες από τις φόρμες του καταστήματος: επικοινωνία, «ποιο λάδι θέλει το όχημά μου» και αιτήματα επαγγελματιών. Φτάνουν και στο e-mail του καταστήματος." />

      {chips.length > 2 && (
        <ul className="mb-5 flex flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c.key ?? 'all'}>
              <Link
                href={c.key ? `/admin/messages?kind=${c.key}` : '/admin/messages'}
                aria-current={c.key === kind ? 'page' : undefined}
                className={cn('flex h-10 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold', c.key === kind ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-800 hover:border-ink-400')}
              >
                {c.label}
                <span className="tabular text-xs font-medium opacity-60">{c.n}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <ul className="space-y-3">
        {rows.map((m) => (
          <li key={m.id} className={cn('rounded-2xl border bg-white p-4 shadow-tile sm:p-5', m.isRead ? 'border-line' : 'border-oil-400')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-ink-950">
                  {m.name}
                  {m.kind !== 'contact' && <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700">{ENQUIRY_KIND_LABELS[m.kind]}</span>}
                  {!m.isRead && <span className="ml-2 rounded-full bg-oil-500 px-2 py-0.5 text-xs font-bold text-ink-950">ΝΕΟ</span>}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
                  {m.phone && <a href={`tel:${m.phone}`} className="tabular inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Phone className="h-3.5 w-3.5" />{m.phone}</a>}
                  {m.email && <a href={`mailto:${m.email}${m.subject ? `?subject=${encodeURIComponent(`Re: ${m.subject}`)}` : ''}`} className="inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Mail className="h-3.5 w-3.5" />{m.email}</a>}
                </p>
              </div>
              <p className="text-xs text-ink-500">{formatDateTime(m.createdAt)}</p>
            </div>
            {m.subject && <p className="mt-3 text-sm font-semibold text-ink-900">{m.subject}</p>}
            {m.details && m.details.length > 0 && (
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {m.details.map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <dt className="shrink-0 text-ink-500">{label}</dt>
                    <dd className="min-w-0 font-medium text-ink-900">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {m.message && <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-800">{m.message}</p>}
            <form action={messageAction} className="mt-4 flex gap-4 text-sm font-semibold">
              <input type="hidden" name="id" value={m.id} />
              <button type="submit" name="op" value={m.isRead ? 'unread' : 'read'} className="cursor-pointer text-petrol-500 hover:underline">{m.isRead ? 'Σήμανση ως μη αναγνωσμένο' : 'Σήμανση ως αναγνωσμένο'}</button>
              <ConfirmButton name="op" value="delete" message="Διαγραφή του μηνύματος;" className="flex cursor-pointer items-center gap-1.5 text-red-700 hover:underline"><Trash2 className="h-3.5 w-3.5" />Διαγραφή</ConfirmButton>
            </form>
          </li>
        ))}
        {rows.length === 0 && <li className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">Δεν υπάρχουν μηνύματα.</li>}
      </ul>
    </>
  );
}
