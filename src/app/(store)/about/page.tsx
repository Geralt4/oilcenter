import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { BadgePercent, Boxes, Handshake, Wrench } from 'lucide-react';
import { Breadcrumbs } from '@/components/store/product-listing';
import { StoreLocation } from '@/components/store/store-location';
import { buttonClass } from '@/components/ui/button';
import { getBrands } from '@/lib/catalog';
import { getSettings } from '@/lib/settings.server';

export const metadata: Metadata = {
  title: 'Το κατάστημα',
  description: 'Η επιχείρηση εμπορίας λιπαντικών Τσακιρίδης Ηλίας στη Σόλωνος 52, Θεσσαλονίκη: λιπαντικά, χημικά και ανταλλακτικά αυτοκινήτου σε τιμές χονδρικής.',
  alternates: { canonical: '/about' },
};

// What the shop stocks beyond the online catalogue (taken from the shop's own previous website).
const IN_STORE = [
  { title: 'Ανταλλακτικά', items: ['Αμορτισέρ', 'Τακάκια & σιαγόνες', 'Μπουζί NGK · Bosch · Denso', 'Μπαταρίες Bosch', 'Φίλτρα αέρος, λαδιού, βενζίνης, A/C', 'Υαλοκαθαριστήρες Valeo', 'Συμπλέκτες', 'Αισθητήρες λάμδα', 'Κυλινδράκια & φυσούνες'] },
  { title: 'Χημικά & φροντίδα', items: ['Καθαριστικά φρένων & επαφών', 'Σπρέι σιλικόνης, τεφλόν, χαλκού', 'Καθαριστικά ζαντών & ταπετσαρίας', 'Γυαλιστικά ταμπλό & ελαστικών', 'Αλοιφές γρατζουνιών', 'Αρωματικά αυτοκινήτου', 'Προϊόντα LPG', 'Πάστα χεριών'] },
  { title: 'Ειδικά λιπαντικά', items: ['Γράσα λιθίου, ασβεστίου, θαλάσσης, γραφίτη', 'Υδραυλικά 32 · 46 · 68', 'Universal tractor 10W-30 · 20W-30 · 20W-40', 'Outboard 2T & 4T για εξωλέμβιες', 'ATF Dexron II · III · VI', 'LHM για Citroën', 'Υγρά φρένων DOT 4 · DOT 5'] },
];

export default async function AboutPage() {
  const [settings, brands] = await Promise.all([getSettings(), getBrands()]);
  const { shop } = settings;

  const values = [
    { icon: BadgePercent, title: 'Τιμές χονδρικής για όλους', text: 'Ό,τι ψάχνετε σε τιμές χονδρικής, ακόμα και για αγορές λιανικής.' },
    { icon: Boxes, title: `${brands.length}+ μάρκες στο ράφι`, text: 'Οι δημοφιλέστερες μάρκες λιπαντικών, άμεσα διαθέσιμες στο κατάστημα.' },
    { icon: Handshake, title: 'Εξουσιοδοτημένος αντιπρόσωπος accelerate', text: 'Γερμανικά λιπαντικά με εγκρίσεις κατασκευαστών, απευθείας από τον αντιπρόσωπο.' },
    { icon: Wrench, title: 'Συμβουλή από ανθρώπους που ξέρουν', text: 'Πείτε μας το όχημα και σας λέμε ακριβώς τι λάδι, πόσα λίτρα και ποιο φίλτρο χρειάζεται.' },
  ];

  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs items={[{ name: 'Το κατάστημα', href: '/about' }]} />

      <div className="mt-6 grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="eyebrow text-oil-700">{shop.legalName}</p>
          <h1 className="display mt-2 text-4xl sm:text-6xl">Λιπαντικά σε τιμές χονδρικής, στην καρδιά της Θεσσαλονίκης</h1>
          <div className="prose-oc mt-6 text-lg">
            <p>Στη {shop.street} στη Θεσσαλονίκη λειτουργεί η έδρα της επιχείρησης εμπορίας λιπαντικών αυτοκινήτων <strong>{shop.legalName}</strong>. Στο κατάστημά μας θα βρείτε τις δημοφιλέστερες μάρκες λιπαντικών στις χαμηλότερες τιμές της αγοράς, καθώς και μεγάλη γκάμα ανταλλακτικών. Διαθέτουμε ακόμη αντιψυκτικά, paraflu, γράσα και λάδια υδραυλικού.</p>
            <p>Ελάτε να μας γνωρίσετε, για να σας εξυπηρετήσουμε όπως μόνο εμείς ξέρουμε και μπορούμε!</p>
          </div>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/products" className={buttonClass({ size: 'lg' })}>Δείτε τα προϊόντα</Link>
            <Link href="/contact" className={buttonClass({ variant: 'outline', size: 'lg' })}>Επικοινωνία</Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="relative col-span-2 aspect-[16/10] overflow-hidden rounded-3xl shadow-tile">
            <Image src="/shop/counter-mobil-super.webp" alt="Ράφια με λιπαντικά στο κατάστημα Oil Center" fill priority sizes="(min-width: 1024px) 600px, 100vw" className="object-cover object-[50%_25%]" />
          </div>
          <div className="relative aspect-square overflow-hidden rounded-3xl shadow-tile">
            <Image src="/shop/counter-mobil-1.webp" alt="Mobil 1 στον πάγκο του καταστήματος" fill sizes="(min-width: 1024px) 300px, 50vw" className="object-cover" />
          </div>
          <div className="relative aspect-square overflow-hidden rounded-3xl shadow-tile">
            <Image src="/shop/counter-mobil-esp.webp" alt="Mobil 1 ESP στον πάγκο του καταστήματος" fill sizes="(min-width: 1024px) 300px, 50vw" className="object-cover" />
          </div>
        </div>
      </div>

      <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {values.map(({ icon: Icon, title, text }) => (
          <li key={title} className="rounded-3xl border border-line bg-white p-6 shadow-tile">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-900 text-oil-400"><Icon className="h-5 w-5" /></span>
            <h2 className="mt-4 font-bold text-ink-950">{title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{text}</p>
          </li>
        ))}
      </ul>

      <section className="steel mt-14 rounded-3xl p-6 text-white sm:p-10">
        <h2 className="display text-3xl sm:text-4xl">Στο κατάστημα θα βρείτε πολύ περισσότερα</h2>
        <p className="mt-3 max-w-2xl text-ink-200">Το ηλεκτρονικό κατάστημα δείχνει μόνο ένα μέρος της γκάμας μας. Αν δεν βρίσκετε κάτι εδώ, καλέστε μας — πιθανότατα το έχουμε στο ράφι.</p>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          {IN_STORE.map((group) => (
            <div key={group.title}>
              <h3 className="eyebrow text-oil-300">{group.title}</h3>
              <ul className="mt-3 space-y-1.5 text-[0.9375rem] text-ink-100">
                {group.items.map((item) => <li key={item} className="flex gap-2"><span className="text-oil-400">·</span>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <StoreLocation shop={shop} className="mt-14" />
    </div>
  );
}
