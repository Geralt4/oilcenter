import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Boxes, PackageSearch, Phone, Truck } from 'lucide-react';
import { Breadcrumbs } from '@/components/store/product-listing';
import { QuoteForm } from '@/components/store/quote-form';
import { getBrands } from '@/lib/catalog';
import { getSettings } from '@/lib/settings.server';
import { telHref } from '@/lib/utils';

/*
 * Exists only while Admin → Ρυθμίσεις → «Σελίδα για συνεργεία & επαγγελματίες» is on; otherwise a 404, and no link
 * points here. The copy promises an answer with a quote — not discounts, credit or delivery terms, which are the
 * owner's to set per customer.
 */
export const metadata: Metadata = {
  title: 'Για συνεργεία & επαγγελματίες',
  description: 'Λιπαντικά, βαλβολίνες, αντιψυκτικά και χημικά για συνεργεία, στόλους και καταστήματα. Πείτε μας τι χρειάζεστε και σας στέλνουμε προσφορά. Oil Center, Θεσσαλονίκη.',
  alternates: { canonical: '/professionals' },
};

export default async function ProfessionalsPage() {
  const [{ shop, storefront, shipping }, brands] = await Promise.all([getSettings(), getBrands()]);
  if (!storefront.b2bPage) notFound();

  const points = [
    { icon: Boxes, title: `${brands.length}+ μάρκες από ένα σημείο`, text: 'Λάδια κινητήρα, βαλβολίνες, ATF, αντιψυκτικά, υγρά φρένων, πρόσθετα και σπρέι.' },
    { icon: PackageSearch, title: 'Και ό,τι δεν βλέπετε στο site', text: 'Το ηλεκτρονικό κατάστημα δείχνει ένα μέρος της γκάμας. Ζητήστε μας συγκεκριμένο προϊόν, προδιαγραφή ή συσκευασία.' },
    // delivery is promised only while the shop really takes online orders (catalogue mode otherwise)
    storefront.ordersEnabled && shipping.courierEnabled
      ? { icon: Truck, title: 'Παραλαβή ή αποστολή', text: `Από το κατάστημα στη ${shop.street} ή με courier σε όλη την Ελλάδα.` }
      : { icon: Truck, title: 'Παραλαβή από το κατάστημα', text: `Στη ${shop.street}.` },
  ];

  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Για επαγγελματίες', href: '/professionals' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Για συνεργεία & επαγγελματίες</h1>
      <p className="mt-3 max-w-2xl text-ink-600">Προμηθεύεστε λιπαντικά για συνεργείο, στόλο ή κατάστημα; Πείτε μας τι χρειάζεστε και σας στέλνουμε προσφορά.</p>

      <section className="mt-8 grid gap-8 rounded-3xl border border-line bg-white p-6 shadow-tile sm:p-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <ul className="space-y-5">
            {points.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-100 text-oil-800">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold text-ink-900">{title}</p>
                  <p className="text-sm text-ink-600">{text}</p>
                </div>
              </li>
            ))}
          </ul>

          <a href={telHref(shop.phone)} className="mt-6 flex items-center gap-3 rounded-2xl bg-ink-900 p-4 text-white transition-colors hover:bg-ink-800">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-500 text-ink-950">
              <Phone className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">Προτιμάτε το τηλέφωνο;</span>
              <span className="text-sm text-ink-300">Καλέστε μας στο <span className="tabular font-semibold text-oil-300">{shop.phone}</span>.</span>
            </span>
          </a>
        </div>

        <QuoteForm />
      </section>
    </div>
  );
}
