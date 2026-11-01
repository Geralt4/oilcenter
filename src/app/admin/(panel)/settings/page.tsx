import { Download } from 'lucide-react';
import { asc, eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import { addAdmin, beginTotpEnrollment, changeAdminPassword, confirmAdminIdentity, confirmTotpEnrollment, disableTotp, removeAdmin, resetAdminMfa, saveSettings } from '@/app/admin/actions';
import { AdminForm, ConfirmButton } from '@/components/admin/admin-form';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { totpUri } from '@/lib/auth/totp';
import { backupsSupported, listBackups } from '@/lib/backup';
import { lastOffsiteSuccess, offsiteConfigured, offsiteStatus } from '@/lib/backup-offsite';
import { db } from '@/lib/db';
import { adminUsers } from '@/lib/db/schema';
import { cardProvider } from '@/lib/payments';
import { formatIban, isValidIban } from '@/lib/iban';
import { DAY_NAMES } from '@/lib/settings';
import { requireAdmin } from '@/lib/auth/session';
import { hasSudoSession } from '@/lib/auth/session';
import { getSettings } from '@/lib/settings.server';
import { centsToInput, cn, formatDate, formatDateTime } from '@/lib/utils';

export const metadata = { title: 'Ρυθμίσεις' };

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ sudo?: string; mfa?: string }> }) {
  const admin = await requireAdmin();
  const [{ sudo: sudoParam, mfa: mfaParam }, sudo] = await Promise.all([searchParams, hasSudoSession()]);
  const [s, backups, mfa, admins] = await Promise.all([
    getSettings(),
    listBackups(),
    db.select({ secret: adminUsers.totpSecret, confirmedAt: adminUsers.totpConfirmedAt }).from(adminUsers).where(eq(adminUsers.id, admin.id)).then((r) => r[0]),
    db.select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, confirmedAt: adminUsers.totpConfirmedAt, lastLoginAt: adminUsers.lastLoginAt }).from(adminUsers).orderBy(asc(adminUsers.createdAt)),
  ]);
  const [offsite, offsiteLast] = await Promise.all([Promise.resolve(offsiteConfigured()), offsiteStatus()]);
  // Pending enrollment = secret saved but never proven with a code yet. Only then is a QR shown.
  const mfaPending = Boolean(mfa?.secret && !mfa.confirmedAt);
  const mfaQr = mfaPending ? await QRCode.toDataURL(totpUri(mfa!.secret!, admin.email), { margin: 1, width: 220 }) : null;
  const { shop, storefront, reviews, shipping, payments, tax } = s;
  const provider = cardProvider();
  // an IBAN saved before IBANs were checked: say so now, not when the owner next saves
  const badIbans = payments.bankAccounts.flatMap((a, i) => (isValidIban(a.iban) ? [] : [i + 1]));
  const accounts = [...payments.bankAccounts, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }, { bank: '', iban: '', holder: '' }].slice(0, 4);

  return (
    <>
      <PageHeader title="Ρυθμίσεις" description="Ό,τι αλλάζετε εδώ εφαρμόζεται αμέσως στο κατάστημα." />

      {badIbans.length > 0 && (
        <p role="alert" className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-950">
          {badIbans.length === 1 ? `Ο τραπεζικός λογαριασμός ${badIbans[0]} έχει μη έγκυρο IBAN` : `Οι τραπεζικοί λογαριασμοί ${badIbans.join(', ')} έχουν μη έγκυρο IBAN`} — οι πελάτες το βλέπουν όπως είναι γραμμένο. Διορθώστε το στους «Τρόπους πληρωμής» και αποθηκεύστε· μέχρι τότε δεν θα αποθηκευτεί καμία ρύθμιση.
        </p>
      )}

      {(sudoParam || mfaParam) && (
        <p role="alert" className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-950">
          {sudoParam === '1'
            ? 'Για αλλαγές διαχειριστών χρειάζεται πρώτα επιβεβαίωση ταυτότητας (κωδικός και, αν έχετε 2FA, κωδικός εφαρμογής).'
            : mfaParam === 'wrong'
              ? 'Ο κωδικός επαλήθευσης δεν ήταν σωστός ή είχε ήδη χρησιμοποιηθεί. Περιμένετε τον επόμενο κωδικό.'
              : mfaParam === 'password'
                ? 'Ο κωδικός που γράψατε δεν ήταν σωστός. Για να ενεργοποιήσετε την επαλήθευση δύο βημάτων χρειάζεται ο τρέχων κωδικός σας.'
                : 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγα λεπτά.'}
        </p>
      )}

      <Card title="Επιβεβαίωση ταυτότητας" description="Η προσθήκη ή αφαίρεση διαχειριστών, η επαναφορά 2FA, η λήψη αντιγράφου της βάσης, η αλλαγή των τραπεζικών λογαριασμών και το άνοιγμα ή κλείσιμο των online παραγγελιών απαιτούν φρέσκια επιβεβαίωση, ώστε μια κλεμμένη συνεδρία να μην αρκεί. Η επιβεβαίωση ισχύει για 5 λεπτά." className="mb-6 max-w-xl">
        <div id="identity">
        {sudo ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-800">Η ταυτότητα είναι επιβεβαιωμένη για αυτή τη συνεδρία (έως 5 λεπτά από την επιβεβαίωση).</p>
        ) : (
          <AdminForm action={confirmAdminIdentity} submitLabel="Επιβεβαίωση" variant="dark" resetOnSuccess>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Τρέχων κωδικός"><input type="password" name="currentPassword" autoComplete="current-password" required className="field" /></Field>
              {mfa?.confirmedAt && <Field label="Κωδικός εφαρμογής" hint="Ο τρέχων 6ψήφιος κωδικός."><input name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required className="field tabular" /></Field>}
            </div>
          </AdminForm>
        )}
        </div>
      </Card>

      <AdminForm action={saveSettings} submitLabel="Αποθήκευση ρυθμίσεων" stickyBar className="space-y-6">
        <Card title="Λειτουργία καταστήματος">
          <div id="storefront" className="space-y-4">
            <Check name="ordersEnabled" label="Το κατάστημα δέχεται online παραγγελίες" defaultChecked={storefront.ordersEnabled} hint="Όσο είναι κλειστό, το site λειτουργεί ως ιστοσελίδα-κατάλογος: οι επισκέπτες βλέπουν προϊόντα, τιμές και στοιχεία επικοινωνίας, χωρίς καλάθι, ταμείο, λογαριασμούς και σελίδες αποστολών. Εσείς, όσο είστε συνδεδεμένος εδώ, βλέπετε ολόκληρο το κατάστημα για δοκιμαστικές παραγγελίες. Η αλλαγή αυτής της επιλογής χρειάζεται πρώτα επιβεβαίωση ταυτότητας (πρώτη κάρτα της σελίδας)." />
            <Check name="launchSignup" label="«Ειδοποιήστε με όταν ανοίξουν οι παραγγελίες»" defaultChecked={storefront.launchSignup} hint="Όσο οι online παραγγελίες είναι κλειστές, στην αρχική σελίδα εμφανίζεται μια μικρή φόρμα όπου ο επισκέπτης αφήνει το e-mail του. Τα e-mail τα βρίσκετε στα Στατιστικά." />
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

        <Card title="Instagram & Skroutz" description="Επικολλήστε τον σύνδεσμο κάθε σελίδας. Όσα πεδία συμπληρωθούν εμφανίζονται στην κεφαλίδα, στο μενού του κινητού, στο υποσέλιδο και δίπλα στον χάρτη· τα κενά απλώς δεν εμφανίζονται.">
          <div id="social" className="grid gap-4 md:grid-cols-2">
            <Field label="Instagram" hint="Σύνδεσμος προφίλ ή απλώς @όνομα."><input name="instagramUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://www.instagram.com/…" defaultValue={shop.instagramUrl} className="field" /></Field>
            <Field label="Skroutz" hint="Η σελίδα του καταστήματος στο skroutz.gr."><input name="skroutzUrl" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://www.skroutz.gr/shop/…" defaultValue={shop.skroutzUrl} className="field" /></Field>
          </div>
        </Card>

        <Card title="Κριτικές & ιστορία" description="Ό,τι συμπληρώσετε εμφανίζεται στην αρχική σελίδα, στο υποσέλιδο, δίπλα στον χάρτη και στη σελίδα «Το κατάστημα»· τα κενά απλώς δεν εμφανίζονται. Γράψτε τους αριθμούς ακριβώς όπως τους δείχνει σήμερα το Google και το Skroutz, και ανανεώνετέ τους κάθε λίγους μήνες: ένας αριθμός που δεν συμφωνεί με αυτόν που θα δει ο πελάτης πατώντας τον σύνδεσμο κάνει ζημιά, όχι καλό.">
          <div id="reviews" className="grid gap-4 md:grid-cols-3">
            <Field label="Έτος ίδρυσης" hint="π.χ. 1992. Εμφανίζεται ως «Από το 1992»."><input name="foundedYear" inputMode="numeric" maxLength={4} defaultValue={shop.foundedYear || ''} className="field tabular" /></Field>
            <Check name="accelerateDealer" label="Είμαστε εξουσιοδοτημένος αντιπρόσωπος της accelerate" defaultChecked={shop.accelerateDealer} hint="Τσεκάρετέ το μόνο αν ισχύει σήμερα: τότε το γράφει η αρχική σελίδα και η σελίδα «Το κατάστημα»." />
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
          <p className="mt-1 text-xs text-ink-500">Η αλλαγή τους χρειάζεται πρώτα επιβεβαίωση ταυτότητας (πρώτη κάρτα της σελίδας).</p>
          <p className="text-sm text-ink-600">Εμφανίζονται στον πελάτη που επιλέγει κατάθεση (στη σελίδα και στο e-mail της παραγγελίας).</p>
          <div className="mt-3 space-y-2">
            {accounts.map((a, i) => (
              <div key={i} className="grid gap-2 md:grid-cols-[1fr_1.6fr_1.2fr]">
                <input name={`bank${i}-name`} defaultValue={a.bank} placeholder="Τράπεζα" aria-label={`Τράπεζα ${i + 1}`} className="field" />
                <input name={`bank${i}-iban`} defaultValue={formatIban(a.iban)} placeholder="IBAN — GR…" aria-label={`IBAN ${i + 1}`} className="field tabular uppercase" />
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
        title="Επαλήθευση δύο βημάτων (2FA)"
        description="Με την επαλήθευση ενεργή, η σύνδεση στη διαχείριση ζητά και έναν 6ψήφιο κωδικό από μια εφαρμογή στο κινητό (Google Authenticator, Aegis, Microsoft Authenticator, 1Password…). Έτσι ένα κλεμμένο ή μαντεμένο συνθηματικό δεν αρκεί για να μπει κάποιος."
        className="mt-6 max-w-xl"
      >
        <div id="mfa">
          {mfa?.confirmedAt ? (
            <>
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-800">
                Ενεργή{admin.name ? ` για ${admin.name}` : ''} από {formatDate(mfa.confirmedAt)}. Ο κωδικός ζητείται σε κάθε νέα σύνδεση.
              </p>
              <p className="mt-3 text-sm text-ink-600">
                Αν χάσετε το κινητό, η επαλήθευση απενεργοποιείται μόνο από τον διακομιστή: <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">npm run admin:reset-mfa -- {admin.email}</code> (χρειάζεται πρόσβαση στο Railway). Αποθηκεύστε το σε ασφαλές μέρος.
              </p>
              <AdminForm action={disableTotp} submitLabel="Απενεργοποίηση" variant="dark" resetOnSuccess className="mt-4">
                <Field label="Τρέχων κωδικός εφαρμογής" hint="Για επιβεβαίωση ότι έχετε πρόσβαση στην εφαρμογή.">
                  <input name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required className="field tabular" />
                </Field>
              </AdminForm>
            </>
          ) : mfaPending && mfaQr ? (
            <>
              <p className="text-sm text-ink-700">Σαρώστε τον κωδικό με την εφαρμογή επαλήθευσης (ή προσθέστε χειροκίνητα το μυστικό):</p>
              {/* eslint-disable-next-line @next/next/no-img-element -- a one-off data URL, nothing for the image optimiser to do */}
              <img src={mfaQr} alt="QR για την εφαρμογή επαλήθευσης" width={220} height={220} className="mt-3 rounded-xl border border-line bg-white p-2" />
              <p className="mt-2 text-xs text-ink-500">Χειροκίνητη καταχώρηση: <code className="tabular select-all rounded bg-ink-100 px-1.5 py-0.5">{mfa!.secret!.replace(/(.{4})/g, '$1 ').trim()}</code></p>
              <AdminForm action={confirmTotpEnrollment} submitLabel="Επιβεβαίωση" variant="dark" resetOnSuccess className="mt-4">
                <Field label="Κωδικός από την εφαρμογή" hint="Ο 6ψήφιος κωδικός που δείχνει τώρα — όχι ο επόμενος.">
                  <input name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required className="field tabular" />
                </Field>
              </AdminForm>
              <AdminForm action={disableTotp} submitLabel="Ακύρωση ρύθμισης" className="mt-2">
                <input type="hidden" name="cancel" value="1" />
              </AdminForm>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-600">Δεν είναι ενεργή. Συνιστάται ανεπιφύλακτα πριν ανοίξει το site στο κοινό.</p>
              <form action={beginTotpEnrollment} className="mt-4">
                <Field label="Τρέχων κωδικός" hint="Για επιβεβαίωση ότι είστε εσείς πριν ξεκινήσει η ρύθμιση.">
                  <input type="password" name="currentPassword" autoComplete="current-password" required className="field" />
                </Field>
                <button type="submit" className={cn(buttonClass({ variant: 'dark' }), 'mt-3')}>Ενεργοποίηση</button>
              </form>
            </>
          )}
        </div>
      </Card>

      <Card
        title="Διαχειριστές"
        description="Κάθε διαχειριστής έχει δικό του κωδικό και δική του εφαρμογή επαλήθευσης (2FA) στο κινητό του — γι' αυτό χρειάζονται δύο λογαριασμοί, όχι δύο τηλέφωνα στον ίδιο. Έτσι, αν χαθεί το ένα τηλέφωνο, ο άλλος διαχειριστής μπορεί να επαναφέρει την πρόσβαση."
        className="mt-6 max-w-2xl"
      >
        <div id="admins">
          <ul className="divide-y divide-line">
            {admins.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-950">
                    {a.name || 'Διαχειριστής'}
                    {a.id === admin.id && <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-ink-600">εσείς</span>}
                  </span>
                  <span className="block text-xs text-ink-500">{a.email}</span>
                  <span className={cn('block text-xs', a.confirmedAt ? 'text-emerald-700' : 'text-amber-700')}>
                    {a.confirmedAt ? '2FA ενεργή' : '2FA ανενεργή'}
                    <span className="text-ink-500"> · {a.lastLoginAt ? `τελευταία σύνδεση ${formatDateTime(new Date(a.lastLoginAt))}` : 'δεν έχει συνδεθεί ακόμη'}</span>
                  </span>
                </span>
                {a.id !== admin.id && (
                  <span className="flex flex-wrap gap-2">
                    <form action={resetAdminMfa}>
                      <input type="hidden" name="id" value={a.id} />
                      <ConfirmButton message={`Επαναφορά 2FA για ${a.email}; Θα αποσυνδεθεί και θα χρειαστεί να τη ρυθμίσει ξανά.`} className="flex h-9 cursor-pointer items-center rounded-lg px-3 text-xs font-semibold text-ink-700 hover:bg-ink-100">
                        Επαναφορά 2FA
                      </ConfirmButton>
                    </form>
                    <form action={removeAdmin}>
                      <input type="hidden" name="id" value={a.id} />
                      <ConfirmButton message={`Οριστική διαγραφή του διαχειριστή ${a.email};`} className="flex h-9 cursor-pointer items-center rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50">
                        Διαγραφή
                      </ConfirmButton>
                    </form>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h3 className="mt-5 border-t border-line pt-5 text-sm font-bold text-ink-950">Προσθήκη διαχειριστή</h3>
          <p className="mt-1 text-sm text-ink-600">Για το άτομο που συντηρεί το site. Θα συνδεθεί με τον προσωρινό κωδικό, θα τον αλλάξει από εδώ και θα ενεργοποιήσει τη δική του εφαρμογή επαλήθευσης στο κινητό του.</p>
          <AdminForm action={addAdmin} submitLabel="Προσθήκη διαχειριστή" variant="dark" resetOnSuccess className="mt-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="E-mail"><input type="email" name="email" required autoComplete="off" className="field" /></Field>
              <Field label="Όνομα"><input name="adminName" maxLength={80} className="field" /></Field>
              <Field label="Προσωρινός κωδικός" hint="Τουλάχιστον 10 χαρακτήρες."><input type="password" name="adminPassword" required minLength={10} autoComplete="new-password" className="field" /></Field>
            </div>
          </AdminForm>
        </div>
      </Card>

      <Card
        title="Αντίγραφα ασφαλείας"
        description="Κάθε βράδυ αποθηκεύεται αυτόματα ένα αντίγραφο όλης της βάσης (προϊόντα, τιμές, παραγγελίες, ρυθμίσεις) και κρατιούνται τα 14 τελευταία. Όταν είναι ρυθμισμένο το Backblaze B2, κάθε αντίγραφο ανεβαίνει και κρυπτογραφημένο εκτός του δίσκου του site, μαζί με τις φωτογραφίες και τα δελτία ασφαλείας."
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
              {sudo ? (
                <a href="/admin/backup" className={buttonClass({ variant: 'dark', className: 'mt-4' })}>
                  <Download className="h-4 w-4" />
                  Λήψη αντιγράφου τώρα
                </a>
              ) : (
                <p className="mt-4 text-sm text-ink-600">
                  Η λήψη περιέχει όλη τη βάση (στοιχεία πελατών, hashes κωδικών, κλειδιά 2FA) και απαιτεί φρέσκια επιβεβαίωση ταυτότητας:{' '}
                  <a href="#identity" className="font-semibold text-petrol-500 underline underline-offset-2">επιβεβαιώστε πρώτα εδώ</a> (ισχύει 5 λεπτά).
                </p>
              )}
              <p className="mt-3 text-xs text-ink-500">Το αρχείο περιέχει στοιχεία πελατών. Φυλάξτε το σε ασφαλές μέρος και μην το στέλνετε με e-mail.</p>
              <p className="mt-4 border-t border-line pt-3 text-sm text-ink-700">
                {!offsite
                  ? 'Εξωτερικό αντίγραφο (Backblaze B2): δεν έχει ρυθμιστεί ακόμη.'
                  : offsiteLast?.ok
                    ? `Εξωτερικό αντίγραφο (Backblaze B2): ενημερώθηκε ${formatDate(new Date(offsiteLast.at))} — κρυπτογραφημένο, διατηρούνται 14 ημερήσια.`
                    : offsiteLast
                      ? `Εξωτερικό αντίγραφο (Backblaze B2): Η ΤΕΛΕΥΤΑΙΑ ΑΠΟΣΤΟΛΗ ΑΠΕΤΥΧΕ (${formatDate(new Date(offsiteLast.at))}).${lastOffsiteSuccess(offsiteLast) ? ` Τελευταίο επιτυχές: ${formatDate(new Date(lastOffsiteSuccess(offsiteLast)!))}.` : ''} Ελέγξτε τα στοιχεία σύνδεσης στο Railway.`
                      : 'Εξωτερικό αντίγραφο (Backblaze B2): ρυθμισμένο, αναμένεται η πρώτη αποστολή.'}
              </p>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
