'use client';

import { LogOut } from 'lucide-react';
import { logoutCustomer } from '@/app/(store)/account/actions';
import { buttonClass } from '@/components/ui/button';
import { clearDraft } from '@/lib/checkout-draft';

/** The sign-out button of the account page. Whatever was typed into the checkout form stays in this tab's storage otherwise (lib/checkout-draft.ts): the next person at this browser must not find it. */
export function LogoutForm() {
  return (
    <form action={logoutCustomer} onSubmit={() => clearDraft()}>
      <button type="submit" className={buttonClass({ variant: 'outline' })}><LogOut className="h-4 w-4" />Αποσύνδεση</button>
    </form>
  );
}
