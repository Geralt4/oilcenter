import type { OrderStatus, PaymentStatus } from '@/lib/db/schema';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@/lib/orders';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-950">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-600">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Card({ title, description, children, className }: { title?: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-white p-4 shadow-tile sm:p-6', className)}>
      {title && <h2 className="text-base font-bold text-ink-950">{title}</h2>}
      {description && <p className="mt-1 text-sm text-ink-600">{description}</p>}
      <div className={cn((title || description) && 'mt-4')}>{children}</div>
    </section>
  );
}

const STATUS_TONE: Record<OrderStatus, string> = {
  pending: 'bg-amber-100 text-amber-900',
  confirmed: 'bg-petrol-100 text-petrol-700',
  processing: 'bg-petrol-100 text-petrol-700',
  shipped: 'bg-indigo-100 text-indigo-800',
  ready_for_pickup: 'bg-indigo-100 text-indigo-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-800',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={cn('inline-block rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap', STATUS_TONE[status])}>{ORDER_STATUS_LABELS[status]}</span>;
}

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={cn('inline-block rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap', status === 'paid' ? 'bg-emerald-100 text-emerald-800' : status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-ink-100 text-ink-700')}>{PAYMENT_STATUS_LABELS[status]}</span>;
}

export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export function Check({ name, label, defaultChecked, hint }: { name: string; label: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
      <span className="text-sm">
        <span className="font-medium text-ink-900">{label}</span>
        {hint && <span className="block text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

export const th = 'px-3 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-500 uppercase';
export const td = 'px-3 py-3 align-middle text-sm text-ink-800';
