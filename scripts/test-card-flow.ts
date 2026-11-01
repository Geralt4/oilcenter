/*
 * Card-payment flow test. Runs the Viva card path end to end against a throwaway copy of the local database, a locally
 * started production build and scripts/fake-viva.ts standing in for Viva. Customers are driven through the real UI.
 *
 *   npm run test:card
 *
 * No real payment provider, e-mail service, backup bucket or production database is touched: the server environment is
 * built from scratch (nothing is inherited from the shell) and mail lands in the throwaway DATA_DIR/outbox.
 * Playwright's browser binary is detected from the standard cache; set CHROMIUM_PATH to override it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { cloneDatabase } from './test-db';
import { startFakeViva } from './fake-viva';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

/** Playwright expects the revision from its own package; a compatible cached build is fine locally. */
function cachedChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [path.join(homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(homedir(), '.cache', 'ms-playwright')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const revisions = readdirSync(root).filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const revision of revisions) {
      const dir = path.join(root, revision);
      const candidates = [
        path.join(dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(dir, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(dir, 'chrome-linux64', 'chrome'),
      ];
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) return found;
    }
  }
  return undefined;
}

type Mail = { file: string; to: string; subject: string };

/** Mail the shop wrote to DATA_DIR/outbox. Each file starts with `<!-- to: … | subject: … -->`. */
function listOutbox(outbox: string): Mail[] {
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((file) => file.endsWith('.html'))
    .map((file) => {
      const firstLine = readFileSync(path.join(outbox, file), 'utf8').split('\n', 1)[0] ?? '';
      const match = firstLine.match(/^<!-- to: (.*) \| subject: (.*) -->$/);
      return { file, to: match?.[1] ?? '', subject: match?.[2] ?? '' };
    });
}

const succeeded = (url: URL) => url.pathname.startsWith('/order/') && url.searchParams.get('payment') === 'success';

