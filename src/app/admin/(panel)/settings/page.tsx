import { Download } from 'lucide-react';
import { changeAdminPassword, saveSettings } from '@/app/admin/actions';
import { AdminForm } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { backupsSupported, listBackups } from '@/lib/backup';
import { cardProvider } from '@/lib/payments';
import { DAY_NAMES } from '@/lib/settings';
import { requireAdmin } from '@/lib/auth/session';
import { getSettings } from '@/lib/settings.server';
import { centsToInput, formatDate } from '@/lib/utils';

export const metadata = { title: 'Ρυθμίσεις' };

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [s, backups] = await Promise.all([getSettings(), listBackups()]);
  const { shop, storefront, reviews, shipping, payments, tax } = s;
  const provider = cardProvider();
  const accounts = [...payments.bankAccounts, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }].slice(0, 4);

  return (
    <>
      <PageHeader title="Ρυθμίσεις" description="Ό,τι αλλάζετε εδώ εφαρμόζεται αμέσως στο κατάστημα." />

      <AdminForm action={saveSettings} submitLabel="Αποθήκευση ρυθμίσεων" stickyBar className="space-y-6">
        <Card title="Λειτουργία καταστήματος">
          <div id="storefront" className="space-y-4">
            <Check name="ordersEnabled" label="Το κατάστημα δέχεται online παραγγελίες" defaultChecked={storefront.ordersEnabled} hint="Όσο είναι κλειστό, οι επισκέπτες βλέπουν προϊόντα και τιμές και γεμίζουν το καλάθι, αλλά αντί για ταμείο βλέπουν «οι online παραγγελίες ανοίγουν σύντομα — καλέστε μας». Κανείς δεν μπορεί να καταχωρήσει παραγγελία, εκτός από εσάς: όσο είστε συνδεδεμένος εδώ, το ταμείο δουλεύει για δοκιμές και οι παραγγελίες σας σημειώνονται ως δοκιμαστικές." />
            <Check name="launchSignup" label="«Ειδοποιήστε με όταν ανοίξουν οι παραγγελίες»" defaultChecked={storefront.launchSignup} hint="Όσο οι online παραγγελίες είναι κλειστές, ο επισκέπτης που φτάνει στο ταμείο μπορεί να αφήσει το e-mail του. Τα e-mail φαίνονται στα Στατιστικά και χρησιμοποιούνται μόνο για αυτή τη μία ειδοποίηση." />
            <Check name="demoMode" label="Δοκιμαστική λειτουργία" defaultChecked={storefront.demoMode} hint="Όσο είναι ενεργή, το site μένει κρυφό από το Google και οι παραγγελίες σημειώνονται ως δοκιμαστικές. Απενεργοποιήστε την όταν το site είναι έτοιμο να το δει ο κόσμος (ωράριο, στοιχεία επιχείρησης). Μπορεί να κλείσει και με τις online παραγγελίες ακόμη κλειστές: τότε το site λειτουργεί ως κατάλογος με τιμές, τηλέφωνο και χάρτη. Όσες τιμές δεν έχετε επιβεβαιώσει δεν εμφανίζονται ποτέ — ο επισκέπτης βλέπει «Καλέστε για τιμή»." />
            <Check name="b2bPage" label="Σελίδα «Για συνεργεία & επαγγελματίες»" defaultChecked={storefront.b2bPage} hint="Μια σελίδα με φόρμα αιτήματος προσφοράς για συνεργεία, στόλους και μεταπωλητές, με συνδέσμους στην κεφαλίδα και στο υποσέλιδο. Τα αιτήματα έρχονται στα Μηνύματα. Ανοίξτε την μόνο αν θέλετε τέτοια αιτήματα — η σελίδα δεν υπόσχεται εκπτώσεις ή πίστωση, μόνο ότι θα απαντήσετε με προσφορά." />
            <Field label="Μήνυμα ανακοίνωσης" hint="Προαιρετικό."><input name="announcement" defaultValue={storefront.announcement} className="field" /></Field>
            <Field label="Ένδειξη «τελευταία τεμάχια» κάτω από" className="max-w-xs"><input name="lowStockThreshold" inputMode="numeric" defaultValue={storefront.lowStockThreshold} className="field tabular" /></Field>
          </div>
        </Card>

        <Card title="Στοιχεία καταστήματος & επικοινωνίας" description="Εμφανίζονται στην κεφαλίδα, στο υποσέλιδο, στη σελίδα επικοινωνίας, στα e-mail και στο Google.">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Εμπορική ονομασία"><input name="name" defaultValue={shop.name} className="field" /></Field>
            <Field label="Επωνυμία"><input name="legalName" defaultValue={shop.legalName} className="field" /></Field>
            <Field label="Υπότιτλος"><input name="tagline" defaultValue={shop.tagline} className="field" /></Field>
            <Field label="Τηλέφωνο καταστήματος"><input name="phone" required defaultValue={shop.phone} className="field tabular" /></Field>
            <Field label="Κινητό"><input name="mobile" defaultValue={shop.mobile} className="field tabular" /></Field>
            <Field label="Fax"><input name="fax" defaultValue={shop.fax} className="field tabular" /></Field>
            <Field label="E-mail" className="md:col-span-3"><input name="email" type="email" defaultValue={shop.email} className="field" /></Field>
            <Field label="Οδός & αριθμός"><input name="street" required defaultValue={shop.street} className="field" /></Field>
            <Field label="Πόλη"><input name="city" required defaultValue={shop.city} className="field" /></Field>
            <Field label="Τ.Κ."><input name="postalCode" defaultValue={shop.postalCode} className="field tabular" /></Field>
            <Field label="Νομός"><input name="region" defaultValue={shop.region} className="field" /></Field>
            <Field label="Γεωγρ. πλάτος (lat)" hint="Για την πινέζα στον χάρτη."><input name="lat" inputMode="decimal" defaultValue={shop.lat} className="field tabular" /></Field>
            <Field label="Γεωγρ. μήκος (lng)"><input name="lng" inputMode="decimal" defaultValue={shop.lng} className="field tabular" /></Field>
          </div>
        </Card>

        <Card title="Instagram, Facebook & Skroutz" description="Επικολλήστε τον σύνδεσμο κάθε σελίδας. Όσα πεδία συμπληρωθούν εμφανίζονται στην κεφαλίδα, στο μενού του κινητού, στο υποσέλιδο και δίπλα στον χάρτη· τα κενά απλώς δεν εμφανίζονται.">
          <div id="social" className="grid gap-4 md:grid-cols-3">
            <Field label="Instagram" hint="Σύνδεσμος προφίλ ή απλώς @όνομα."><input name="instagramUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://www.instagram.com/…" defaultValue={shop.instagramUrl} className="field" /></Field>
            <Field label="Skroutz" hint="Η σελίδα του καταστήματος στο skroutz.gr."><input name="skroutzUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://www.skroutz.gr/shop/…" defaultValue={shop.skroutzUrl} className="field" /></Field>
            <Field label="Facebook"><input name="facebookUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://www.facebook.com/…" defaultValue={shop.facebookUrl} className="field" /></Field>
          </div>
        </Card>

        <Card title="Κριτικές & ιστορία" description="Ό,τι συμπληρώσετε εμφανίζεται στην αρχική σελίδα, στο υποσέλιδο, δίπλα στον χάρτη και στη σελίδα «Το κατάστημα»· τα κενά απλώς δεν εμφανίζονται. Γράψτε τους αριθμούς ακριβώς όπως τους δείχνει σήμερα το Google και το Skroutz, και ανανεώνετέ τους κάθε λίγους μήνες: ένας αριθμός που δεν συμφωνεί με αυτόν που θα δει ο πελάτης πατώντας τον σύνδεσμο κάνει ζημιά, όχι καλό.">
          <div id="reviews" className="grid gap-4 md:grid-cols-3">
            <Field label="Έτος ίδρυσης" hint="π.χ. 1992. Εμφανίζεται ως «Από το 1992»."><input name="foundedYear" inputMode="numeric" maxLength={4} defaultValue={shop.foundedYear || ''} className="field tabular" /></Field>
            <Field label="Σύνδεσμος κριτικών Google" hint="Από το Google Maps: Κοινοποίηση → Αντιγραφή συνδέσμου." className="md:col-span-2"><input name="googleUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://maps.app.goo.gl/…" defaultValue={reviews.googleUrl} className="field" /></Field>
            <Field label="Βαθμολογία Google" hint="π.χ. 4,8"><input name="googleRating" inputMode="decimal" defaultValue={reviews.googleRating ? String(reviews.googleRating).replace('.', ',') : ''} className="field tabular" /></Field>
            <Field label="Πλήθος κριτικών Google"><input name="googleCount" inputMode="numeric" defaultValue={reviews.googleCount || ''} className="field tabular" /></Field>
            <div className="hidden md:block" />
            <Field label="Βαθμολογία Skroutz" hint="π.χ. 4,9. Ο σύνδεσμος είναι αυτός του Skroutz παραπάνω."><input name="skroutzRating" inputMode="decimal" defaultValue={reviews.skroutzRating ? String(reviews.skroutzRating).replace('.', ',') : ''} className="field tabular" /></Field>
            <Field label="Πλήθος κριτικών Skroutz"><input name="skroutzCount" inputMode="numeric" defaultValue={reviews.skroutzCount || ''} className="field tabular" /></Field>
          </div>
        </Card>

        <Card title="Στοιχεία επιχείρησης" description="Εμφανίζονται στο υποσέλιδο και στους όρους χρήσης. ΑΦΜ και αριθμός ΓΕΜΗ απαιτούνται από τον νόμο για κάθε ηλεκτρονικό κατάστημα· η ΔΟΥ είναι προαιρετική (συνηθίζεται).">
          <div id="company" className="grid gap-4 md:grid-cols-3">
            <Field label="ΑΦΜ"><input name="vatNumber" inputMode="numeric" defaultValue={shop.vatNumber} className="field tabular" /></Field>
            <Field label="ΔΟΥ"><input name="taxOffice" defaultValue={shop.taxOffice} className="field" /></Field>
            <Field label="Αρ. ΓΕΜΗ"><input name="gemi" inputMode="numeric" defaultValue={shop.gemi} className="field tabular" /></Field>
            <Field label="ΦΠΑ %" hint="Οι τιμές που καταχωρείτε περιλαμβάνουν ήδη ΦΠΑ."><input name="vatRate" inputMode="numeric" defaultValue={tax.vatRate} className="field tabular" /></Field>
          </div>
        </Card>

        <Card title="Ωράριο λειτουργίας" description="Ελέγχει την ένδειξη «Ανοιχτά / Κλειστά» στο κατάστημα. Για σπαστό ωράριο συμπληρώστε και τη 2η βάρδια.">
          <div id="hours" className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead><tr className="text-left text-xs font-semibold tracking-wide text-ink-500 uppercase"><th className="pb-2">Ημέρα</th><th className="pb-2">Κλειστά</th><th className="pb-2">Άνοιγμα</th><th className="pb-2">Κλείσιμο</th><th className="pb-2">2η βάρδια από</th><th className="pb-2">έως</th></tr></thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const h = shop.hours.find((x) => x.day === day);
                  const time = (key: 'open' | 'close' | 'open2' | 'close2') => <input type="time" name={`h${day}-${key}`} defaultValue={h?.[key] ?? ''} aria-label={`${DAY_NAMES[day - 1]} ${key}`} className="field tabular h-10 w-32 px-2.5" />;
                  return (
                    <tr key={day} className="border-t border-line">
                      <td className="py-2 pr-3 font-medium text-ink-900">{DAY_NAMES[day - 1]}</td>
                      <td className="py-2 pr-3"><input type="checkbox" name={`h${day}-closed`} defaultChecked={h?.closed ?? false} aria-label={`${DAY_NAMES[day - 1]} κλειστά`} className="h-[1.125rem] w-[1.125rem] cursor-pointer accent-ink-900" /></td>
                      <td className="py-2 pr-2">{time('open')}</td><td className="py-2 pr-2">{time('close')}</td><td className="py-2 pr-2">{time('open2')}</td><td className="py-2">{time('close2')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4"><Check name="hoursVerified" label="Το ωράριο είναι σωστό και επιβεβαιωμένο" defaultChecked={shop.hoursVerified} hint="Μόλις το τσεκάρετε, το ωράριο κοινοποιείται και στο Google (δομημένα δεδομένα). Μέχρι τότε εμφανίζεται μόνο στο site." /></div>
        </Card>

        <Card title="Αποστολές" description="Τα μεταφορικά υπολογίζονται από το συνολικό βάρος της παραγγελίας.">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-3 md:col-span-3">
              <Check name="courierEnabled" label="Αποστολή με courier" defaultChecked={shipping.courierEnabled} />
              <Check name="pickupEnabled" label="Παραλαβή από το κατάστημα" defaultChecked={shipping.pickupEnabled} />
            </div>
            <Field label="Εταιρεία ταχυμεταφορών"><input name="carrierName" defaultValue={shipping.carrierName} placeholder="π.χ. ACS Courier" className="field" /></Field>
            <Field label="Χρόνος παράδοσης"><input name="deliveryEstimate" defaultValue={shipping.deliveryEstimate} className="field" /></Field>
            <Field label="Επιβάρυνση αντικαταβολής €"><input name="codFeeCents" inputMode="decimal" defaultValue={centsToInput(shipping.codFeeCents)} className="field tabular" /></Field>
            <Field label="Βασική χρέωση €"><input name="baseCents" inputMode="decimal" defaultValue={centsToInput(shipping.baseCents)} className="field tabular" /></Field>
            <Field label="…καλύπτει έως (kg)"><input name="baseWeightKg" inputMode="decimal" defaultValue={shipping.baseWeightKg} className="field tabular" /></Field>
            <Field label="Κάθε επιπλέον κιλό €"><input name="perExtraKgCents" inputMode="decimal" defaultValue={centsToInput(shipping.perExtraKgCents)} className="field tabular" /></Field>
            <Field label="Δωρεάν μεταφορικά άνω των €" hint="0 = ποτέ δωρεάν."><input name="freeOverCents" inputMode="decimal" defaultValue={centsToInput(shipping.freeOverCents)} className="field tabular" /></Field>
            <Field label="…μόνο για δέματα έως (kg)" hint="Προστατεύει από δωρεάν αποστολή βαρελιών 20L. 0 = χωρίς όριο."><input name="freeMaxWeightKg" inputMode="decimal" defaultValue={shipping.freeMaxWeightKg} className="field tabular" /></Field>
          </div>
        </Card>

        <Card title="Τρόποι πληρωμής">
          <div id="payments" className="space-y-3">
            <Check name="cod" label="Αντικαταβολή" defaultChecked={payments.cod} hint="Μόνο για αποστολές με courier." />
            <Check name="payInStore" label="Πληρωμή στο κατάστημα" defaultChecked={payments.payInStore} hint="Μόνο για παραλαβή από το κατάστημα." />
            <Check name="bankTransfer" label="Τραπεζική κατάθεση" defaultChecked={payments.bankTransfer} />
            <Check name="card" label="Κάρτα" defaultChecked={payments.card} hint={provider ? `Συνδεδεμένος πάροχος: ${provider}.` : 'Δεν έχει συνδεθεί πάροχος πληρωμών ακόμη: η επιλογή δεν θα εμφανίζεται στο ταμείο μέχρι να τον ρυθμίσει ο προγραμματιστής.'} />
          </div>
          <h3 className="mt-6 text-sm font-bold text-ink-950">Τραπεζικοί λογαριασμοί</h3>
          <p className="text-sm text-ink-600">Εμφανίζονται στον πελάτη που επιλέγει κατάθεση (στη σελίδα και στο e-mail της παραγγελίας).</p>
          <div className="mt-3 space-y-2">
            {accounts.map((a, i) => (
              <div key={i} className="grid gap-2 md:grid-cols-[1fr_1.6fr_1.2fr]">
                <input name={`bank${i}-name`} defaultValue={a.bank} placeholder="Τράπεζα" aria-label={`Τράπεζα ${i + 1}`} className="field" />
                <input name={`bank${i}-iban`} defaultValue={a.iban} placeholder="IBAN — GR…" aria-label={`IBAN ${i + 1}`} className="field tabular uppercase" />
                <input name={`bank${i}-holder`} defaultValue={a.holder} placeholder="Δικαιούχος" aria-label={`Δικαιούχος ${i + 1}`} className="field" />
              </div>
            ))}
          </div>
        </Card>
      </AdminForm>

      <Card title="Αλλαγή κωδικού διαχειριστή" className="mt-10 max-w-xl">
        <AdminForm action={changeAdminPassword} submitLabel="Αλλαγή κωδικού" variant="dark" resetOnSuccess>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Τρέχων κωδικός"><input type="password" name="currentPassword" autoComplete="current-password" required className="field" /></Field>
            <Field label="Νέος κωδικός" hint="Τουλάχιστον 10 χαρακτήρες."><input type="password" name="newPassword" autoComplete="new-password" required minLength={10} className="field" /></Field>
            <Field label="Νέος κωδικός, ξανά" hint="Για να μην κλειδωθείτε έξω από ένα λάθος πλήκτρο."><input type="password" name="newPasswordRepeat" autoComplete="new-password" required minLength={10} className="field" /></Field>
          </div>
        </AdminForm>
      </Card>

      <Card
        title="Αντίγραφα ασφαλείας"
        description="Κάθε βράδυ αποθηκεύεται αυτόματα ένα αντίγραφο όλης της βάσης (προϊόντα, τιμές, παραγγελίες, ρυθμίσεις) και κρατιούνται τα 14 τελευταία. Βρίσκονται στον ίδιο δίσκο με το site, γι' αυτό κατεβάζετε πού και πού ένα και στον υπολογιστή σας."
        className="mt-6 max-w-xl"
      >
        <div id="backups">
          {!backupsSupported() ? (
            <p className="text-sm text-ink-600">Η βάση φιλοξενείται εξωτερικά· τα αντίγραφα τα κρατά ο πάροχος της βάσης.</p>
          ) : (
            <>
              <p className="text-sm text-ink-700">
                {backups.length === 0
                  ? 'Δεν υπάρχει ακόμη αυτόματο αντίγραφο (δημιουργείται μόνο στο δημοσιευμένο site, λίγο μετά την εκκίνηση).'
                  : `Τελευταίο αυτόματο αντίγραφο: ${formatDate(new Date(`${backups[0].day}T12:00:00`))} · ${backups.length} ${backups.length === 1 ? 'αποθηκευμένο' : 'αποθηκευμένα'}.`}
              </p>
              <a href="/admin/backup" className={buttonClass({ variant: 'dark', className: 'mt-4' })}>
                <Download className="h-4 w-4" />
                Λήψη αντιγράφου τώρα
              </a>
              <p className="mt-3 text-xs text-ink-500">Το αρχείο περιέχει στοιχεία πελατών. Φυλάξτε το σε ασφαλές μέρος και μην το στέλνετε με e-mail.</p>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
