import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { Download, ExternalLink, TriangleAlert } from 'lucide-react';
import { importCodesCsv, saveSkroutzSettings } from '@/app/admin/actions';
import { AdminForm } from '@/components/admin/admin-form';
import { CodesEditor, type CodeRow } from '@/components/admin/codes-editor';
import { CopyField } from '@/components/admin/copy-field';
import { Card, Check, Field, PageHeader } from '@/components/admin/ui';
import { buttonClass } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { brands, products, variants } from '@/lib/db/schema';
import { SKROUTZ_AVAILABILITY } from '@/lib/settings';
import { getSettings } from '@/lib/settings.server';
import { buildSkroutzFeed, FEED_EXCLUSION_LABELS, FEED_PATH, getFeedLog, type FeedExclusion } from '@/lib/skroutz-feed';
import { siteUrl } from '@/lib/site-url';
import { cn, formatDateTime } from '@/lib/utils';

export const metadata = { title: 'Skroutz' };

/** Reasons the owner can do something about come first; switched-off products are left out on purpose. */
const REASON_ORDER: FeedExclusion[] = ['price_unconfirmed', 'unavailable', 'out_of_stock', 'no_brand', 'no_category', 'size_inactive', 'product_inactive'];

/** The only address the feed may be registered under at Skroutz (same value scripts/test-feed.ts checks against). */
const CANONICAL_ORIGIN = 'https://www.oilcenter.gr';

