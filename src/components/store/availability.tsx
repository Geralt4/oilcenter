import { AVAILABILITY_SHORT, AVAILABILITY_TONE, type Availability } from '@/lib/availability';
import { cn } from '@/lib/utils';

/**
 * Small "dot + two words" note for cart lines, the checkout summary and order pages. Says nothing for a size that is
 * on the shelf: only a wait is worth the buyer's attention there.
 */
export function AvailabilityTag({ availability, always, className }: { availability: Availability | null | undefined; always?: boolean; className?: string }) {
  if (!availability || (availability === 'in_stock' && !always)) return null;
  const tone = AVAILABILITY_TONE[availability];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone.text, className)}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />
      {AVAILABILITY_SHORT[availability]}
    </span>
  );
}
