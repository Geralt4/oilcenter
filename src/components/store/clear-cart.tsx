'use client';

import { useEffect } from 'react';
import { useCart } from '@/lib/cart-store';
import { clearDraft } from '@/lib/checkout-draft';

/**
 * Rendered by the order page when it shows the order as placed (cash/bank/store orders) or paid (card). The checkout form no longer
 * empties the cart itself: a customer sent to the card page who comes back without paying (Back button, closed tab) still has the cart,
 * and it is emptied only when the order is really there. Emptying twice (a reload of the page) does nothing more.
 */
export function ClearCart() {
  useEffect(() => {
    useCart.getState().clear();
  }, []);
  return null;
}

/**
 * The order page forgets what was typed in the checkout form: that order exists now (or its page is open), the draft is stale.
 * Not rendered when the card payment could not start and the order was cancelled: the buyer goes back to the checkout and finds the form filled.
 */
export function ClearCheckoutDraft() {
  useEffect(() => {
    clearDraft();
  }, []);
  return null;
}
