'use client';

import { useEffect } from 'react';
import { buttonClass } from '@/components/ui/button';

export default function StoreError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="container-page flex min-h-[55vh] flex-col items-center justify-center py-16 text-center">
      <h1 className="display text-3xl sm:text-4xl">Κάτι πήγε στραβά</h1>
      <p className="mt-3 max-w-md text-ink-600">Παρουσιάστηκε ένα απρόσμενο σφάλμα. Δοκιμάστε ξανά — αν επιμένει, καλέστε μας και θα σας εξυπηρετήσουμε τηλεφωνικά.</p>
      {error.digest && <p className="tabular mt-2 text-xs text-ink-400">Κωδικός σφάλματος: {error.digest}</p>}
      <button type="button" onClick={reset} className={buttonClass({ variant: 'dark', className: 'mt-7' })}>Δοκιμή ξανά</button>
    </div>
  );
}
