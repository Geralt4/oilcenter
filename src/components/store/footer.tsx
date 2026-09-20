import Link from 'next/link';
import { Banknote, Clock, CreditCard, Landmark, Mail, MapPin, Navigation, Phone, Store, Truck } from 'lucide-react';
import { FacebookIcon, Logo } from '@/components/logo';
import type { CategoryNode } from '@/lib/catalog';
import { fullAddress, groupedHours, mapsDirectionsUrl, mapsPlaceUrl, type ShopSettings } from '@/lib/settings';
import { telHref } from '@/lib/utils';

export function Footer({ settings, tree }: { settings: ShopSettings; tree: CategoryNode[] }) {
  const { shop } = settings;
  return (
    <footer className="steel mt-20 text-ink-300">
      <div className="container-page grid gap-10 py-14 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1.2fr]">
        <div>
          <Logo tone="light" />
          <p className="mt-5 max-w-sm text-sm leading-relaxed">
            {shop.legalName} — εμπορία λιπαντικών, χημικών και ανταλλακτικών αυτοκινήτου στη Θεσσαλονίκη. Τιμές χονδρικής, ακόμα και για αγορές λιανικής.
          </p>
          <ul className="mt-6 space-y-3 text-sm">
            <li>
              <a href={telHref(shop.phone)} className="flex items-center gap-3 text-base font-semibold text-white hover:text-oil-300">
                <Phone className="h-4 w-4 text-oil-400" />
                <span className="tabular">{shop.phone}</span>
              </a>
            </li>
            {shop.mobile && (
              <li>
                <a href={telHref(shop.mobile)} className="flex items-center gap-3 text-base font-semibold text-white hover:text-oil-300">
                  <Phone className="h-4 w-4 text-oil-400" />
                  <span className="tabular">{shop.mobile}</span>
                </a>
              </li>
            )}
            <li>
              <a href={`mailto:${shop.email}`} className="flex items-center gap-3 hover:text-white">
                <Mail className="h-4 w-4 text-oil-400" />
                {shop.email}
              </a>
            </li>
            <li>
              <a href={mapsPlaceUrl(shop)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 hover:text-white">
                <MapPin className="h-4 w-4 shrink-0 text-oil-400" />
                {fullAddress(shop)}
              </a>
            </li>
          </ul>
          <a href={mapsDirectionsUrl(shop)} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-oil-500 px-5 text-sm font-semibold text-ink-950 hover:bg-oil-400">
            <Navigation className="h-4 w-4" />
            Οδηγίες προς το κατάστημα
          </a>
        </div>

        <nav aria-label="Κατηγορίες προϊόντων">
          <h2 className="eyebrow text-white">Προϊόντα</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            {tree.map((c) => (
              <li key={c.id}>
                <Link href={`/category/${c.slug}`} className="hover:text-white">{c.name}</Link>
              </li>
            ))}
            <li><Link href="/brands" className="hover:text-white">Όλες οι μάρκες</Link></li>
          </ul>
        </nav>

        <nav aria-label="Εξυπηρέτηση">
          <h2 className="eyebrow text-white">Εξυπηρέτηση</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><Link href="/order-status" className="hover:text-white">Η παραγγελία μου</Link></li>
            <li><Link href="/shipping-payments" className="hover:text-white">Αποστολές & πληρωμές</Link></li>
            <li><Link href="/returns" className="hover:text-white">Επιστροφές & υπαναχώρηση</Link></li>
            <li><Link href="/about" className="hover:text-white">Το κατάστημα</Link></li>
            <li><Link href="/contact" className="hover:text-white">Επικοινωνία</Link></li>
            <li><Link href="/account" className="hover:text-white">Ο λογαριασμός μου</Link></li>
          </ul>
        </nav>

        <div>
          <h2 className="eyebrow flex items-center gap-2 text-white">
            <Clock className="h-3.5 w-3.5 text-oil-400" />
            Ωράριο
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            {groupedHours(shop.hours).map((g) => (
              <div key={g.label} className="flex justify-between gap-4">
                <dt>{g.label}</dt>
                <dd className="tabular text-right font-medium text-white">{g.hours}</dd>
              </div>
            ))}
          </dl>
          {shop.facebookUrl && (
            <a href={shop.facebookUrl} target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex items-center gap-2 text-sm hover:text-white">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10"><FacebookIcon className="h-4 w-4" /></span>
              Ακολουθήστε μας στο Facebook
            </a>
          )}
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="container-page flex flex-col gap-4 py-6 text-xs md:flex-row md:items-center md:justify-between">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ink-300">
            <li className="flex items-center gap-1.5"><Truck className="h-4 w-4 text-oil-400" />Αποστολή σε όλη την Ελλάδα</li>
            <li className="flex items-center gap-1.5"><Store className="h-4 w-4 text-oil-400" />Παραλαβή από το κατάστημα</li>
            <li className="flex items-center gap-1.5"><Banknote className="h-4 w-4 text-oil-400" />Αντικαταβολή</li>
            <li className="flex items-center gap-1.5"><CreditCard className="h-4 w-4 text-oil-400" />Κάρτα</li>
            <li className="flex items-center gap-1.5"><Landmark className="h-4 w-4 text-oil-400" />Κατάθεση</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10 bg-ink-950/60">
        <div className="container-page flex flex-col gap-3 py-5 text-xs text-ink-400 md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {shop.name} · {shop.legalName}
            {shop.vatNumber && <> · ΑΦΜ {shop.vatNumber}</>}
            {shop.taxOffice && <> · ΔΟΥ {shop.taxOffice}</>}
            {shop.gemi && <> · Αρ. ΓΕΜΗ {shop.gemi}</>}
          </p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            <li><Link href="/terms" className="hover:text-white">Όροι χρήσης</Link></li>
            <li><Link href="/privacy" className="hover:text-white">Απόρρητο</Link></li>
            <li><Link href="/cookies" className="hover:text-white">Cookies</Link></li>
            <li><a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer" className="hover:text-white">Ηλεκτρονική επίλυση διαφορών</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
