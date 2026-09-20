import type { Metadata } from 'next';
import { LegalShell } from '@/components/store/legal-shell';
import { courierRateCents } from '@/lib/pricing';
import { fullAddress } from '@/lib/settings';
import { getSettings } from '@/lib/settings.server';
import { formatPrice } from '@/lib/utils';

export const metadata: Metadata = { title: 'Αποστολές & πληρωμές', description: 'Κόστος και χρόνοι αποστολής, παραλαβή από το κατάστημα και τρόποι πληρωμής στο Oil Center.', alternates: { canonical: '/shipping-payments' } };

export default async function ShippingPaymentsPage() {
  const { shop, shipping, payments } = await getSettings();
  const examples = [1, 5, 10, 20].map((kg) => ({ kg, price: courierRateCents(kg * 1000, shipping) }));

  return (
    <LegalShell href="/shipping-payments" title="Αποστολές & πληρωμές" updated="Σεπτέμβριος 2026">
      <h2>Αποστολή με courier</h2>
      {shipping.courierEnabled ? (
        <>
          <p>Στέλνουμε σε όλη την Ελλάδα με {shipping.carrierName}. Οι παραγγελίες που καταχωρούνται εργάσιμες ημέρες παραδίδονται συνήθως σε <strong>{shipping.deliveryEstimate}</strong>. Για δυσπρόσιτες περιοχές και νησιά ο χρόνος μπορεί να είναι μεγαλύτερος.</p>
          <p>Τα λιπαντικά είναι βαριά, γι’ αυτό το κόστος αποστολής υπολογίζεται με βάση το βάρος: <strong>{formatPrice(shipping.baseCents)}</strong> έως {shipping.baseWeightKg} kg και <strong>{formatPrice(shipping.perExtraKgCents)}</strong> για κάθε επιπλέον κιλό. Το ακριβές ποσό εμφανίζεται στο καλάθι πριν ολοκληρώσετε την παραγγελία.</p>
          <table>
            <thead><tr><th>Ενδεικτικό βάρος δέματος</th><th>Μεταφορικά</th></tr></thead>
            <tbody>{examples.map((e) => <tr key={e.kg}><td>{e.kg} kg</td><td className="tabular">{formatPrice(e.price)}</td></tr>)}</tbody>
          </table>
          {shipping.freeOverCents > 0 && (
            <p><strong>Δωρεάν μεταφορικά</strong> για παραγγελίες άνω των {formatPrice(shipping.freeOverCents)}{shipping.freeMaxWeightKg > 0 ? <> και βάρους έως {shipping.freeMaxWeightKg} kg</> : null}.</p>
          )}
        </>
      ) : (
        <p>Προς το παρόν δεν πραγματοποιούμε αποστολές. Μπορείτε να παραλάβετε την παραγγελία σας από το κατάστημα.</p>
      )}

      {shipping.pickupEnabled && (
        <>
          <h2>Παραλαβή από το κατάστημα</h2>
          <p>Παραγγείλετε online και παραλάβετε <strong>χωρίς καμία χρέωση</strong> από το κατάστημά μας: {fullAddress(shop)}. Θα σας ειδοποιήσουμε με e-mail μόλις η παραγγελία είναι έτοιμη.</p>
        </>
      )}

      <h2>Τρόποι πληρωμής</h2>
      <ul>
        {payments.cod && <li><strong>Αντικαταβολή:</strong> πληρώνετε στον courier κατά την παράδοση{shipping.codFeeCents > 0 ? <>, με επιβάρυνση {formatPrice(shipping.codFeeCents)}</> : null}.</li>}
        {payments.card && <li><strong>Πιστωτική / χρεωστική κάρτα:</strong> η πληρωμή γίνεται σε ασφαλές περιβάλλον πιστοποιημένου παρόχου πληρωμών. Δεν βλέπουμε και δεν αποθηκεύουμε τα στοιχεία της κάρτας σας.</li>}
        {payments.bankTransfer && <li><strong>Τραπεζική κατάθεση:</strong> τα στοιχεία του λογαριασμού αποστέλλονται με το e-mail επιβεβαίωσης. Η παραγγελία αποστέλλεται μόλις επιβεβαιωθεί η κατάθεση. Τυχόν έξοδα εμβάσματος βαρύνουν τον πελάτη.</li>}
        {payments.payInStore && <li><strong>Πληρωμή στο κατάστημα:</strong> για παραγγελίες που παραλαμβάνετε οι ίδιοι.</li>}
      </ul>
      <p>Όλες οι τιμές περιλαμβάνουν ΦΠΑ. Για κάθε παραγγελία εκδίδεται απόδειξη λιανικής ή, εφόσον το ζητήσετε στο ταμείο, τιμολόγιο.</p>

      <h2>Παραλαβή του δέματος</h2>
      <p>Ελέγξτε το δέμα κατά την παραλαβή. Αν η συσκευασία είναι εμφανώς κατεστραμμένη ή υπάρχει διαρροή, σημειώστε το στο αποδεικτικό του courier και επικοινωνήστε μαζί μας την ίδια ημέρα στο <span className="tabular">{shop.phone}</span>.</p>
    </LegalShell>
  );
}
