import type { Metadata } from 'next';
import { CheckoutForm } from '@/components/store/checkout-form';
import { OrdersClosedNotice } from '@/components/store/orders-closed';
import { Breadcrumbs } from '@/components/store/product-listing';
import { getAdmin, getCustomer } from '@/lib/auth/session';
import { fullAddress } from '@/lib/settings';
import { getSettings } from '@/lib/settings.server';

export const metadata: Metadata = { title: 'Ολοκλήρωση παραγγελίας', robots: { index: false, follow: false } };

export default async function CheckoutPage() {
  const [settings, customer, admin] = await Promise.all([getSettings(), getCustomer(), getAdmin()]);
  const closed = !settings.storefront.ordersEnabled;

  // Pre-launch: the public sees no form at all (placeOrder refuses them anyway); a logged-in admin can place test orders.
  if (closed && !admin) {
    return (
      <div className="container-page py-6 sm:py-8">
        <Breadcrumbs items={[{ name: 'Καλάθι', href: '/cart' }, { name: 'Ολοκλήρωση παραγγελίας', href: '/checkout' }]} />
        <OrdersClosedNotice phone={settings.shop.phone} signup={settings.storefront.launchSignup} className="mt-6" />
      </div>
    );
  }

  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Καλάθι', href: '/cart' }, { name: 'Ολοκλήρωση παραγγελίας', href: '/checkout' }]} />
      <h1 className="display mt-5 mb-7 text-4xl sm:text-5xl">Ολοκλήρωση παραγγελίας</h1>
      {closed && (
        <p className="mb-6 rounded-2xl border border-petrol-100 bg-petrol-50 px-4 py-3 text-sm text-petrol-700">
          <strong>Μόνο για εσάς:</strong> οι online παραγγελίες είναι κλειστές για το κοινό. Βλέπετε το ταμείο επειδή είστε συνδεδεμένος ως διαχειριστής — ό,τι καταχωρήσετε σημειώνεται ως δοκιμαστική παραγγελία. Ανοίγουν από Διαχείριση → Ρυθμίσεις.
        </p>
      )}
      <CheckoutForm
        pickupAddress={fullAddress(settings.shop)}
        prefill={
          customer
            ? { email: customer.email, phone: customer.phone ?? '', firstName: customer.firstName, lastName: customer.lastName, street: customer.street ?? '', city: customer.city ?? '', postalCode: customer.postalCode ?? '', region: customer.region ?? '' }
            : {}
        }
      />
    </div>
  );
}
