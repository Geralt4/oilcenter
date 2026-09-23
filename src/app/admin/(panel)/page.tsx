import Link from 'next/link';
import { and, count, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { BadgeEuro, CircleAlert, CircleCheck } from 'lucide-react';
import { Card, PageHeader, PaymentBadge, StatusBadge, td, th } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { categories, orders, products, variants } from '@/lib/db/schema';
import { hazardPriorityCategoryIds, needsHazardCheck } from '@/lib/ghs';
import { releaseAbandonedCardOrders } from '@/lib/orders';
import { cardProvider } from '@/lib/payments';
import { getSettings } from '@/lib/settings.server';
import { cn, formatDateTime, formatPrice } from '@/lib/utils';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

export default async function AdminDashboard() {
  await requireAdmin();
  await releaseAbandonedCardOrders();
  const settings = await getSettings();
  const real = and(eq(orders.isTest, false), ne(orders.status, 'cancelled'));
  const since = daysAgo;
  const sum = sql<number>`coalesce(sum(${orders.totalCents}), 0)`;

  const [[today], [week], [month], [pending], [unverified], [flagged], [productCount], recent, categoryRows, hazardRows] = await Promise.all([
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
  ]);
  // chemicals, fluids and 2-stroke oils whose hazard labelling has not been checked against the pack yet (lib/ghs.ts)
  const hazardIds = hazardPriorityCategoryIds(categoryRows);
  const hazardTodo = hazardRows.filter((p) => needsHazardCheck(p, hazardIds)).length;

  const { shop, payments, storefront } = settings;
  const checklist = [
    { done: unverified.n === 0, label: 'Επιβεβαίωση τιμών', detail: unverified.n ? `${unverified.n} συσκευασίες δεν έχουν επιβεβαιωμένη τιμή: στο κατάστημα γράφουν «Καλέστε για τιμή» και δεν μπαίνουν στο καλάθι.` : 'Όλες οι τιμές είναι επιβεβαιωμένες.', href: '/admin/prices?filter=unverified' },
    { done: flagged.n === 0, label: 'Έλεγχος στοιχείων προϊόντων', detail: flagged.n ? `${flagged.n} προϊόντα έχουν σημείωση προς έλεγχο (π.χ. συσκευασία που δεν φαινόταν στη φωτογραφία).` : 'Κανένα προϊόν δεν περιμένει έλεγχο.', href: '/admin/products?filter=review' },
    { done: hazardTodo === 0, label: 'Σήμανση κινδύνου στα χημικά', detail: hazardTodo ? `${hazardTodo} αντιψυκτικά, υγρά, πρόσθετα, σπρέι και δίχρονα δεν έχουν ακόμη τη σήμανση της ετικέτας τους (εικονογράμματα, «Κίνδυνος/Προσοχή», δηλώσεις). Ο ευρωπαϊκός κανονισμός για τα χημικά (CLP) ζητά να τη βλέπει ο πελάτης πριν αγοράσει online — επιβεβαιώστε το και με τον νομικό σας. Ανοίξτε κάθε προϊόν → «Σήμανση κινδύνου & SDS».` : 'Όλα τα χημικά έχουν ελεγμένη σήμανση.', href: '/admin/products?filter=hazard' },
    { done: shop.hoursVerified, label: 'Ωράριο λειτουργίας', detail: shop.hoursVerified ? 'Επιβεβαιωμένο.' : 'Το ωράριο είναι ενδεικτικό. Διορθώστε το και σημειώστε το ως επιβεβαιωμένο.', href: '/admin/settings#hours' },
    { done: Boolean(shop.vatNumber && shop.gemi), label: 'ΑΦΜ & Αρ. ΓΕΜΗ', detail: 'Ο νόμος απαιτεί να φαίνεται στο ηλεκτρονικό κατάστημα ποιος είναι ο πωλητής (εμφανίζονται στο υποσέλιδο). Η ΔΟΥ είναι προαιρετική.', href: '/admin/settings#company' },
    { done: Boolean(shop.instagramUrl && shop.skroutzUrl), label: 'Σύνδεσμοι Instagram & Skroutz', detail: shop.instagramUrl && shop.skroutzUrl ? 'Εμφανίζονται στην κεφαλίδα, στο μενού, στο υποσέλιδο και δίπλα στον χάρτη.' : `Λείπει: ${[!shop.instagramUrl && 'Instagram', !shop.skroutzUrl && 'Skroutz'].filter(Boolean).join(' και ')}. Επικολλήστε τον σύνδεσμο και θα εμφανιστεί αμέσως στο κατάστημα.`, href: '/admin/settings#social' },
    { done: !payments.bankTransfer || payments.bankAccounts.length > 0, label: 'Τραπεζικός λογαριασμός (IBAN)', detail: 'Χρειάζεται για την πληρωμή με κατάθεση — αλλιώς απενεργοποιήστε την.', href: '/admin/settings#payments' },
    { done: Boolean(process.env.SMTP_HOST), label: 'Αποστολή e-mail (SMTP)', detail: process.env.SMTP_HOST ? 'Ρυθμισμένο.' : 'Δεν έχει ρυθμιστεί: τα e-mail γράφονται σε αρχεία αντί να στέλνονται. Ρυθμίζεται από τον προγραμματιστή (.env).', href: null },
    { done: cardProvider() !== null, label: 'Πληρωμές με κάρτα', detail: cardProvider() ? `Ενεργός πάροχος: ${cardProvider()}.` : 'Δεν έχει συνδεθεί πάροχος (Viva ή Stripe): η επιλογή «κάρτα» δεν εμφανίζεται στο ταμείο. Ρυθμίζεται από τον προγραμματιστή (.env).', href: null },
    { done: storefront.ordersEnabled, label: 'Άνοιγμα online παραγγελιών', detail: storefront.ordersEnabled ? 'Οι επισκέπτες μπορούν να παραγγείλουν.' : 'Κλειστές: οι επισκέπτες βλέπουν προϊόντα και τιμές αλλά όχι ταμείο. Εσείς, όσο είστε συνδεδεμένος, μπορείτε να κάνετε δοκιμαστικές παραγγελίες. Ανοίξτε τες όταν είναι όλα έτοιμα.', href: '/admin/settings#storefront' },
    { done: !storefront.demoMode, label: 'Απενεργοποίηση δοκιμαστικής λειτουργίας', detail: storefront.demoMode ? 'Όσο είναι ενεργή, το site μένει κρυφό από το Google και οι παραγγελίες σημειώνονται ως δοκιμαστικές. Κλείστε την όταν το site είναι έτοιμο να το δει ο κόσμος — γίνεται και με τις online παραγγελίες ακόμη κλειστές.' : 'Το site είναι δημόσιο και ορατό στο Google.', href: '/admin/settings#storefront' },
  ];
  const remaining = checklist.filter((c) => !c.done).length;

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

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card title={remaining ? `Πριν ανοίξει το κατάστημα — απομένουν ${remaining}` : 'Το κατάστημα είναι έτοιμο'} description="Η λίστα ενημερώνεται αυτόματα καθώς ολοκληρώνετε κάθε βήμα.">
          <ul className="divide-y divide-line">
            {checklist.map((c) => {
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
