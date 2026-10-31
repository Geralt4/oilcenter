import Link from 'next/link';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import { BadgeEuro, CircleAlert, CircleCheck } from 'lucide-react';
import { resolvePaymentReview, resolveUnmatchedPayment } from '@/app/admin/actions';
import { Card, PageHeader, PaymentBadge, StatusBadge, td, th } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { mailConfigured } from '@/lib/email';
import { adminUsers, categories, orderEvents, orders, products, unmatchedPayments, variants } from '@/lib/db/schema';
import { hazardPriorityCategoryIds, needsHazardCheck } from '@/lib/ghs';
import { commerceEnabled } from '@/lib/commerce-flag';
import { releaseAbandonedCardOrders } from '@/lib/orders';
import { isValidIban } from '@/lib/iban';
import { resendConfigured, resendWithoutSender } from '@/lib/startup-check';
import { cardProvider } from '@/lib/payments';
import { countGivenUpMails, GIVEN_UP_WINDOW_DAYS } from '@/lib/payments/mail-delivery';
import { getSettings } from '@/lib/settings.server';
import { cn, formatDateTime, formatPrice } from '@/lib/utils';
import { backupStatus } from '@/lib/backup';
import { lastOffsiteSuccess, offsiteConfigured, offsiteIsFresh, offsiteStatus } from '@/lib/backup-offsite';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

