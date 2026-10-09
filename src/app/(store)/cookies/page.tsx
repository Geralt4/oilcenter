import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '@/components/store/legal-shell';
import { getSettings } from '@/lib/settings.server';

export const metadata: Metadata = { title: 'Πολιτική cookies', alternates: { canonical: '/cookies' } };

export default async function CookiesPage() {
  // the cart, the customer account and card payments exist only while the shop takes online orders
  const selling = (await getSettings()).storefront.ordersEnabled;
  return (
    <LegalShell href="/cookies" title="Cookies" updated="Σεπτέμβριος 2026">
      <p>Ο ιστότοπός μας χρησιμοποιεί <strong>μόνο τα απολύτως απαραίτητα</strong> cookies και τοπική αποθήκευση για να λειτουργεί {selling ? 'το ηλεκτρονικό κατάστημα' : 'ο ιστότοπος'}. Δεν χρησιμοποιούμε cookies διαφήμισης ή παρακολούθησης, ούτε εργαλεία στατιστικών τρίτων. Τα στατιστικά επισκεψιμότητας που κρατάμε είναι συγκεντρωτικά και <strong>δεν αποθηκεύουν τίποτα στη συσκευή σας</strong> — λεπτομέρειες στην <Link href="/privacy">Πολιτική απορρήτου</Link>.</p>

      <h2>Τι αποθηκεύεται στη συσκευή σας</h2>
      <table>
        <thead><tr><th>Όνομα</th><th>Είδος</th><th>Σκοπός</th><th>Διάρκεια</th></tr></thead>
        <tbody>
          {selling && <tr><td className="tabular">oilcenter-cart</td><td>Τοπική αποθήκευση</td><td>Τα προϊόντα του καλαθιού σας</td><td>Μέχρι να το αδειάσετε</td></tr>}
          <tr><td className="tabular">oilcenter-wishlist</td><td>Τοπική αποθήκευση</td><td>Τα αγαπημένα σας προϊόντα</td><td>Μέχρι να τα αφαιρέσετε</td></tr>
          <tr><td className="tabular">oilcenter-cookie-notice</td><td>Τοπική αποθήκευση</td><td>Θυμάται ότι είδατε αυτή την ενημέρωση</td><td>Μόνιμα</td></tr>
          {selling && <tr><td className="tabular">oc_customer</td><td>Cookie (HttpOnly)</td><td>Σας κρατά συνδεδεμένους στον λογαριασμό σας</td><td>30 ημέρες</td></tr>}
        </tbody>
      </table>
      <p>Επειδή τα παραπάνω είναι αναγκαία για την υπηρεσία που ζητάτε, δεν απαιτείται συγκατάθεση (άρθρο 4 παρ. 5 Ν. 3471/2006).</p>

      <h2>Περιεχόμενο τρίτων</h2>
      <p>Στις σελίδες «Επικοινωνία», «Το κατάστημα» και στην αρχική σελίδα ενσωματώνεται χάρτης της <strong>Google Maps</strong>. Όταν φορτώνεται ο χάρτης, η Google ενδέχεται να τοποθετήσει δικά της cookies και να λάβει τη διεύθυνση IP σας, σύμφωνα με τη δική της πολιτική απορρήτου. Οι σύνδεσμοι «Οδηγίες» ανοίγουν την εφαρμογή ή τον ιστότοπο Google Maps.</p>
      {selling && <p>Κατά την πληρωμή με κάρτα μεταφέρεστε στον ιστότοπο του παρόχου πληρωμών, ο οποίος χρησιμοποιεί τα δικά του cookies.</p>}

      <h2>Πώς τα διαχειρίζεστε</h2>
      <p>Μπορείτε να διαγράψετε τα cookies και την τοπική αποθήκευση από τις ρυθμίσεις του προγράμματος περιήγησής σας. Αν το κάνετε, {selling ? 'το καλάθι και τα αγαπημένα σας θα αδειάσουν' : 'τα αγαπημένα σας θα αδειάσουν'}.</p>
    </LegalShell>
  );
}