export default async function AdminSkroutzPage() {
  await requireAdmin();
  const settings = await getSettings();
  const [feed, log, rows] = await Promise.all([
    buildSkroutzFeed(settings),
    getFeedLog(),
    db
      .select({ v: variants, productId: products.id, productName: products.name, brandName: brands.name })
      .from(variants)
      .innerJoin(products, eq(variants.productId, products.id))
      .leftJoin(brands, eq(products.brandId, brands.id))
      .orderBy(asc(brands.name), asc(products.name), asc(variants.sort)),
  ]);

  const { skroutz, storefront } = settings;
  const base = siteUrl();
  const feedUrl = `${base}${FEED_PATH}`;
  const inFeed = new Set(feed.items.map((i) => i.variantId));
  const codeRows: CodeRow[] = rows.map((r) => ({ id: r.v.id, productId: r.productId, brand: r.brandName, product: r.productName, label: r.v.label, sku: r.v.sku, barcode: r.v.barcode ?? '', mpn: r.v.mpn ?? '', inFeed: inFeed.has(r.v.id) }));

  const missingEan = feed.items.filter((i) => !i.ean).length;
  const missingMpn = feed.items.filter((i) => !i.mpn).length;
  const invalidEans = feed.items.filter((i) => i.invalidEan);
  const leftOutByReason = REASON_ORDER.map((reason) => ({ reason, list: feed.leftOut.filter((l) => l.reason === reason) })).filter((g) => g.list.length);
  const actionable = feed.leftOut.filter((l) => l.reason !== 'product_inactive' && l.reason !== 'size_inactive').length;

  const warnings: string[] = [];
  if (process.env.SITE_PASSWORD) warnings.push('Το site είναι κλειδωμένο με κωδικό πρόσβασης. Το Skroutz δεν μπορεί να συνδεθεί πουθενά: δεν θα διαβάσει ούτε το αρχείο ούτε τις σελίδες και τις φωτογραφίες των προϊόντων.');
  if (storefront.demoMode) warnings.push('Το site είναι σε δοκιμαστική λειτουργία. Το Skroutz ελέγχει δειγματοληπτικά τις σελίδες των προϊόντων και θα βρει την ένδειξη «δοκιμαστική λειτουργία».');
  // Anything but the canonical origin counts as temporary: the preview address, localhost, http, and also the bare
  // oilcenter.gr or a typo in SITE_URL — the feed address handed to Skroutz must never need re-sending.
  if (base !== CANONICAL_ORIGIN) warnings.push(`Η διεύθυνση του site είναι προσωρινή (${base}). Δώστε τη διεύθυνση του αρχείου στο Skroutz μόνο όταν το site είναι στο ${CANONICAL_ORIGIN} — αν αλλάξει αργότερα, πρέπει να τη στείλετε ξανά.`);
  if (!storefront.ordersEnabled) warnings.push('Οι online παραγγελίες είναι κλειστές. Αν το Skroutz στέλνει τους πελάτες στο site σας για να αγοράσουν (και όχι μέσα από το καλάθι του Skroutz), θα βρουν κλειστό ταμείο.');

  return (
    <>
      <PageHeader title="Skroutz" description="Το αρχείο προϊόντων (XML) που διαβάζει το Skroutz. Όταν συνδεθεί, κάθε τιμή που αλλάζετε στις «Τιμές» περνά μόνη της και στο Skroutz μέσα σε μία ώρα περίπου — δεν την ξαναγράφετε εκεί.">
        <a href={FEED_PATH} target="_blank" rel="noopener" className={buttonClass({ variant: 'outline', size: 'sm' })}><ExternalLink className="h-4 w-4" />Προβολή αρχείου</a>
        <a href={`${FEED_PATH}?download=1`} className={buttonClass({ variant: 'dark', size: 'sm' })}><Download className="h-4 w-4" />Λήψη XML</a>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Συσκευασίες στο αρχείο', value: feed.items.length, hint: `από ${rows.length} συνολικά` },
          { label: 'Εκτός αρχείου', value: actionable, hint: actionable ? 'δείτε γιατί, πιο κάτω' : 'όλα όσα πωλούνται είναι μέσα' },
          { label: 'Χωρίς barcode', value: missingEan, hint: 'το Skroutz αναγνωρίζει το προϊόν από αυτό' },
          { label: 'Χωρίς κωδικό κατασκευαστή', value: missingMpn, hint: 'στέλνεται ο δικός σας κωδικός στη θέση του' },
        ].map((k) => (
          <Card key={k.label}>
            <p className="text-sm font-medium text-ink-500">{k.label}</p>
            <p className="tabular mt-1 text-3xl font-bold text-ink-950">{k.value}</p>
            <p className="text-sm text-ink-600">{k.hint}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card title="Διεύθυνση του αρχείου" description="Αυτή τη διεύθυνση δίνετε στο Skroutz. Δεν αλλάζει ποτέ· το περιεχόμενό της φτιάχνεται εκείνη τη στιγμή, με τις τιμές που ισχύουν.">
          <CopyField value={feedUrl} label="Διεύθυνση του αρχείου XML" />
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-700">
            <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', skroutz.feedEnabled ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-700')}>{skroutz.feedEnabled ? 'Ανοιχτό' : 'Κλειστό'}</span>
            {skroutz.feedEnabled ? 'Όποιος έχει τη διεύθυνση μπορεί να το διαβάσει.' : 'Το βλέπετε μόνο εσείς, όσο είστε συνδεδεμένος εδώ. Για όλους τους άλλους η διεύθυνση δεν υπάρχει.'}
          </p>
          <p className="mt-2 text-sm text-ink-700">
            {log.lastBotAt ? <>Τελευταία ανάγνωση από το Skroutz: <strong className="tabular">{formatDateTime(log.lastBotAt)}</strong> · {log.botFetches} {log.botFetches === 1 ? 'φορά' : 'φορές'} συνολικά.</> : 'Το Skroutz δεν το έχει διαβάσει ακόμη.'}
          </p>
          {warnings.length > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 p-3.5 text-sm text-amber-950">
              <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="h-4 w-4 shrink-0" />Πριν δώσετε τη διεύθυνση στο Skroutz</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
        </Card>

        <Card title="Ρυθμίσεις αρχείου">
          <AdminForm action={saveSkroutzSettings} submitLabel="Αποθήκευση" variant="dark" size="sm">
            <div className="space-y-4">
              <Check name="feedEnabled" label="Το αρχείο είναι ανοιχτό για το Skroutz" defaultChecked={skroutz.feedEnabled} hint="Ανοίξτε το όταν το site είναι δημόσιο και έτοιμο. Αν το κλείσετε αφού συνδεθεί, το Skroutz θα σταματήσει να ενημερώνεται και μετά από λίγο θα κρύψει τα προϊόντα σας." />
              <Field label="Τι δηλώνεται για όσα είναι «Άμεσα διαθέσιμα»" hint="Οι φράσεις του Skroutz μιλούν για παράδοση στον πελάτη. Το «Άμεσα διαθέσιμο» σημαίνει αποστολή την ίδια ημέρα· αν δεν το εγγυάστε, κρατήστε το «1 έως 3 ημέρες». Όσα έχετε σημειώσει «Σε 1–3 ημέρες» δηλώνονται «4 έως 6 ημέρες», τα «Κατόπιν παραγγελίας» «7 έως 12 ημέρες», και τα «Μη διαθέσιμα» δεν στέλνονται καθόλου.">
                <select name="availability" defaultValue={skroutz.availability} className="field cursor-pointer">
                  {SKROUTZ_AVAILABILITY.slice(0, 2).map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Τεμάχια που δηλώνονται ανά συσκευασία" hint="Το Skroutz ζητά αριθμό τεμαχίων. Για όσες συσκευασίες δεν μετράτε απόθεμα δηλώνεται αυτός ο αριθμός· για όσες μετράτε, το πραγματικό απόθεμα (στο 0 βγαίνουν από το αρχείο)." className="max-w-xs">
                <input name="defaultQuantity" inputMode="numeric" defaultValue={skroutz.defaultQuantity} className="field tabular" />
              </Field>
            </div>
          </AdminForm>
        </Card>
      </div>

      <Card title="Barcodes & κωδικοί κατασκευαστή" description="Το Skroutz ταιριάζει κάθε προϊόν σας με τη σελίδα του κυρίως από το barcode (EAN) και τον κωδικό του κατασκευαστή — και τα δύο είναι τυπωμένα στην ετικέτα. Όσα περισσότερα συμπληρωθούν, τόσο λιγότερα προϊόντα θα μείνουν «προς έλεγχο» στο Skroutz. Κάθε συσκευασία (1L, 4L…) έχει το δικό της barcode." className="mt-6">
        <div id="codes">
          {(invalidEans.length > 0 || feed.duplicateEans.length > 0) && (
            <p className="mb-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
              {invalidEans.length > 0 && <>Barcodes με λάθος ψηφίο (δεν στέλνονται): {invalidEans.slice(0, 6).map((i) => i.name).join(' · ')}{invalidEans.length > 6 ? '…' : ''}. </>}
              {feed.duplicateEans.length > 0 && <>Το ίδιο barcode σε δύο συσκευασίες: {feed.duplicateEans.slice(0, 6).join(', ')}.</>}
            </p>
          )}
          <CodesEditor rows={codeRows} />
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer font-semibold text-ink-900">Έχετε λίστα από προμηθευτή; Εισαγωγή από CSV</summary>
            <p className="mt-2 text-ink-600">Στήλες: <code className="tabular rounded bg-ink-100 px-1">sku;ean;mpn</code> (αρκεί μία από τις δύο τελευταίες). Οι κωδικοί <code className="tabular rounded bg-ink-100 px-1">sku</code> είναι αυτοί της <a href="/admin/prices/export" className="font-medium text-petrol-500 underline underline-offset-2">εξαγωγής τιμών</a>. Τα κενά κελιά δεν αλλάζουν τίποτα.</p>
            <AdminForm action={importCodesCsv} submitLabel="Εισαγωγή CSV" variant="dark" size="sm" className="mt-3">
              <input type="file" name="file" accept=".csv,text/csv" required className="block w-full cursor-pointer text-sm text-ink-700 file:mr-4 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-ink-100 file:px-4 file:text-sm file:font-semibold file:text-ink-900 hover:file:bg-ink-200" />
            </AdminForm>
          </details>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Τι μένει εκτός αρχείου" description="Στο Skroutz φτάνουν μόνο συσκευασίες με επιβεβαιωμένη τιμή, ενεργές και διαθέσιμες.">
          {leftOutByReason.length === 0 ? (
            <p className="text-sm text-ink-600">Τίποτα: όλες οι συσκευασίες είναι στο αρχείο.</p>
          ) : (
            <div className="space-y-2">
              {leftOutByReason.map((g) => (
                <details key={g.reason} className="rounded-xl border border-line px-3.5 py-2.5">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-ink-900">
                    {FEED_EXCLUSION_LABELS[g.reason]}
                    <span className="tabular rounded-full bg-ink-100 px-2 py-0.5 text-xs">{g.list.length}</span>
                  </summary>
                  {g.reason === 'price_unconfirmed' && <p className="mt-2 text-sm text-ink-600">Γράψτε ή επιβεβαιώστε την τιμή στις <Link href="/admin/prices?filter=unverified" className="font-medium text-petrol-500 underline underline-offset-2">Τιμές</Link> και η συσκευασία μπαίνει στο αρχείο αμέσως.</p>}
                  {g.reason === 'unavailable' && <p className="mt-2 text-sm text-ink-600">Μόλις ξαναέρθει, αλλάξτε τη διαθεσιμότητα στις <Link href="/admin/prices?filter=waiting" className="font-medium text-petrol-500 underline underline-offset-2">Τιμές</Link> και επιστρέφει και στο Skroutz.</p>}
                  <ul className="mt-2 space-y-1 text-sm text-ink-700">
                    {g.list.map((l) => (
                      <li key={l.variantId}><Link href={`/admin/products/${l.productId}`} className="hover:underline">{l.name}</Link></li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </Card>

        <Card title="Πώς συνδέεται">
          <ol className="list-decimal space-y-2.5 pl-5 text-sm text-ink-800">
            <li>Το site είναι δημόσιο στο oilcenter.gr, χωρίς κωδικό πρόσβασης και χωρίς «δοκιμαστική λειτουργία».</li>
            <li>Ανοίγετε το αρχείο (ρύθμιση πιο πάνω) και το ελέγχετε: <strong>Λήψη XML</strong> και ανέβασμα στο <a href="https://validator.skroutz.gr" target="_blank" rel="noopener noreferrer" className="font-medium text-petrol-500 underline underline-offset-2">validator.skroutz.gr</a>.</li>
            <li>Στέλνετε τη διεύθυνση του αρχείου στο Skroutz, από τον Χώρο Συνεργατών: <a href="https://merchants.skroutz.gr/merchants/help/new/products/feed_file" target="_blank" rel="noopener noreferrer" className="font-medium text-petrol-500 underline underline-offset-2">Βοήθεια → Προϊόντα → Αρχείο XML</a>. Το ελέγχουν και, αν θέλουν διορθώσεις, απαντούν με παραδείγματα.</li>
            <li>Μετά τη σύνδεση το διαβάζουν περίπου κάθε ώρα (08:00–00:00). Στον Χώρο Συνεργατών εμφανίζεται η ενότητα «Ανανεώσεις Προϊόντων».</li>
          </ol>
          <p className="mt-4 rounded-xl bg-amber-50 p-3.5 text-sm text-amber-950">
            <strong>Πριν τη σύνδεση ρωτήστε το Skroutz</strong> τι θα γίνει με όσα προϊόντα έχετε σήμερα εκεί αλλά δεν υπάρχουν ακόμη στο site. Κατά κανόνα, μόλις συνδεθεί αρχείο, στο Skroutz μένουν μόνο όσα περιέχει.
          </p>
        </Card>
      </div>
    </>
  );
}
