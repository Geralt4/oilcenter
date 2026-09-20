import Link from 'next/link';
import { MapPin, Phone } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn, telHref } from '@/lib/utils';

/** Shown instead of the checkout button / form while the owner keeps online ordering closed (Admin → Ρυθμίσεις). */
export function OrdersClosedNotice({ phone, compact, onNavigate, className }: { phone: string; compact?: boolean; onNavigate?: () => void; className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-petrol-100 bg-petrol-50 text-petrol-700', compact ? 'p-4' : 'p-6 sm:p-8', className)}>
      <p className={cn('font-semibold text-ink-950', compact ? 'text-[0.9375rem]' : 'display text-2xl sm:text-3xl')}>Οι online παραγγελίες ανοίγουν σύντομα</p>
      <p className={cn('mt-1.5 text-ink-700', compact ? 'text-sm' : 'max-w-xl text-base')}>
        Μέχρι τότε πείτε μας τι χρειάζεστε στο τηλέφωνο ή περάστε από το κατάστημα. Το καλάθι σας μένει αποθηκευμένο.
      </p>
      <div className={cn('mt-4 grid gap-2', !compact && 'sm:flex')}>
        <a href={telHref(phone)} className={buttonClass({ size: compact ? 'md' : 'lg', className: 'tabular' })}>
          <Phone className="h-4 w-4" />
          {phone}
        </a>
        <Link href="/contact" onClick={onNavigate} className={buttonClass({ variant: 'outline', size: compact ? 'md' : 'lg' })}>
          <MapPin className="h-4 w-4" />
          Πού θα μας βρείτε
        </Link>
      </div>
    </div>
  );
}
