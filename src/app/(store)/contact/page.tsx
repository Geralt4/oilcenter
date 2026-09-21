import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactForm } from '@/components/store/contact-form';
import { Breadcrumbs } from '@/components/store/product-listing';
import { StoreLocation } from '@/components/store/store-location';
import { localBusinessJsonLd } from '@/lib/seo';
import { getSettings } from '@/lib/settings.server';

export const metadata: Metadata = {
  title: 'Επικοινωνία & χάρτης',
  description: 'Oil Center — Τσακιρίδης Ηλίας, Σόλωνος 52, Θεσσαλονίκη. Τηλέφωνο 2310 850778. Χάρτης, οδηγίες, ωράριο και φόρμα επικοινωνίας.',
  alternates: { canonical: '/contact' },
};

export default async function ContactPage() {
  const settings = await getSettings();
  return (
    <div className="container-page py-6 sm:py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd(settings)) }} />
      <Breadcrumbs items={[{ name: 'Επικοινωνία', href: '/contact' }]} />
      <h1 className="display mt-5 text-4xl sm:text-5xl">Επικοινωνία</h1>
      <p className="mt-3 max-w-2xl text-ink-600">Ο πιο γρήγορος τρόπος είναι ένα τηλεφώνημα: πείτε μας το όχημά σας και σας λέμε αμέσως τι χρειάζεται. Αλλιώς, περάστε από το κατάστημα ή γράψτε μας.</p>

      <StoreLocation shop={settings.shop} className="mt-8" />

      <section className="mt-10 grid gap-8 rounded-3xl border border-line bg-white p-6 shadow-tile sm:p-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <h2 className="display text-3xl">Γράψτε μας</h2>
          <p className="mt-3 text-ink-600">Απαντάμε συνήθως μέσα στην ίδια εργάσιμη ημέρα. Για χονδρικές αγορές και συνεργεία, αναφέρετε τις ποσότητες που σας ενδιαφέρουν.</p>
          <p className="mt-3 text-ink-600">Ψάχνετε λάδι για συγκεκριμένο όχημα; Η <Link href="/find-my-oil" className="font-semibold text-petrol-500 underline underline-offset-2 hover:text-petrol-700">φόρμα οχήματος</Link> μάς δίνει ό,τι χρειαζόμαστε για να σας απαντήσουμε σωστά.</p>
          {settings.shop.fax && <p className="mt-4 text-sm text-ink-500">Fax: <span className="tabular">{settings.shop.fax}</span></p>}
        </div>
        <ContactForm />
      </section>
    </div>
  );
}
