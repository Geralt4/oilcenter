'use client';

import { useState, useTransition } from 'react';
import { CreditCard, LoaderCircle } from 'lucide-react';
import { retryCardPayment } from '@/app/(store)/checkout/actions';
import { buttonClass } from '@/components/ui/button';

export function RetryPayment({ number, token }: { number: string; token: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await retryCardPayment(number, token);
            if (result.ok) window.location.assign(result.redirectUrl);
            else setError(result.message);
          })
        }
        className={buttonClass({})}
      >
        {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
        Πληρωμή με κάρτα
      </button>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
