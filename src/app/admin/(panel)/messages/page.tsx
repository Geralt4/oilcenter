import { desc } from 'drizzle-orm';
import { Mail, Phone, Trash2 } from 'lucide-react';
import { messageAction } from '@/app/admin/actions';
import { ConfirmButton } from '@/components/admin/admin-form';
import { PageHeader } from '@/components/admin/ui';
import { db } from '@/lib/db';
import { contactMessages } from '@/lib/db/schema';
import { cn, formatDateTime } from '@/lib/utils';

export const metadata = { title: 'Μηνύματα' };

export default async function AdminMessagesPage() {
  const rows = await db.select().from(contactMessages).orderBy(desc(contactMessages.createdAt)).limit(200);
  return (
    <>
      <PageHeader title="Μηνύματα" description="Όσα στέλνουν οι επισκέπτες από τη φόρμα επικοινωνίας. Φτάνουν και στο e-mail του καταστήματος." />
      <ul className="space-y-3">
        {rows.map((m) => (
          <li key={m.id} className={cn('rounded-2xl border bg-white p-4 shadow-tile sm:p-5', m.isRead ? 'border-line' : 'border-oil-400')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-ink-950">{m.name}{!m.isRead && <span className="ml-2 rounded-full bg-oil-500 px-2 py-0.5 text-xs font-bold text-ink-950">ΝΕΟ</span>}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
                  <a href={`mailto:${m.email}${m.subject ? `?subject=${encodeURIComponent(`Re: ${m.subject}`)}` : ''}`} className="inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Mail className="h-3.5 w-3.5" />{m.email}</a>
                  {m.phone && <a href={`tel:${m.phone}`} className="tabular inline-flex items-center gap-1.5 text-petrol-500 hover:underline"><Phone className="h-3.5 w-3.5" />{m.phone}</a>}
                </p>
              </div>
              <p className="text-xs text-ink-500">{formatDateTime(m.createdAt)}</p>
            </div>
            {m.subject && <p className="mt-3 text-sm font-semibold text-ink-900">{m.subject}</p>}
            <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-800">{m.message}</p>
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