async function main() {
  const repo = process.cwd();
  const dir = await cloneDatabase('oc-card-');
  const databaseUrl = process.env.DATABASE_URL!;
  const dataDir = path.join(dir, 'data');
  const outbox = path.join(dataDir, 'outbox');
  const port = 3198;
  const base = `http://127.0.0.1:${port}`;
  const authSecret = 'card-flow-e2e-only-secret-not-used-in-production-0123456789';

  const { eq, and, ne, asc } = await import('drizzle-orm');
  const { db, client } = await import('../src/lib/db');
  const { orders, paymentAttempts, orderEvents, unmatchedPayments, products, variants, settings, rateLimits } = await import('../src/lib/db/schema');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');

  // Fresh per-IP limits, and a shop that takes orders.
  await db.delete(rateLimits);
  const storefront = { ...DEFAULT_SETTINGS.storefront, ordersEnabled: true };
  await db
    .insert(settings)
    .values({ key: 'storefront', value: storefront })
    .onConflictDoUpdate({ target: settings.key, set: { value: storefront, updatedAt: new Date() } });

  // One active, price-verified, in-stock size of one product, and nothing else of that product, so the cart is predictable.
  const [pick] = await db
    .select({ productId: products.id, slug: products.slug, variantId: variants.id, priceCents: variants.priceCents })
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .orderBy(asc(products.id), asc(variants.sort), asc(variants.id))
    .limit(1);
  if (!pick) throw new Error('The throwaway database has no variants to order.');
  await db.update(products).set({ isActive: true }).where(eq(products.id, pick.productId));
  await db.update(variants).set({ isActive: false }).where(and(eq(variants.productId, pick.productId), ne(variants.id, pick.variantId)));
  await db
    .update(variants)
    .set({ isActive: true, priceVerified: true, availability: 'in_stock', trackStock: false })
    .where(eq(variants.id, pick.variantId));
  console.log(`Test product: /product/${pick.slug} at ${pick.priceCents} cents`);

  // Started before the shop, so the shop's first call to Viva finds it.
  const fake = await startFakeViva({ siteBase: base, sourceCode: 'FAKE-SOURCE' });

  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const nextBin = path.join(repo, 'node_modules', 'next', 'dist', 'bin', 'next');
    // Built from scratch: nothing from the shell reaches the shop, so no real Viva, mail or backup credentials can leak in.
    const serverEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: databaseUrl,
      DATA_DIR: dataDir,
      AUTH_SECRET: authSecret,
      SITE_URL: base,
      VIVA_ENV: 'demo',
      VIVA_CLIENT_ID: 'fake-client-id',
      VIVA_CLIENT_SECRET: 'fake-client-secret',
      VIVA_SOURCE_CODE: 'FAKE-SOURCE',
      VIVA_MERCHANT_ID: 'fake-merchant-id',
      VIVA_API_KEY: 'fake-api-key',
      VIVA_TEST_BASE_URL: fake.baseUrl,
      RESEND_API_KEY: '',
      SMTP_HOST: '',
      STRIPE_SECRET_KEY: '',
      ORDERS_NOTIFY_EMAIL: 'owner@example.invalid',
      SITE_PASSWORD: '',
      B2_KEY_ID: '',
      B2_APP_KEY: '',
      B2_BUCKET: '',
      B2_ENDPOINT: '',
      BACKUP_ENCRYPTION_KEY: '',
    };
    server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: repo,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    server.stdout?.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });
    server.stderr?.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });

    let healthy = false;
    for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
      await delay(500);
      if (server.exitCode !== null) break;
      healthy = await fetch(`${base}/api/health`).then((res) => res.ok).catch(() => false);
    }
    if (!healthy) throw new Error(`The test server did not start.\n${logs}`);

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      const executablePath = cachedChromium();
      if (!executablePath) throw new Error('Chromium is not installed. Run: npx playwright-core install chromium');
      browser = await chromium.launch({ headless: true, executablePath });
    }

    // ── helpers ────────────────────────────────────────────────────────────────
    const newPage = async (): Promise<{ ctx: BrowserContext; page: Page }> => {
      const ctx = await browser!.newContext();
      return { ctx, page: await ctx.newPage() };
    };
    const snapshot = () => new Set(listOutbox(outbox).map((mail) => mail.file));
    const mailsSince = (before: Set<string>) => listOutbox(outbox).filter((mail) => !before.has(mail.file));

    const orderByRef = async (ref: string) => {
      const [row] = await db
        .select({ order: orders })
        .from(paymentAttempts)
        .innerJoin(orders, eq(paymentAttempts.orderId, orders.id))
        .where(and(eq(paymentAttempts.provider, 'viva'), eq(paymentAttempts.ref, ref)));
      if (!row) throw new Error(`No order is recorded for checkout ${ref}.`);
      return row.order;
    };
    const orderByNumber = async (number: string) => {
      const [row] = await db.select().from(orders).where(eq(orders.number, number));
      if (!row) throw new Error(`No order ${number}.`);
      return row;
    };
    const eventsOf = (orderId: number) => db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    const attemptsOf = (orderId: number) => db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

    const alertShows = (page: Page, text: string) =>
      page.getByRole('alert').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);

    const startCheckout = async (page: Page) => {
      await page.goto(`${base}/product/${pick.slug}`);
      await page.getByRole('button', { name: /^Προσθήκη ·/ }).click();
      const drawer = page.getByRole('dialog', { name: 'Καλάθι αγορών' });
      await drawer.getByRole('link', { name: 'Ολοκλήρωση παραγγελίας' }).click();
      await page.waitForURL((url) => url.pathname === '/checkout', { timeout: 20_000 });
    };
    const submitCardCheckout = async (page: Page) => {
      await page.locator('#firstName').fill('Ελένη');
      await page.locator('#lastName').fill('Δοκιμή');
      await page.locator('#email').fill('card-test@example.invalid');
      await page.locator('#phone').fill('6912345678');
      await page.locator('input[name="shippingMethod"][value="pickup"]').check();
      await page.locator('input[name="paymentMethod"][value="card"]').check();
      await page.locator('#acceptTerms').check();
      await page.getByRole('button', { name: /^Συνέχεια στην πληρωμή/ }).click();
    };
    /** Cart → checkout → card → submit. Returns once the browser is on the fake Viva page; the checkout ref is its ?ref=. */
    const placeCardOrder = async (page: Page): Promise<string> => {
      await startCheckout(page);
      await submitCardCheckout(page);
      await page.waitForURL((url) => url.toString().startsWith(`${fake.baseUrl}/web/checkout?`), { timeout: 30_000 });
      return new URL(page.url()).searchParams.get('ref') ?? '';
    };
    const refOf = (page: Page) => new URL(page.url()).searchParams.get('ref') ?? '';
    const onFakeCheckout = (url: URL) => url.toString().startsWith(`${fake.baseUrl}/web/checkout?`);

    // ── S1 ─────────────────────────────────────────────────────────────────────
    const s1 = async () => {
      console.log('S1 success on the first checkout');
      fake.webhookMode = 'before-return';
      const { ctx, page } = await newPage();
      try {
        const before = snapshot();
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL(succeeded, { timeout: 30_000 });
        const thanked = await page.getByRole('heading', { name: /Ευχαριστούμε/ }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
        check('after «Πληρωμή» the browser lands on the success page', thanked && page.url().includes(placed.number), page.url());

        const paid = await orderByNumber(placed.number);
        check('the order is paid and confirmed', paid.paymentStatus === 'paid' && paid.status === 'confirmed', { paymentStatus: paid.paymentStatus, status: paid.status });
        check('the payment reference is stored on the order', Boolean(paid.paymentTransactionId));
        check('no payment flag is raised', paid.paymentFlag === null, paid.paymentFlag);
        const events = await eventsOf(placed.id);
        check('no event warns of a problem', !events.some((event) => event.message.includes('ΠΡΟΣΟΧΗ')), events.map((event) => event.message));

        const mails = mailsSince(before).filter((mail) => mail.subject.includes(placed.number));
        const confirmations = mails.filter((mail) => mail.subject.startsWith('Η παραγγελία σας'));
        const ownerNew = mails.filter((mail) => mail.subject.startsWith('Νέα παραγγελία'));
        check('exactly one customer confirmation mail', confirmations.length === 1, mails.map((mail) => mail.subject));
        check('exactly one owner mail "Νέα παραγγελία"', ownerNew.length === 1, mails.map((mail) => mail.subject));
        check('that mail says the card payment is awaited', ownerNew.length === 1 && ownerNew[0]!.subject.endsWith('ΑΝΑΜΕΝΕΤΑΙ ΠΛΗΡΩΜΗ ΜΕ ΚΑΡΤΑ'), ownerNew.map((mail) => mail.subject));
        const ownerPaid = mails.filter((mail) => mail.subject.startsWith('Πληρώθηκε με κάρτα:'));
        check('exactly one owner mail "Πληρώθηκε με κάρτα:"', ownerPaid.length === 1, mails.map((mail) => mail.subject));
      } finally {
        await ctx.close();
      }
    };

    // ── S2 ─────────────────────────────────────────────────────────────────────
    const s2 = async () => {
      console.log('S2 failed payment, then a retry from the order page');
      fake.webhookMode = 'none';
      const { ctx, page } = await newPage();
      try {
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        await page.getByRole('link', { name: 'Αποτυχία', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/order-status', { timeout: 30_000 });
        check('a failed payment sends the buyer to the lookup page with ?payment=failed', page.url().includes('/order-status?payment=failed'), page.url());

        await page.locator('#number').fill(placed.number);
        await page.locator('#email').fill(placed.email);
        await page.getByRole('button', { name: 'Αναζήτηση παραγγελίας' }).click();
        await page.waitForURL((url) => url.pathname.startsWith('/order/'), { timeout: 30_000 });
        check('the lookup shows the unpaid card payment', await alertShows(page, 'Εκκρεμεί η πληρωμή με κάρτα'));
        const retry = page.getByRole('button', { name: 'Πληρωμή με κάρτα' });
        check('the order page offers the card retry', await retry.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false));

        await retry.click();
        await page.waitForURL(onFakeCheckout, { timeout: 30_000 });
        const retryRef = refOf(page);
        check('the retry opens a new checkout', retryRef !== '' && retryRef !== ref, { ref, retryRef });
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL(succeeded, { timeout: 30_000 });

        const paid = await orderByNumber(placed.number);
        check('the retry pays the order', paid.paymentStatus === 'paid' && paid.status === 'confirmed', { paymentStatus: paid.paymentStatus, status: paid.status });
        const attempts = await attemptsOf(placed.id);
        check('two payment attempts are on record', attempts.length === 2, attempts.map((attempt) => `${attempt.ref}:${attempt.status}`));
      } finally {
        await ctx.close();
      }
    };

    // ── S3 ─────────────────────────────────────────────────────────────────────
    const s3 = async () => {
      console.log('S3 older checkout is paid after the order was paid on a newer one');
      fake.webhookMode = 'none';
      const { ctx, page } = await newPage();
      try {
        const before = snapshot();
        const refA = await placeCardOrder(page);
        const placed = await orderByRef(refA);

        await page.goto(`${base}/order-status`);
        await page.locator('#number').fill(placed.number);
        await page.locator('#email').fill(placed.email);
        await page.getByRole('button', { name: 'Αναζήτηση παραγγελίας' }).click();
        await page.waitForURL((url) => url.pathname.startsWith('/order/'), { timeout: 30_000 });
        await page.getByRole('button', { name: 'Πληρωμή με κάρτα' }).click();
        await page.waitForURL(onFakeCheckout, { timeout: 30_000 });
        const refB = refOf(page);
        check('the newer checkout is a different one', refB !== '' && refB !== refA, { refA, refB });
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL(succeeded, { timeout: 30_000 });
        const paid = await orderByNumber(placed.number);
        check('the newer checkout pays the order', paid.paymentStatus === 'paid' && paid.paymentTransactionId !== null);
        const originalTransaction = paid.paymentTransactionId;

        // The older checkout (ref A) is still open in another tab and gets paid too.
        const older = await ctx.newPage();
        await older.goto(`${fake.baseUrl}/fake/pay?ref=${refA}`);
        await older.waitForURL((url) => url.pathname === '/order-status', { timeout: 30_000 });
        const landed = new URL(older.url());
        check('the older payment ends on the lookup page with ?payment=review, with no secret link or success state', landed.pathname === '/order-status' && landed.searchParams.get('payment') === 'review' && !landed.searchParams.has('t'), older.url());

        const after = await orderByNumber(placed.number);
        check('the order stays paid with its original payment', after.paymentStatus === 'paid' && after.paymentTransactionId === originalTransaction, { before: originalTransaction, after: after.paymentTransactionId });
        check('the order is flagged for review', after.paymentFlag === 'review', after.paymentFlag);
        const events = await eventsOf(placed.id);
        check('an event names the second payment', events.some((event) => event.message.includes('δεύτερη πληρωμή')), events.map((event) => event.message));
        const review = mailsSince(before).filter((mail) => mail.subject.startsWith('Χρειάζεται έλεγχος: πληρωμή OC-') && mail.subject.includes(placed.number));
        check('the owner gets one review mail', review.length === 1, mailsSince(before).map((mail) => mail.subject));
      } finally {
        await ctx.close();
      }
    };

    // ── S4 ─────────────────────────────────────────────────────────────────────
    const s4 = async () => {
      console.log('S4 paid amount differs from the order total');
      fake.webhookMode = 'before-return';
      const { ctx, page } = await newPage();
      try {
        const before = snapshot();
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        fake.reportAmountCents = placed.totalCents + 500;
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/order-status', { timeout: 30_000 });
        check('the wrong amount ends on the lookup page with ?payment=review', page.url().includes('/order-status?payment=review'), page.url());

        const after = await orderByNumber(placed.number);
        check('the order is not marked paid', after.paymentStatus === 'pending', after.paymentStatus);
        check('the order is flagged for review', after.paymentFlag === 'review', after.paymentFlag);
        const review = mailsSince(before).filter((mail) => mail.subject.startsWith('Χρειάζεται έλεγχος: πληρωμή OC-') && mail.subject.includes(placed.number));
        check('exactly one owner review mail, though the webhook and the return both reported it', review.length === 1, mailsSince(before).map((mail) => mail.subject));
        const events = await eventsOf(placed.id);
        const alarms = events.filter((event) => event.message.includes('ΠΡΟΣΟΧΗ'));
        check('exactly one ΠΡΟΣΟΧΗ event', alarms.length === 1, events.map((event) => event.message));
      } finally {
        fake.reportAmountCents = null;
        await ctx.close();
      }
    };

    // ── S5 ─────────────────────────────────────────────────────────────────────
    const s5 = async () => {
      console.log('S5 paid transaction for a checkout that matches no order');
      const code = '9999999999999999';
      const before = snapshot();
      const { transactionId } = fake.payNow(code, { amountCents: 1234 });
      const first = await fake.sendWebhook(code, transactionId);
      const second = await fake.sendWebhook(code, transactionId);
      check('the shop accepts the webhook both times', first === 200 && second === 200, { first, second });
      const rows = await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.orderCode, code));
      check('exactly one unmatched payment is kept, for 1234 cents', rows.length === 1 && rows[0]?.amountCents === 1234, rows);
      const alerts = mailsSince(before).filter((mail) => mail.subject.startsWith('Χρειάζεται έλεγχος: πληρωμή χωρίς παραγγελία'));
      check('the shop gets exactly one mail about it', alerts.length === 1, mailsSince(before).map((mail) => mail.subject));
    };

    // ── S6 ─────────────────────────────────────────────────────────────────────
    const s6 = async () => {
      console.log('S6 Viva refuses to create the checkout');
      fake.failCreateOrder = true;
      const { ctx, page } = await newPage();
      try {
        await startCheckout(page);
        await submitCardCheckout(page);
        await page.waitForURL((url) => url.pathname.startsWith('/order/'), { timeout: 30_000 });
        check('the buyer lands on the order page', page.url().includes('/order/'), page.url());
        check('the order page says the payment did not complete', await alertShows(page, 'Η πληρωμή δεν ολοκληρώθηκε'));
        const retry = page.getByRole('button', { name: 'Πληρωμή με κάρτα' });
        check('the order page offers the card retry', await retry.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false));
      } finally {
        fake.failCreateOrder = false;
        await ctx.close();
      }
    };

    // ── S7 ─────────────────────────────────────────────────────────────────────
    const s7 = async () => {
      console.log('S7 payment lands after the order was cancelled');
      fake.webhookMode = 'before-return';
      const { ctx, page } = await newPage();
      try {
        const before = snapshot();
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, placed.id));
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/order-status', { timeout: 30_000 });
        const landed = new URL(page.url());
        check('the late payment ends on the lookup page with ?payment=review, with no secret link or success state', landed.pathname === '/order-status' && landed.searchParams.get('payment') === 'review' && !landed.searchParams.has('t'), page.url());

        const after = await orderByNumber(placed.number);
        check("the payment is recorded as paid while the order stays cancelled", after.paymentStatus === 'paid' && after.status === 'cancelled', { paymentStatus: after.paymentStatus, status: after.status });
        check('the order is flagged for review', after.paymentFlag === 'review', after.paymentFlag);
        const mails = mailsSince(before).filter((mail) => mail.subject.includes(placed.number));
        const review = mails.filter((mail) => mail.subject.startsWith('Χρειάζεται έλεγχος: πληρωμή OC-'));
        check('exactly one owner review mail', review.length === 1, mails.map((mail) => mail.subject));
        check('no customer confirmation mail for that order', !mails.some((mail) => mail.subject.startsWith('Η παραγγελία σας')), mails.map((mail) => mail.subject));
        const events = await eventsOf(placed.id);
        check("an event says the order had been cancelled", events.some((event) => event.message.includes('ακυρωθεί')), events.map((event) => event.message));
      } finally {
        await ctx.close();
      }
    };

    // ── S8 ─────────────────────────────────────────────────────────────────────
    const s8 = async () => {
      console.log('S8 the payment is still pending at Viva');
      fake.webhookMode = 'none';
      fake.pendingMode = true;
      const { ctx, page } = await newPage();
      try {
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/order-status' && url.searchParams.get('payment') === 'pending', { timeout: 30_000 });
        check('a pending payment ends on the lookup page with ?payment=pending', page.url().includes('/order-status?payment=pending'), page.url());
        const shown = await page.getByRole('status').filter({ hasText: 'Η πληρωμή σας βρίσκεται σε επεξεργασία' }).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
        check("the page says 'Η πληρωμή σας βρίσκεται σε επεξεργασία'", shown);
        const after = await orderByNumber(placed.number);
        check('the order stays unpaid', after.paymentStatus !== 'paid', after.paymentStatus);
      } finally {
        fake.pendingMode = false;
        await ctx.close();
      }
    };

    // ── S9 ─────────────────────────────────────────────────────────────────────
    const s9 = async () => {
      console.log('S9 failure banner on the lookup page');
      fake.webhookMode = 'none';
      const { ctx, page } = await newPage();
      try {
        await placeCardOrder(page);
        await page.getByRole('link', { name: 'Αποτυχία', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/order-status' && url.searchParams.get('payment') === 'failed', { timeout: 30_000 });
        const shown = await page.getByRole('status').filter({ hasText: 'Η πληρωμή δεν ολοκληρώθηκε' }).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
        check("after «Αποτυχία» the lookup page shows 'Η πληρωμή δεν ολοκληρώθηκε'", shown, page.url());
      } finally {
        await ctx.close();
      }
    };

    // ── S10 ────────────────────────────────────────────────────────────────────
    const s10 = async () => {
      console.log('S10 refunded order offers no card retry');
      fake.webhookMode = 'none';
      const { ctx, page } = await newPage();
      try {
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        await page.getByRole('link', { name: 'Πληρωμή', exact: true }).click();
        await page.waitForURL(succeeded, { timeout: 30_000 });
        await db.update(orders).set({ paymentStatus: 'refunded' }).where(eq(orders.id, placed.id));
        await page.goto(`${base}/order/${placed.number}?t=${placed.accessToken}`);
        const loaded = await page.getByRole('heading', { name: placed.number }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
        check('the refunded order page loads', loaded, page.url());
        check('a refunded order offers no card retry', (await page.getByRole('button', { name: 'Πληρωμή με κάρτα' }).count()) === 0);
        check("a refunded order shows no 'Εκκρεμεί η πληρωμή με κάρτα' text", (await page.getByText('Εκκρεμεί η πληρωμή με κάρτα').count()) === 0);
      } finally {
        await ctx.close();
      }
    };

    // ── S12 ────────────────────────────────────────────────────────────────────
    const s12 = async () => {
      console.log('S12 paid transaction of another payment source on the same account');
      fake.webhookMode = 'none';
      fake.foreignSourceCode = true;
      const { ctx, page } = await newPage();
      try {
        const ref = await placeCardOrder(page);
        const placed = await orderByRef(ref);
        const before = snapshot();
        const { transactionId } = fake.payNow(ref);
        const status = await fake.sendWebhook(ref, transactionId);
        check('the shop answers the webhook 200', status === 200, status);
        const after = await orderByNumber(placed.number);
        check('the order stays unpaid', after.paymentStatus !== 'paid', after.paymentStatus);
        const rows = await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.orderCode, ref));
        check('no unmatched payment is kept', rows.length === 0, rows.length);
        check('no mail is sent about it', mailsSince(before).length === 0, mailsSince(before).map((mail) => mail.subject));
      } finally {
        fake.foreignSourceCode = false;
        await ctx.close();
      }
    };

    // not a card journey, but this is the browser run with ordering open, which customer accounts need
    const s13 = async () => {
      console.log('S13 a customer registers, activates the account and signs in');
      const address = 'card-account@example.com';
      const password = 'κωδικός-λογαριασμού-1';
      const waitForMail = async (before: Set<string>, subject: string) => {
        for (let i = 0; i < 40; i++) {
          const mail = mailsSince(before).find((m) => m.to === address && m.subject.startsWith(subject));
          if (mail) return mail;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return undefined;
      };
      const registerAs = async (page: Page) => {
        await page.goto(`${base}/register`);
        await page.fill('#af-firstName', 'Νέα');
        await page.fill('#af-lastName', 'Πελάτισσα');
        await page.fill('#af-email', address);
        await page.fill('#af-password', password);
        await page.check('input[name="acceptTerms"]');
        await page.getByRole('button', { name: 'Εγγραφή' }).click();
        await page.getByText('Σας στείλαμε e-mail. Ακολουθήστε τον σύνδεσμο για να ολοκληρωθεί η εγγραφή.').waitFor({ timeout: 20_000 });
      };
      const { ctx, page } = await newPage();
      try {
        const before = snapshot();
        await registerAs(page);
        check('registering answers «Σας στείλαμε e-mail…» and stays signed out', !page.url().includes('/account'), page.url());
        const activation = await waitForMail(before, 'Ενεργοποίηση λογαριασμού');
        check('…and the activation mail arrives', !!activation, mailsSince(before).map((m) => m.subject));

        await page.goto(`${base}/login`);
        await page.fill('#af-email', address);
        await page.fill('#af-password', password);
        await page.getByRole('button', { name: 'Σύνδεση' }).click();
        const resendLink = page.getByRole('link', { name: 'Στείλτε μου ξανά τον σύνδεσμο ενεργοποίησης' });
        await resendLink.waitFor({ timeout: 20_000 });
        check('signing in before activation is refused, with a link to a new activation mail', page.url().includes('/login'), page.url());
        await resendLink.click();
        await page.waitForURL(/\/resend-activation/);
        check('…which opens the resend page with the address filled in', (await page.inputValue('#af-email')) === address);

        const html = activation ? readFileSync(path.join(outbox, activation.file), 'utf8') : '';
        const link = html.match(/href="([^"]*\/activate\?token=[^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? '';
        const { customers } = await import('../src/lib/db/schema');
        const verifiedAt = async () => (await db.select({ at: customers.emailVerifiedAt }).from(customers).where(eq(customers.email, address)))[0]?.at ?? null;
        const button = page.getByRole('button', { name: 'Ενεργοποίηση λογαριασμού' });
        // a mail scanner opening the link first, then the customer opening it: neither visit activates anything
        const firstVisit = await page.goto(link || `${base}/activate`);
        await page.goto(link || `${base}/activate`);
        await button.waitFor({ timeout: 20_000 });
        check('opening the link (twice) shows the activation button and activates nothing yet', link.startsWith(`${base}/activate?token=`) && (await verifiedAt()) === null, link);
        check('…the page sends no Referer and is kept out of search engines', firstVisit?.headers()['referrer-policy'] === 'no-referrer' && (await page.locator('meta[name="robots"]').getAttribute('content'))?.includes('noindex') === true && (await page.locator('meta[name="referrer"]').getAttribute('content')) === 'no-referrer', firstVisit?.headers()['referrer-policy']);
        const legacy = await page.request.get(`${base}/api/account/activate?token=${encodeURIComponent(new URL(link || base).searchParams.get('token') ?? '')}`, { maxRedirects: 0 });
        check('…and the address of the first mails only forwards to the page, spending nothing', legacy.status() === 303 && (legacy.headers().location ?? '').endsWith(`/activate?token=${encodeURIComponent(new URL(link || base).searchParams.get('token') ?? '')}`) && (await verifiedAt()) === null, legacy.status());
        await button.click();
        await page.waitForURL(/\/account/, { timeout: 20_000 });
        check('pressing the button signs the customer in on the account page', page.url().includes('/account?activated=1') && (await page.getByText('Ο λογαριασμός σας ενεργοποιήθηκε').count()) === 1 && (await verifiedAt()) !== null, page.url());
        await page.goto(link || `${base}/activate`);
        check('…and a second visit of the same link says it no longer works, with a way to a new one', (await page.getByText('Ο σύνδεσμος ενεργοποίησης δεν ισχύει').count()) === 1 && (await page.getByRole('link', { name: 'Στείλτε μου νέο σύνδεσμο' }).count()) === 1 && (await button.count()) === 0, page.url());
      } finally {
        await ctx.close();
      }

      const second = await newPage();
      try {
        const before = snapshot();
        await registerAs(second.page);
        check('registering the same address again gets the same answer', true);
        check('…and its owner gets the «someone tried to register» notice', !!(await waitForMail(before, 'Προσπάθεια εγγραφής')), mailsSince(before).map((m) => m.subject));
      } finally {
        await second.ctx.close();
      }
    };

    const run = async (fn: () => Promise<void>, label: string) => {
      // placeOrder allows 8 orders per 10 minutes per IP: each scenario starts with fresh limits
      await db.delete(rateLimits);
      try {
        await fn();
      } catch (err) {
        check(`${label} ran to the end`, false, err instanceof Error ? err.message : String(err));
      }
    };
    await run(s1, 'S1');
    await run(s2, 'S2');
    await run(s3, 'S3');
    await run(s4, 'S4');
    await run(s5, 'S5');
    await run(s6, 'S6');
    await run(s7, 'S7');
    await run(s8, 'S8');
    await run(s9, 'S9');
    await run(s10, 'S10');
    await run(s12, 'S12');
    await run(s13, 'S13');
  } finally {
    await browser?.close().catch(() => undefined);
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await delay(1_000);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    await fake.close();
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} card-flow check(s) FAILED` : '\nAll card-flow checks passed');
    process.exit(failures ? 1 : 0);
  });
