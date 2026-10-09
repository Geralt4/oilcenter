'use client';

import { useEffect } from 'react';
import { buttonClass } from '@/components/ui/button';

/** Something in the admin threw. Say so in Greek, keep the menu on screen, and offer a way back that is not the browser's reload. */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center py-16 text-center">
      <h1 className="text-2xl font-semibold text-ink-950">Κάτι πήγε στραβά</h1>
      <p className="mt-3 max-w-md text-ink-600">Η ενέργεια δεν ολοκληρώθηκε. Πριν ξαναδοκιμάσετε, ανοίξτε ξανά τη σελίδα και δείτε τι έχει ήδη αποθηκευτεί. Αν επιμένει, στείλτε τον παρακάτω κωδικό στον προγραμματιστή.</p>
      {error.digest && <p className="tabular mt-2 text-sm text-ink-500">Κωδικός σφάλματος: {error.digest}</p>}
      <button type="button" onClick={reset} className={buttonClass({ variant: 'dark', className: 'mt-7' })}>Δοκιμή ξανά</button>
    </div>
  );
}