export default async function AdminDashboard() {
  const me = await requireAdmin();
  // like the hourly job: nothing to release (and nothing to touch) while the shop is a website only
  if (commerceEnabled()) await releaseAbandonedCardOrders();
  const settings = await getSettings();
  const real = and(eq(orders.isTest, false), ne(orders.status, 'cancelled'));
  const since = daysAgo;
  const sum = sql<number>`coalesce(sum(${orders.totalCents}), 0)`;

  const [[today], [week], [month], [pending], [unverified], [flagged], [productCount], recent, categoryRows, hazardRows, flaggedOrders, unmatched] = await Promise.all([
    db.select({ n: count(), total: sum }).from(orders).where(and(real, gte(orders.createdAt, since(1)))),
    db.select({ n: count(), total: sum }).from(orders).where(and(real, gte(orders.createdAt, since(7)))),
    db.select({ n: count(), total: sum }).from(orders).where(and(real, gte(orders.createdAt, since(30)))),
    db.select({ n: count() }).from(orders).where(eq(orders.status, 'pending')),
    db.select({ n: count() }).from(variants).where(and(eq(variants.priceVerified, false), eq(variants.isActive, true))),
    db.select({ n: count() }).from(products).where(isNotNull(products.internalNotes)),
    db.select({ n: count() }).from(products).where(eq(products.isActive, true)),
    db.select().from(orders).orderBy(desc(orders.createdAt)).limit(8),
    db.select({ id: categories.id, slug: categories.slug, parentId: categories.parentId }).from(categories),
    db.select({ isActive: products.isActive, categoryId: products.categoryId, hazard: products.hazard }).from(products),
    // payment problems waiting for the owner (see recordPayment in lib/orders.ts): flagged orders, and paid payments that matched no order
    db.select().from(orders).where(eq(orders.paymentFlag, 'review')).orderBy(asc(orders.updatedAt)).limit(20),
    db.select().from(unmatchedPayments).where(isNull(unmatchedPayments.resolvedAt)).orderBy(asc(unmatchedPayments.createdAt)).limit(20),
  ]);
  // the card lists at most 20 of each: say how many are not shown
  const [[flaggedTotal], [unmatchedTotal]] = await Promise.all([
    db.select({ n: count() }).from(orders).where(eq(orders.paymentFlag, 'review')),
    db.select({ n: count() }).from(unmatchedPayments).where(isNull(unmatchedPayments.resolvedAt)),
  ]);
  const hiddenProblems = flaggedTotal.n - flaggedOrders.length + (unmatchedTotal.n - unmatched.length);
  const problemEvents = flaggedOrders.length
    ? await db.select().from(orderEvents).where(and(inArray(orderEvents.orderId, flaggedOrders.map((o) => o.id)), eq(orderEvents.type, 'payment'), like(orderEvents.message, 'ΠΡΟΣΟΧΗ%'))).orderBy(desc(orderEvents.id))
    : [];
  const latestProblem = new Map<number, string>();
  for (const e of problemEvents) if (!latestProblem.has(e.orderId)) latestProblem.set(e.orderId, e.message);
  // chemicals, fluids and 2-stroke oils whose hazard labelling has not been checked against the pack yet (lib/ghs.ts)
  const hazardIds = hazardPriorityCategoryIds(categoryRows);
  const hazardTodo = hazardRows.filter((p) => needsHazardCheck(p, hazardIds)).length;

  const { shop, payments, storefront } = settings;
  // a snapshot is written once a day (lib/backup.ts); if the newest one is older than yesterday, something is failing quietly
  const { newest: newestBackup, fresh: backupFresh } = await backupStatus();
  const [mfaRow, offsiteOn, offsiteLast] = await Promise.all([
    db.select({ confirmedAt: adminUsers.totpConfirmedAt }).from(adminUsers).where(eq(adminUsers.id, me.id)).then((r) => r[0]),
    Promise.resolve(offsiteConfigured()),
    offsiteStatus(),
  ]);
  // > 26 h without a successful upload = the night's copy is late (two hourly runs in a row failed, or none ran); surface it before the owner relies on it
  const offsiteFresh = offsiteIsFresh(offsiteLast);
  // payment mails (customer confirmation, shop notice or alert) the site tried for about a day and then gave up on
  const givenUpMails = await countGivenUpMails();
  const checklist = [
    { done: unverified.n === 0, label: 'Επιβεβαίωση τιμών', detail: unverified.n ? `${unverified.n} συσκευασίες δεν έχουν επιβεβαιωμένη τιμή: στο site γράφουν «Καλέστε για τιμή».` : 'Όλες οι τιμές είναι επιβεβαιωμένες.', href: '/admin/prices?filter=unverified' },
    { done: flagged.n === 0, label: 'Έλεγχος στοιχείων προϊόντων', detail: flagged.n ? `${flagged.n} προϊόντα έχουν σημείωση προς έλεγχο (π.χ. συσκευασία που δεν φαινόταν στη φωτογραφία).` : 'Κανένα προϊόν δεν περιμένει έλεγχο.', href: '/admin/products?filter=review' },
    { done: hazardTodo === 0, label: 'Σήμανση κινδύνου στα χημικά', detail: hazardTodo ? `${hazardTodo} αντιψυκτικά, υγρά, πρόσθετα, σπρέι και δίχρονα δεν έχουν ακόμη τη σήμανση της ετικέτας τους (εικονογράμματα, «Κίνδυνος/Προσοχή», δηλώσεις). Ο ευρωπαϊκός κανονισμός για τα χημικά (CLP) ζητά να τη βλέπει ο πελάτης πριν αγοράσει online — επιβεβαιώστε το και με τον νομικό σας. Ανοίξτε κάθε προϊόν → «Σήμανση κινδύνου & SDS».` : 'Όλα τα χημικά έχουν ελεγμένη σήμανση.', href: '/admin/products?filter=hazard' },
    { done: shop.hoursVerified, label: 'Ωράριο λειτουργίας', detail: shop.hoursVerified ? 'Επιβεβαιωμένο.' : 'Το ωράριο είναι ενδεικτικό. Διορθώστε το και σημειώστε το ως επιβεβαιωμένο.', href: '/admin/settings#hours' },
    { done: Boolean(shop.vatNumber && shop.gemi), label: 'ΑΦΜ & Αρ. ΓΕΜΗ', detail: 'Ο νόμος απαιτεί να φαίνεται στο ηλεκτρονικό κατάστημα ποιος είναι ο πωλητής (εμφανίζονται στο υποσέλιδο). Η ΔΟΥ είναι προαιρετική.', href: '/admin/settings#company' },
    { done: Boolean(shop.instagramUrl && shop.skroutzUrl), label: 'Σύνδεσμοι Instagram & Skroutz', detail: shop.instagramUrl && shop.skroutzUrl ? 'Εμφανίζονται στην κεφαλίδα, στο μενού, στο υποσέλιδο και δίπλα στον χάρτη.' : `Λείπει: ${[!shop.instagramUrl && 'Instagram', !shop.skroutzUrl && 'Skroutz'].filter(Boolean).join(' και ')}. Επικολλήστε τον σύνδεσμο και θα εμφανιστεί αμέσως στο κατάστημα.`, href: '/admin/settings#social' },
    { forOrders: true, done: !payments.bankTransfer || payments.bankAccounts.some((a) => isValidIban(a.iban)), label: 'Τραπεζικός λογαριασμός (IBAN)', detail: payments.bankAccounts.length > 0 && !payments.bankAccounts.some((a) => isValidIban(a.iban)) ? 'Το IBAN που έχει αποθηκευτεί δεν είναι έγκυρο. Διορθώστε το στις ρυθμίσεις.' : 'Χρειάζεται για την πληρωμή με κατάθεση — αλλιώς απενεργοποιήστε την.', href: '/admin/settings#payments' },
    // having an address is one thing, the site being able to SEND to it (SMTP, next line) is another: say which is true
    { done: Boolean(shop.email || process.env.ORDERS_NOTIFY_EMAIL), label: 'E-mail καταστήματος', detail: !(shop.email || process.env.ORDERS_NOTIFY_EMAIL) ? 'Δεν έχει οριστεί: τα μηνύματα από τις φόρμες («Επικοινωνία», «Ποιο λάδι;») φαίνονται μόνο εδώ, στα Μηνύματα — δεν σας ειδοποιεί κανείς.' : process.env.SMTP_HOST ? 'Εκεί έρχονται τα μηνύματα από τις φόρμες του site.' : 'Η διεύθυνση έχει οριστεί και φαίνεται στο site, αλλά το site δεν στέλνει ακόμη e-mail (επόμενη γραμμή): μέχρι τότε τα μηνύματα των φορμών φαίνονται μόνο εδώ, στα Μηνύματα.', href: '/admin/settings' },
    { done: backupFresh, label: 'Αντίγραφο ασφαλείας', detail: backupFresh ? (newestBackup ? `Τελευταίο αυτόματο αντίγραφο: ${newestBackup}.` : 'Δεν χρειάζεται για αυτή τη βάση.') : `Το καθημερινό αντίγραφο δεν γράφτηκε${newestBackup ? ` από τις ${newestBackup}` : ' ποτέ'}. Ενημερώστε τον προγραμματιστή.`, href: null },
    { done: offsiteFresh, label: 'Αντίγραφο εκτός δίσκου (Backblaze B2)', detail: !offsiteOn ? 'Δεν έχει ρυθμιστεί: τα αντίγραφα μένουν στον ίδιο δίσκο με το site — αν χαθεί ο δίσκος, χάνονται όλα. Ρυθμίζεται από τον προγραμματιστή (.env).' : offsiteFresh ? `Τελευταίο επιτυχές αντίγραφο εκτός server: ${formatDateTime(new Date(lastOffsiteSuccess(offsiteLast)!))}. Κρυπτογραφημένο, ανεβαίνει κάθε βράδυ, μαζί με φωτογραφίες και δελτία ασφαλείας.` : lastOffsiteSuccess(offsiteLast) === null ? `Δεν έχει ανέβει ακόμη κανένα αντίγραφο εκτός server${offsiteLast && !offsiteLast.ok ? ': η τελευταία προσπάθεια απέτυχε' : ''}. Ελέγξτε τα στοιχεία B2 στο Railway.` : `Δεν υπάρχει επιτυχές αντίγραφο εκτός server από ${formatDateTime(new Date(lastOffsiteSuccess(offsiteLast)!))} (πάνω από 26 ώρες). ${offsiteLast && !offsiteLast.ok ? 'Η τελευταία προσπάθεια απέτυχε.' : 'Δεν έχει γίνει νέα προσπάθεια.'} Ελέγξτε τα στοιχεία B2 στο Railway.`, href: null },
    { done: Boolean(mfaRow?.confirmedAt), label: 'Επαλήθευση δύο βημάτων (2FA)', detail: mfaRow?.confirmedAt ? 'Ενεργή: η σύνδεση στη διαχείριση ζητά και κωδικό από την εφαρμογή επαλήθευσης.' : 'Ανενεργή: ένα κλεμμένο συνθηματικό αρκεί για να μπει κάποιος στη διαχείριση. Ενεργοποιήστε την — διαρκεί δύο λεπτά.', href: '/admin/settings#mfa' },
    { done: mailConfigured(), label: 'Αποστολή e-mail', detail: mailConfigured() ? 'Ρυθμισμένο.' : 'Δεν έχει ρυθμιστεί: τα e-mail γράφονται σε αρχεία αντί να στέλνονται. Ρυθμίζεται από τον προγραμματιστή (.env).', href: null },
    // with Resend and no MAIL_FROM the sender is Resend's test address: fine for the shop's own notices, not for customers (lib/startup-check.ts warns at boot too)
    { forOrders: true, done: !resendWithoutSender(), label: 'Διεύθυνση αποστολέα e-mail', detail: resendWithoutSender() ? 'Λείπει (MAIL_FROM): τα e-mail φεύγουν από τη δοκιμαστική διεύθυνση της Resend και φτάνουν μόνο στο γραμματοκιβώτιο του λογαριασμού Resend — οι πελάτες δεν θα λάβουν επιβεβαίωση παραγγελίας ή πληρωμής. Ρυθμίζεται από τον προγραμματιστή (.env).' : resendConfigured() ? 'Ρυθμισμένο.' : 'Δεν χρειάζεται: τα e-mail δεν στέλνονται μέσω Resend.', href: null },
    { forOrders: true, done: givenUpMails === 0, label: 'E-mail πληρωμών που δεν στάλθηκαν', detail: givenUpMails ? `${givenUpMails} e-mail για πληρωμές (επιβεβαίωση προς πελάτη ή ειδοποίηση προς το κατάστημα) δεν στάλθηκαν ούτε μετά από δοκιμές επί περίπου ένα εικοσιτετράωρο, τις τελευταίες ${GIVEN_UP_WINDOW_DAYS} ημέρες. Δείτε το ιστορικό των παραγγελιών («ΑΠΟΤΥΧΙΑ αποστολής…») και ενημερώστε τον προγραμματιστή.` : 'Κανένα e-mail πληρωμής δεν έμεινε απέσταλτο.', href: null },
    { forOrders: true, done: cardProvider() !== null, label: 'Πληρωμές με κάρτα', detail: cardProvider() ? `Ενεργός πάροχος: ${cardProvider()}.` : 'Δεν έχει συνδεθεί πάροχος (Viva ή Stripe): η επιλογή «κάρτα» δεν εμφανίζεται στο ταμείο. Ρυθμίζεται από τον προγραμματιστή (.env).', href: null },
    { forOrders: true, done: storefront.ordersEnabled, label: 'Άνοιγμα online παραγγελιών', detail: storefront.ordersEnabled ? 'Οι επισκέπτες μπορούν να παραγγείλουν.' : 'Κλειστές: το site λειτουργεί ως ιστοσελίδα-κατάλογος — προϊόντα, τιμές και επικοινωνία, χωρίς καλάθι, ταμείο και λογαριασμούς. Εσείς, όσο είστε συνδεδεμένος, βλέπετε ολόκληρο το κατάστημα και μπορείτε να κάνετε δοκιμαστικές παραγγελίες. Ανοίξτε τες όταν είναι όλα έτοιμα.', href: '/admin/settings#storefront' },
    { done: !storefront.demoMode, label: 'Απενεργοποίηση δοκιμαστικής λειτουργίας', detail: storefront.demoMode ? 'Όσο είναι ενεργή, το site μένει κρυφό από το Google και οι παραγγελίες σημειώνονται ως δοκιμαστικές. Κλείστε την όταν το site είναι έτοιμο να το δει ο κόσμος — γίνεται και με τις online παραγγελίες ακόμη κλειστές.' : 'Το site είναι δημόσιο και ορατό στο Google.', href: '/admin/settings#storefront' },
  ];
  // two finish lines: the site can be published as a website (catalogue mode) long before it takes orders
  const forSite = checklist.filter((c) => !('forOrders' in c));
  const forOrders = checklist.filter((c) => 'forOrders' in c);
  const remaining = forSite.filter((c) => !c.done).length;
  const remainingOrders = forOrders.filter((c) => !c.done).length;

  const stats = [
    { label: 'Σήμερα', orders: today.n, total: today.total },
    { label: '7 ημέρες', orders: week.n, total: week.total },
    { label: '30 ημέρες', orders: month.n, total: month.total },
  ];

  return (
    <>
      <PageHeader title="Επισκόπηση" description={`${productCount.n} ενεργά προϊόντα · ${pending.n} παραγγελίες σε αναμονή`}>
        <Link href="/admin/prices" className={buttonClass()}><BadgeEuro className="h-4 w-4" />Αλλαγή τιμών</Link>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <p className="text-sm font-medium text-ink-500">{s.label}</p>
            <p className="tabular mt-1 text-3xl font-bold text-ink-950">{formatPrice(s.total)}</p>
            <p className="text-sm text-ink-600">{s.orders} {s.orders === 1 ? 'παραγγελία' : 'παραγγελίες'}</p>
          </Card>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-500">Στα ποσά δεν περιλαμβάνονται δοκιμαστικές και ακυρωμένες παραγγελίες.</p>

      {(flaggedOrders.length > 0 || unmatched.length > 0) && (
        <Card title="Πληρωμές που θέλουν έλεγχο" description="Εδώ φαίνεται κάθε πληρωμή που δεν συμφωνεί με την παραγγελία της. Όταν τη χειριστείτε, πατήστε «Το χειρίστηκα»." className="mt-6 border-red-200">
          <ul className="divide-y divide-line">
            {flaggedOrders.map((o) => (
              <li key={`o${o.id}`} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <Link href={`/admin/orders/${o.id}`} className="tabular font-semibold text-petrol-500 hover:underline">{o.number}</Link>
                <span className="text-ink-700">{o.firstName} {o.lastName} · {formatPrice(o.totalCents)}</span>
                <span className="min-w-0 flex-1 basis-64 font-medium text-red-700">{latestProblem.get(o.id) ?? 'Χρειάζεται έλεγχο η πληρωμή.'}</span>
                <form action={resolvePaymentReview}><input type="hidden" name="id" value={o.id} /><button type="submit" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 font-semibold text-ink-900 hover:bg-ink-50">Το χειρίστηκα</button></form>
              </li>
            ))}
            {unmatched.map((u) => (
              <li key={`u${u.id}`} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="font-semibold text-ink-950">Πληρωμή χωρίς παραγγελία</span>
                <span className="tabular text-ink-700">{formatPrice(u.amountCents)}{u.currency && u.currency !== 'EUR' ? ` (${u.currency})` : ''} · {u.provider}</span>
                <span className="tabular min-w-0 flex-1 basis-64 break-all text-xs text-ink-500">συναλλαγή {u.transactionId} · κωδικός {u.orderCode}{u.merchantTrns ? ` · ${u.merchantTrns}` : ''} · {formatDateTime(u.createdAt)}</span>
                <form action={resolveUnmatchedPayment} className="flex gap-2">
                  <input type="hidden" name="id" value={u.id} />
                  <input name="note" placeholder="Τι έγινε (προαιρετικά)" className="field h-9 w-48 text-sm" />
                  <button type="submit" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 font-semibold text-ink-900 hover:bg-ink-50">Το χειρίστηκα</button>
                </form>
              </li>
            ))}
          </ul>
          {hiddenProblems > 0 && <p className="mt-3 text-sm text-ink-600">… και {hiddenProblems} ακόμη. Οι παραγγελίες βρίσκονται στις Παραγγελίες → «Χρειάζονται έλεγχο».</p>}
        </Card>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card title={remaining ? `Για να δημοσιευτεί η ιστοσελίδα — απομένουν ${remaining}` : 'Η ιστοσελίδα είναι έτοιμη να δημοσιευτεί'} description="Η λίστα ενημερώνεται αυτόματα καθώς ολοκληρώνετε κάθε βήμα.">
          {[forSite, forOrders].map((list, group) => (
          <div key={group}>
          {group === 1 && <h3 className="mt-5 border-t border-line pt-5 text-sm font-semibold text-ink-950">{remainingOrders ? `Αργότερα, για να ανοίξουν οι online παραγγελίες — απομένουν ${remainingOrders}` : 'Online παραγγελίες: όλα έτοιμα'}</h3>}
          <ul className="divide-y divide-line">
            {list.map((c) => {
              const body = (
                <>
                  {c.done ? <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-semibold', c.done ? 'text-ink-500 line-through' : 'text-ink-950')}>{c.label}</span>
                    <span className="block text-sm text-ink-600">{c.detail}</span>
                  </span>
                </>
              );
              return (
                <li key={c.label}>
                  {c.href && !c.done ? <Link href={c.href} className="-mx-2 flex gap-3 rounded-xl px-2 py-3 hover:bg-ink-50">{body}</Link> : <div className="flex gap-3 py-3">{body}</div>}
                </li>
              );
            })}
          </ul>
          </div>
          ))}
        </Card>

        <Card title="Τελευταίες παραγγελίες">
          {recent.length === 0 ? (
            <p className="text-sm text-ink-600">Δεν υπάρχουν παραγγελίες ακόμη.</p>
          ) : (
            <div className="-mx-4 overflow-x-auto sm:-mx-6">
              <table className="w-full min-w-[32rem]">
                <thead><tr className="border-b border-line"><th className={cn(th, 'pl-4 sm:pl-6')}>Αριθμός</th><th className={th}>Πελάτης</th><th className={th}>Κατάσταση</th><th className={th}>Πληρωμή</th><th className={cn(th, 'pr-4 text-right sm:pr-6')}>Σύνολο</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {recent.map((o) => (
                    <tr key={o.id} className="hover:bg-ink-50">
                      <td className={cn(td, 'pl-4 sm:pl-6')}><Link href={`/admin/orders/${o.id}`} className="tabular font-semibold text-petrol-500 hover:underline">{o.number}</Link><span className="block text-xs text-ink-500">{formatDateTime(o.createdAt)}</span></td>
                      <td className={td}>{o.firstName} {o.lastName}{o.isTest && <span className="ml-1.5 rounded bg-petrol-100 px-1.5 py-0.5 text-[0.625rem] font-bold text-petrol-700">TEST</span>}</td>
                      <td className={td}><StatusBadge status={o.status} /></td>
                      <td className={td}><PaymentBadge status={o.paymentStatus} /></td>
                      <td className={cn(td, 'tabular pr-4 text-right font-semibold sm:pr-6')}>{formatPrice(o.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Link href="/admin/orders" className="mt-4 inline-block text-sm font-semibold text-petrol-500 hover:underline">Όλες οι παραγγελίες →</Link>
        </Card>
      </div>
    </>
  );
}
