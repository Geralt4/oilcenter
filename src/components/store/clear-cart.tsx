'use client';

import { useEffect } from 'react';
import { useCart } from '@/lib/cart-store';

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
