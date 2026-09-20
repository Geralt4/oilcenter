import type { Metadata } from 'next';
import { BottomBar } from '@/components/store/bottom-bar';
import { CartDrawer } from '@/components/store/cart-drawer';
import { CookieNotice } from '@/components/store/cookie-notice';
import { Footer } from '@/components/store/footer';
import { Header } from '@/components/store/header';
import { StoreProvider, type PublicStoreConfig } from '@/components/store/store-context';
import { Tracker } from '@/components/store/tracker';
import { getAdmin, getCustomer } from '@/lib/auth/session';
import { getBrands, getCategoryTree } from '@/lib/catalog';
import { cardProvider } from '@/lib/payments';
import { mapsDirectionsUrl } from '@/lib/settings';
import { getSettings } from '@/lib/settings.server';
import { telHref } from '@/lib/utils';

// Every storefront page reads live prices / stock from the database.
export const dynamic = 'force-dynamic';

/** Demo mode = placeholder prices. Tell search engines to stay away until the owner switches it off. */
export async function generateMetadata(): Promise<Metadata> {
  const { storefront } = await getSettings();
  return storefront.demoMode ? { robots: { index: false, follow: false } } : {};
}

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const [settings, tree, brands, customer, admin] = await Promise.all([getSettings(), getCategoryTree(), getBrands(), getCustomer(), getAdmin()]);

  const { bankAccounts: _bankAccounts, ...payments } = settings.payments;
  const { ordersEnabled } = settings.storefront;
  const config: PublicStoreConfig = {
    shipping: settings.shipping,
    payments,
    vatRate: settings.tax.vatRate,
    cardProviderConfigured: cardProvider() !== null,
    demoMode: settings.storefront.demoMode,
    canOrder: ordersEnabled || admin !== null,
    adminTestOrders: !ordersEnabled && admin !== null,
    lowStockThreshold: settings.storefront.lowStockThreshold,
    phone: settings.shop.phone,
  };

  return (
    <StoreProvider config={config}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-oil-500 focus:px-4 focus:py-2 focus:font-semibold focus:text-ink-950">
        Μετάβαση στο περιεχόμενο
      </a>
      <Header settings={settings} tree={tree} brands={brands} customerName={customer ? customer.firstName || 'Λογαριασμός' : null} />
      <main id="main" className="pb-20 md:pb-0">
        {children}
      </main>
      <Footer settings={settings} tree={tree} />
      <BottomBar phoneHref={telHref(settings.shop.phone)} directionsHref={mapsDirectionsUrl(settings.shop)} />
      <CartDrawer />
      <CookieNotice />
      <Tracker />
    </StoreProvider>
  );
}
