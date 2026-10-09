'use client';

import { createContext, useContext } from 'react';
import type { ShopSettings } from '@/lib/settings';

/** The slice of settings that client components need. Nothing secret goes in here. */
export type PublicStoreConfig = {
  shipping: ShopSettings['shipping'];
  payments: Omit<ShopSettings['payments'], 'bankAccounts'>;
  vatRate: number;
  cardProviderConfigured: boolean;
  demoMode: boolean;
  /**
   * Can THIS visitor use the shop part — cart, checkout, account? false while ordering is closed to the public.
   * Closed means catalogue mode: the site is a plain website (products, prices, contact) and every cart control,
   * shop page and «παραγγείλετε online» sentence is hidden, not merely disabled.
   */
  canOrder: boolean;
  /** ordering is closed to the public but this visitor is a logged-in admin placing test orders */
  adminTestOrders: boolean;
  lowStockThreshold: number;
  phone: string;
  /** «Σόλωνος 52, Θεσσαλονίκη» — where to send a visitor who cannot order online */
  address: string;
};

const StoreContext = createContext<PublicStoreConfig | null>(null);

export function StoreProvider({ config, children }: { config: PublicStoreConfig; children: React.ReactNode }) {
  return <StoreContext.Provider value={config}>{children}</StoreContext.Provider>;
}

export function useStoreConfig(): PublicStoreConfig {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStoreConfig must be used inside <StoreProvider>');
  return ctx;
}
