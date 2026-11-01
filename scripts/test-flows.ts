/*
 * Full-flow browser test. Runs against a throwaway copy of the local database and a locally started
 * production build. It signs in with password + TOTP, confirms the identity for the protected database
 * download, imports a price CSV (including an unknown SKU), and saves a product with a new photo and SDS.
 *
 *   npm run build
 *   npm run test:flows
 *
 * No production account, database, uploads or backups are touched. Playwright's browser binary is
 * detected from the standard cache; set CHROMIUM_PATH to override it.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import sharp from 'sharp';
import { cloneDatabase } from './test-db';

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

async function main() {
  const repo = process.cwd();
  const dir = await cloneDatabase('oc-flows-');
  const databaseUrl = process.env.DATABASE_URL!;
  const dataDir = path.join(dir, 'data');
  const port = 3199;
  const base = `http://127.0.0.1:${port}`;
  const authSecret = 'e2e-only-secret-not-used-in-production-0123456789';
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_SECRET = authSecret;
  process.env.COMMERCE_ENABLED = 'false';
  process.env.SITE_URL = base;

  const { eq, asc } = await import('drizzle-orm');
  const { db, client } = await import('../src/lib/db');
  const { adminUsers, pendingUploads, products, productImages, variants } = await import('../src/lib/db/schema');
  const { hashPassword } = await import('../src/lib/auth/password');
  const { newTotpSecret, totpFor } = await import('../src/lib/auth/totp');

  const email = 'e2e-owner@example.invalid';
  const unenrolledEmail = 'e2e-unenrolled@example.invalid';
  const password = 'E2E-Only-Password-123!';
  const totpSecret = newTotpSecret();
  await db.delete(adminUsers);
  await db.insert(adminUsers).values([
    { email, name: 'E2E owner', passwordHash: await hashPassword(password), totpSecret, totpConfirmedAt: new Date() },
    // a second account without an authenticator: it must not be able to obtain the privileged confirmation
    { email: unenrolledEmail, name: 'E2E without 2FA', passwordHash: await hashPassword(password) },
  ]);

  const [product] = await db.select({ id: products.id }).from(products).orderBy(asc(products.id)).limit(1);
  if (!product) throw new Error('The throwaway database has no products to edit.');
  const [variant] = await db.select({ sku: variants.sku, priceCents: variants.priceCents }).from(variants).where(eq(variants.productId, product.id)).limit(1);
  if (!variant) throw new Error('The throwaway database product has no variants.');

  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const nextBin = path.join(repo, 'node_modules', 'next', 'dist', 'bin', 'next');
    server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: repo,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATA_DIR: dataDir,
        AUTH_SECRET: authSecret,
        NODE_ENV: 'production',
        COMMERCE_ENABLED: 'false',
        SITE_URL: base,
        SITE_PASSWORD: '',
        SMTP_HOST: '',
        B2_KEY_ID: '',
        B2_APP_KEY: '',
        B2_BUCKET: '',
        B2_ENDPOINT: '',
        BACKUP_ENCRYPTION_KEY: '',
      },
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
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    /**
     * A code for a step that has not been spent yet. Every accepted code burns its 30-second step, so
     * a second code has to wait for the next step rather than reuse a step the account already used.
     */
    let spentStep = 0;
    const freshCode = async () => {
      const current = Math.floor(Date.now() / 30_000);
      if (current <= spentStep) while (Math.floor(Date.now() / 30_000) <= spentStep) await delay(200);
      spentStep = Math.floor(Date.now() / 30_000);
      return totpFor(totpSecret, email).generate();
    };
    /** One login attempt in its own page: returns the visible refusal, or the signed-in URL. */
    const attemptLogin = async (own: BrowserContext, code?: string, who = email) => {
      const signIn = await own.newPage();
      await signIn.goto(`${base}/admin/login`);
      await signIn.locator('input[name="email"]').fill(who);
      await signIn.locator('input[name="password"]').fill(code === '@wrong-password' ? 'not-the-password' : password);
      if (code && code !== '@wrong-password') await signIn.locator('input[name="totp"]').fill(code);
      await signIn.getByRole('button', { name: 'Σύνδεση' }).click();
      const alert = signIn.locator('form').getByRole('alert');
      const refused = await alert
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(async () => ({ text: (await alert.first().textContent()) ?? '', html: (await alert.first().innerHTML()).slice(0, 120) }))
        .catch(() => null);
      const url = refused ? null : signIn.url();
      await signIn.close();
      return { refused: refused?.text ?? null, alertHtml: refused?.html ?? null, url };
    };

    console.log('Authentication is refused without both factors');
    const anonymousPanel = await context.request.get(`${base}/admin`, { maxRedirects: 0 });
    const anonymousBackup = await context.request.get(`${base}/admin/backup`, { maxRedirects: 0 });
    check('an anonymous visitor cannot reach the admin panel', anonymousPanel.status() === 307 && anonymousPanel.headers().location?.endsWith('/admin/login'));
    check('an anonymous visitor cannot download the database', anonymousBackup.status() === 307 && anonymousBackup.headers().location?.endsWith('/admin/login'));

    const wrongPassword = await attemptLogin(context, '@wrong-password');
    check('a wrong password is refused', Boolean(wrongPassword.refused?.includes('Λάθος e-mail ή κωδικός')), wrongPassword.alertHtml);
    const noCode = await attemptLogin(context);
    check('the password alone is refused while 2FA is enrolled', Boolean(noCode.refused?.includes('6ψήφιο')), noCode.alertHtml);

    // Two throwaway sessions for one code: the first spends the step, the second must be turned away.
    const spentCode = await freshCode();
    const firstUse = await attemptLogin(await browser.newContext(), spentCode);
    check('password + code signs in', firstUse.url === `${base}/admin`, firstUse.alertHtml);
    const replayed = await attemptLogin(await browser.newContext(), spentCode);
    check('the same authenticator code cannot be used twice', Boolean(replayed.refused?.includes('Λάθος ή ήδη χρησιμοποιημένος')), replayed.alertHtml);

    console.log('Authentication and privileged download');
    await page.goto(`${base}/admin/login`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    const loginCode = await freshCode();
    await page.locator('input[name="totp"]').fill(loginCode);
    await page.getByRole('button', { name: 'Σύνδεση' }).click();
    await page.waitForURL(`${base}/admin`, { timeout: 20_000 });
    check('a later sign-in with a fresh code also works', page.url() === `${base}/admin`);

    await page.goto(`${base}/admin/settings`);
    const earlyDownload = await context.request.get(`${base}/admin/backup`, { maxRedirects: 0 });
    check('a logged-in session without confirmation cannot download the database', earlyDownload.status() === 307 && earlyDownload.headers().location?.includes('sudo=1'));
    await page.goto(`${base}/admin/settings`);
    const identity = page.locator('#identity');
    // the password is checked first, so a wrong password must be refused even with a spent code in the box
    await identity.locator('input[name="currentPassword"]').fill('not-the-password');
    await identity.locator('input[name="totp"]').fill(loginCode);
    await identity.getByRole('button', { name: 'Επιβεβαίωση' }).click();
    const identityAlert = identity.getByRole('alert');
    await identityAlert.waitFor({ timeout: 10_000 });
    check('a wrong password cannot confirm the identity', ((await identityAlert.textContent()) ?? '').includes('Λάθος κωδικός'));

    await identity.locator('input[name="currentPassword"]').fill(password);
    await identity.locator('input[name="totp"]').fill(await freshCode());
    await identity.getByRole('button', { name: 'Επιβεβαίωση' }).click();
    await identity.getByText('Η ταυτότητα είναι επιβεβαιωμένη').waitFor({ timeout: 20_000 });
    check('password + a fresh code confirms the identity', await identity.getByText('Η ταυτότητα είναι επιβεβαιωμένη').isVisible());

    // A direct download navigation is awkward in headless browsers; the context request below
    // shares the browser's HttpOnly cookies, so it exercises the same confirmed session.
    const snapshot = await context.request.get(`${base}/admin/backup`);
    const bytes = Buffer.from(await snapshot.body());
    check('the confirmed administrator receives a gzipped database snapshot', snapshot.ok() && bytes.length > 20 && bytes[0] === 0x1f && bytes[1] === 0x8b, { status: snapshot.status(), bytes: bytes.length });
    const downloadStatuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) downloadStatuses.push((await context.request.get(`${base}/admin/backup`)).status());
    check('repeated downloads are throttled', downloadStatuses.slice(0, 4).every((status) => status === 200) && downloadStatuses[4] === 429, downloadStatuses);

    console.log('CSV import');
    await page.goto(`${base}/admin/prices`);
    const csvInput = page.locator('input[type="file"][accept*="csv"]');
    const stagedCsv = page.locator('input[type="hidden"][name="file"]');
    const asCsv = (body: string) => ({ mimeType: 'text/csv', buffer: Buffer.from(body, 'utf8') });
    const amount = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
    const nextPriceCents = Math.max(100, variant.priceCents + 123);
    const csv = `sku;price\n${variant.sku};${amount(nextPriceCents)}\nNO-SUCH-SKU-E2E;9,99\n`;
    // the action writes through the same database file the test reads, so poll instead of racing the UI text
    const priceStoredAs = async (cents: number) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const [row] = await db.select({ priceCents: variants.priceCents }).from(variants).where(eq(variants.sku, variant.sku));
        if (row?.priceCents === cents) return true;
        await delay(250);
      }
      return false;
    };

    await csvInput.setInputFiles({ name: 'prices.csv', ...asCsv(csv) });
    await stagedCsv.waitFor({ state: 'attached', timeout: 20_000 });
    check('the CSV upload produces a staged token', (await stagedCsv.count()) === 1);

    // A refused upload must be visible AND must not leave the field holding an error or a blocked validation.
    await page.route('**/api/admin/upload*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'busy' }) }));
    await csvInput.setInputFiles({ name: 'replacement.csv', ...asCsv('sku;price\nBROKEN-E2E;1,00\n') });
    // Next's route announcer is a second role=alert on every page, so the message itself is addressed by tag
    await page.locator('p[role="alert"]').waitFor({ timeout: 20_000 });
    await page.unroute('**/api/admin/upload*');
    check('a refused upload is reported and stages nothing new', (await stagedCsv.count()) === 1 && !(await csvInput.evaluate((el: HTMLInputElement) => el.checkValidity())));
    await page.getByRole('button', { name: 'Καθαρισμός' }).click();
    check('clearing the field removes its staged token', (await stagedCsv.count()) === 0);
    const csvForm = csvInput.locator('xpath=ancestor::form');
    await csvForm.getByRole('alert').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
    check('…and its error and blocked validation with it', (await csvForm.getByRole('alert').count()) === 0 && (await csvInput.evaluate((el: HTMLInputElement) => el.checkValidity())));

    await csvInput.setInputFiles({ name: 'prices.csv', ...asCsv(csv) });
    await stagedCsv.waitFor({ state: 'attached', timeout: 20_000 });
    await page.getByRole('button', { name: 'Εισαγωγή CSV' }).click();
    await page.getByText(/Άγνωστοι κωδικοί: NO-SUCH-SKU-E2E/).waitFor({ timeout: 20_000 });
    check('the CSV changes the known price and reports the unknown SKU', await priceStoredAs(nextPriceCents));
    await page.waitForFunction(() => document.querySelectorAll('input[type="hidden"][name="file"]').length === 0, undefined, { timeout: 10_000 });
    check('the completed import clears the consumed upload token', (await stagedCsv.count()) === 0);

    const secondPriceCents = nextPriceCents + 11;
    await csvInput.setInputFiles({ name: 'second.csv', ...asCsv(`sku;price\n${variant.sku};${amount(secondPriceCents)}\n`) });
    await stagedCsv.waitFor({ state: 'attached', timeout: 20_000 });
    await page.getByRole('button', { name: 'Εισαγωγή CSV' }).click();
    check('a second import works immediately after the first', await priceStoredAs(secondPriceCents));
    await page.waitForFunction(() => document.querySelectorAll('input[type="hidden"][name="file"]').length === 0, undefined, { timeout: 10_000 });

    console.log('Photo and SDS upload');
    await page.goto(`${base}/admin/products/${product.id}`);
    const photo = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    await page.locator('input[type="file"][accept*="image"]').setInputFiles({ name: 'e2e-photo.png', mimeType: 'image/png', buffer: photo });
    await page.locator('input[type="hidden"][name="images"]').waitFor({ state: 'attached', timeout: 20_000 });
    check('the photo upload produces a staged token', (await page.locator('input[type="hidden"][name="images"]').count()) === 1);
    const sds = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
    await page.locator('input[type="file"][accept*="pdf"]').setInputFiles({ name: 'e2e-sds.pdf', mimeType: 'application/pdf', buffer: sds });
    await page.locator('input[type="hidden"][name="sds"]').waitFor({ state: 'attached', timeout: 20_000 });
    check('the SDS upload produces a staged token', (await page.locator('input[type="hidden"][name="sds"]').count()) === 1);
    await page.getByRole('button', { name: 'Αποθήκευση προϊόντος' }).click();
    await page.getByText('Το προϊόν αποθηκεύτηκε.').waitFor({ timeout: 30_000 });
    const images = await db.select({ url: productImages.url }).from(productImages).where(eq(productImages.productId, product.id));
    const [savedProduct] = await db.select({ hazard: products.hazard }).from(products).where(eq(products.id, product.id));
    const uploadedPhoto = images.map((image) => image.url).find((url) => url.startsWith('/media/products/'));
    const sdsUrl = savedProduct?.hazard?.sdsUrl ?? '';
    const fileFor = (url: string) => path.join(dataDir, 'uploads', url.slice('/media/'.length));
    check('the saved product keeps the uploaded photo on disk', Boolean(uploadedPhoto) && existsSync(fileFor(uploadedPhoto!)), uploadedPhoto);
    check('the saved product keeps the uploaded SDS on disk', sdsUrl.startsWith('/media/sds/') && existsSync(fileFor(sdsUrl)), sdsUrl);

    // Both imported CSVs must be gone from the staging table. The one the owner cleared before importing
    // may still be there — the hourly sweeper is what removes an upload nobody claimed — but it must
    // never sit there claimed, which is what a half-finished import would look like. (The photo and SDS
    // rows stay claimed on purpose: they are the claim records of a save that succeeded.)
    const staged = await db.select({ kind: pendingUploads.kind, claimedAt: pendingUploads.claimedAt }).from(pendingUploads);
    check('no CSV upload is left claimed', staged.filter((row) => row.kind.endsWith('-csv')).every((row) => row.claimedAt === null), staged.map((row) => `${row.kind}:${row.claimedAt ? 'claimed' : 'open'}`));

    console.log('A failed optional upload can be cleared');
    await page.goto(`${base}/admin/products/${product.id}`);
    const sdsPicker = page.locator('input[type="file"][accept*="pdf"]');
    const sdsField = sdsPicker.locator('xpath=..');
    await sdsPicker.setInputFiles({ name: 'not-a-pdf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is plain text, not a PDF', 'utf8') });
    await sdsField.locator('p[role="alert"]').waitFor({ timeout: 20_000 });
    check('a refused SDS upload is reported and blocks the form', !(await sdsPicker.evaluate((el: HTMLInputElement) => el.checkValidity())));
    const clearFailed = sdsField.locator('button', { hasText: 'Καθαρισμός' });
    check('…and there is a way to clear it, although no upload succeeded', (await clearFailed.count()) === 1, (await clearFailed.count()) === 1 ? undefined : (await sdsField.innerHTML()).slice(0, 900));
    if ((await clearFailed.count()) === 1) {
      await clearFailed.click();
      check('clearing removes the message and the blocked validation', (await sdsField.locator('p[role="alert"]').count()) === 0 && (await sdsPicker.evaluate((el: HTMLInputElement) => el.checkValidity())));
    }

    console.log('Search box');
    await page.goto(`${base}/`);
    const searchBox = page.locator('input[role="combobox"]:visible').first();
    await searchBox.fill('castrol');
    await page.locator('[role="option"]').first().waitFor({ timeout: 20_000 });
    await searchBox.press('ArrowDown');
    await searchBox.fill('');
    await searchBox.press('Enter');
    await delay(1500);
    check('after clearing the box, Enter does not open the suggestion that was selected', !page.url().includes('/product/'), page.url());

    console.log('Favourites');
    const favouriteIds = (await db.selectDistinct({ id: products.id }).from(products).innerJoin(variants, eq(variants.productId, products.id)).where(eq(products.isActive, true)).orderBy(asc(products.id)).limit(61)).map((row) => row.id);
    check('there are 61 products to favourite', favouriteIds.length === 61, favouriteIds.length);
    await page.goto(`${base}/`);
    await page.evaluate((ids) => localStorage.setItem('oilcenter-wishlist', JSON.stringify({ state: { ids }, version: 1 })), favouriteIds);
    await page.goto(`${base}/wishlist`);
    await page.locator('main article').first().waitFor({ timeout: 20_000 });
    await delay(1500);
    check('all 61 favourites are listed, not only the first 60', (await page.locator('main article').count()) === 61, await page.locator('main article').count());
    await page.evaluate(() => localStorage.removeItem('oilcenter-wishlist'));

    console.log('Statistics page and sign-ups export');
    {
      const { statCounters, launchSignups } = await import('../src/lib/db/schema');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
      await db
        .insert(statCounters)
        .values([
          { day: today, kind: 'pageview', key: '/', count: 3 },
          { day: today, kind: 'search', key: 'άλλη αναζήτηση', count: 2 },
        ])
        .onConflictDoNothing();
      await db.insert(launchSignups).values({ email: 'flows-signup@example.com' }).onConflictDoNothing();
      const statsPage = await page.goto(`${base}/admin/stats`);
      check('the statistics page renders for the admin', statsPage?.status() === 200 && (await page.getByRole('heading', { name: 'Στατιστικά' }).count()) > 0, statsPage?.status());
      check('…and lists the shared key for searches over the daily cap', (await page.locator('main').innerText()).includes('άλλη αναζήτηση'));
      const csv = await page.request.get(`${base}/admin/stats/signups`);
      const csvText = await csv.text();
      check('the sign-ups CSV export still downloads', csv.status() === 200 && (csv.headers()['content-type'] ?? '').startsWith('text/csv') && csvText.includes('email;date') && csvText.includes('flows-signup@example.com'), [csv.status(), csvText.slice(0, 80)]);
    }

    console.log('Resending a payment mail that was given up');
    {
      const { orders, mailOutbox } = await import('../src/lib/db/schema');
      const [mailOrder] = await db
        .insert(orders)
        .values({ number: 'OC-FLOWS-MAIL', accessToken: 'flows-mail-token', paymentMethod: 'card', shippingMethod: 'courier', email: 'buyer@example.com', phone: '6900000000', firstName: 'Τεστ', lastName: 'Αγοραστής', subtotalCents: 1999, totalCents: 1999, status: 'confirmed', paymentStatus: 'paid', paidAt: new Date() })
        .returning();
      const [given] = await db.insert(mailOutbox).values({ kind: 'order_confirmation', orderId: mailOrder.id, attempts: 27, givenUpAt: new Date() }).returning();
      await page.goto(`${base}/admin/orders?mail=failed`);
      check('the «not sent» filter lists the order with a given-up mail', (await page.locator('main a', { hasText: 'OC-FLOWS-MAIL' }).count()) === 1);
      await page.goto(`${base}/admin/orders/${mailOrder.id}`);
      const resendButton = page.getByRole('button', { name: 'Επαναποστολή e-mail' });
      check('the order page offers «Επαναποστολή e-mail»', (await resendButton.count()) === 1);
      await resendButton.click();
      await page.waitForLoadState('networkidle');
      await delay(1000);
      const [after] = await db.select().from(mailOutbox).where(eq(mailOutbox.id, given.id));
      check('…pressing it sends the mail and the button goes away', after.sentAt !== null && after.givenUpAt === null && (await page.getByRole('button', { name: 'Επαναποστολή e-mail' }).count()) === 0, [after.sentAt, after.givenUpAt]);
      check('…and the history shows the resend', (await page.locator('main').innerText()).includes('Επαναποστολή e-mail από διαχειριστή: στάλθηκαν 1 από 1.'));
    }

    console.log('Edits typed while a save is in flight');
    page.on('dialog', (dialog) => void dialog.accept());
    // hold the server action back so there is time to type while it is running
    const slowActions = async (path: string, ms: number) =>
      page.route(`**${path}`, async (route) => {
        if (route.request().method() === 'POST' && route.request().headers()['next-action']) await delay(ms);
        await route.continue();
      });
    const money = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

    await page.goto(`${base}/admin/prices`);
    const priceBox = page.locator('[data-price-input]').first();
    const priceBefore = Math.round(Number((await priceBox.inputValue()).replace(',', '.')) * 100);
    await slowActions('/admin/prices', 2500);
    await priceBox.fill(money(priceBefore + 10));
    await page.getByRole('button', { name: /^Αποθήκευση 1 αλλαγής/ }).click();
    await delay(400);
    await priceBox.fill(money(priceBefore + 20));
    await page.getByText(/Αποθηκεύτηκε 1 αλλαγή/).waitFor({ timeout: 20_000 });
    await page.unroute('**/admin/prices');
    check('a price typed while the save was running is still in the box…', (await priceBox.inputValue()) === money(priceBefore + 20), await priceBox.inputValue());
    check('…and still counts as an unsaved change', (await page.getByRole('button', { name: /^Αποθήκευση 1 αλλαγής/ }).count()) === 1);
    if ((await page.getByRole('button', { name: /^Αποθήκευση 1 αλλαγής/ }).count()) === 1) {
      await page.getByRole('button', { name: /^Αποθήκευση 1 αλλαγής/ }).click();
      await page.getByText(/Αποθηκεύτηκε 1 αλλαγή/).first().waitFor({ timeout: 20_000 });
    }

    await page.goto(`${base}/admin/skroutz`);
    const mpnBox = page.locator('[data-code-input="mpn"]').first();
    const codeRowId = Number(await mpnBox.getAttribute('data-row-id'));
    const saveCodes = page.getByRole('button', { name: /^Αποθήκευση \(1\)/ });
    await slowActions('/admin/skroutz', 2500);
    await mpnBox.fill('E2E-ONE');
    await saveCodes.click();
    await delay(400);
    await mpnBox.fill('E2E-TWO');
    await page.getByText(/Αποθηκεύτηκε 1 συσκευασία/).waitFor({ timeout: 20_000 });
    await page.unroute('**/admin/skroutz');
    check('a code typed while the save was running is still in the box…', (await mpnBox.inputValue()) === 'E2E-TWO', await mpnBox.inputValue());
    check('…and still counts as an unsaved change', (await page.getByRole('button', { name: /^Αποθήκευση \(1\)/ }).count()) === 1);
    // whatever the box holds, now save the second code for real
    await mpnBox.fill('E2E-TWO');
    await page.getByRole('button', { name: /^Αποθήκευση \(1\)/ }).click();
    const savedMpn = async () => (await db.select({ mpn: variants.mpn, sku: variants.sku }).from(variants).where(eq(variants.id, codeRowId)))[0];
    for (let attempt = 0; attempt < 40 && (await savedMpn()).mpn !== 'E2E-TWO'; attempt++) await delay(250);
    check('the second code is saved', (await savedMpn()).mpn === 'E2E-TWO', await savedMpn());

    console.log('A code imported after a manual save');
    const codeSku = (await savedMpn()).sku;
    await page.getByText('Έχετε λίστα από προμηθευτή; Εισαγωγή από CSV').click();
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles({ name: 'codes.csv', mimeType: 'text/csv', buffer: Buffer.from(`sku;mpn\n${codeSku};E2E-CSV\n`, 'utf8') });
    await page.locator('input[type="hidden"][name="file"]').waitFor({ state: 'attached', timeout: 20_000 });
    await page.getByRole('button', { name: 'Εισαγωγή CSV' }).click();
    for (let attempt = 0; attempt < 40 && (await savedMpn()).mpn !== 'E2E-CSV'; attempt++) await delay(250);
    check('the CSV import changed the code in the database', (await savedMpn()).mpn === 'E2E-CSV', await savedMpn());
    let shownAfterCsv = await mpnBox.inputValue();
    for (let attempt = 0; attempt < 20 && shownAfterCsv !== 'E2E-CSV'; attempt++) {
      await delay(250);
      shownAfterCsv = await mpnBox.inputValue();
    }
    check('…and the editor shows the imported code, not the one saved by hand earlier', shownAfterCsv === 'E2E-CSV', shownAfterCsv);

    console.log('Sales and targeted coupons');
    // The owner's path end to end: the form posts the ticked brand and the picked product, the shop shows the sale,
    // and the coupon list says what the code is limited to. (The unit tests build their FormData by hand.)
    const { brands, coupons, sales } = await import('../src/lib/db/schema');
    const [target] = await db.select({ id: products.id, slug: products.slug, name: products.name, brandId: products.brandId }).from(products).where(eq(products.id, product.id));
    await db.update(variants).set({ priceVerified: true, compareAtCents: null, isActive: true }).where(eq(variants.productId, product.id));
    await db.update(products).set({ isActive: true }).where(eq(products.id, product.id));
    const [size] = await db.select({ priceCents: variants.priceCents }).from(variants).where(eq(variants.productId, product.id)).orderBy(asc(variants.sort), asc(variants.volumeMl)).limit(1);
    const [brand] = target.brandId ? await db.select({ id: brands.id }).from(brands).where(eq(brands.id, target.brandId)) : [];
    check('the test product has a brand to put on sale', !!brand);

    await page.goto(`${base}/admin/sales`);
    const newSale = page.locator('section', { has: page.getByRole('heading', { name: 'Νέα προσφορά' }) });
    await newSale.locator('input[name="name"]').fill('E2E προσφορά');
    await newSale.locator('input[name="value"]').fill('20');
    await newSale.getByRole('button', { name: 'Δημιουργία' }).click();
    await newSale.getByText('Επιλέξτε τουλάχιστον ένα προϊόν, μάρκα ή κατηγορία.').waitFor({ timeout: 20_000 });
    check('a sale with nothing ticked is refused in the form', (await db.select().from(sales)).length === 0);
    await newSale.locator(`input[name="brandIds"][value="${brand.id}"]`).check();
    await newSale.getByRole('button', { name: 'Δημιουργία' }).click();
    await newSale.getByText('Αποθηκεύτηκε.').waitFor({ timeout: 20_000 });
    const [savedSale] = await db.select().from(sales);
    check('the ticked brand is what the form saved', !!savedSale && savedSale.brandIds.length === 1 && savedSale.brandIds[0] === brand.id && savedSale.type === 'percent' && savedSale.value === 20, savedSale);

    await page.goto(`${base}/product/${target.slug}`);
    // scoped to the product's own price block, so a related-product card cannot satisfy these checks
    const bigPrice = page.locator('p.text-4xl').first();
    await bigPrice.waitFor({ timeout: 20_000 });
    const priceBlock = bigPrice.locator('xpath=..');
    const regular = priceBlock.locator('.line-through').first();
    await regular.waitFor({ timeout: 20_000 });
    check('the shop strikes through the regular price', ((await regular.textContent()) ?? '').includes(amount(size.priceCents)));
    check('…and shows the sale price', ((await bigPrice.textContent()) ?? '').includes(amount(Math.round(size.priceCents * 0.8))));

    await page.goto(`${base}/admin/coupons`);
    const newCoupon = page.locator('section', { has: page.getByRole('heading', { name: 'Νέο κουπόνι' }) });
    await newCoupon.locator('input[name="code"]').fill('E2EPICK');
    await newCoupon.locator('input[name="value"]').fill('10');
    await newCoupon.getByPlaceholder('Αναζήτηση προϊόντος για προσθήκη…').fill(target.name.slice(0, 8));
    await newCoupon.getByRole('button', { name: new RegExp(target.name.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first().click();
    check('the picked product becomes a chip', (await newCoupon.locator('input[type="hidden"][name="productIds"]').count()) === 1);
    await newCoupon.getByRole('button', { name: 'Δημιουργία' }).click();
    await newCoupon.getByText('Αποθηκεύτηκε.').waitFor({ timeout: 20_000 });
    const [savedCoupon] = await db.select().from(coupons).where(eq(coupons.code, 'E2EPICK'));
    check('the coupon is limited to the picked product', !!savedCoupon && savedCoupon.productIds.length === 1 && savedCoupon.productIds[0] === target.id && savedCoupon.excludeSaleItems === true, savedCoupon);
    await page.reload();
    check('the coupon list names what the coupon covers', await page.getByText('1 προϊόν').first().isVisible());

    await db.delete(sales);
    await db.delete(coupons).where(eq(coupons.code, 'E2EPICK'));

    console.log('Admin sidebar at a short window');
    const previousViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(`${base}/admin`);
    check('the dashboard checklist lists the payment-mail line (no mail has been given up)', (await page.getByText('E-mail πληρωμών που δεν στάλθηκαν').count()) > 0 && (await page.getByText('Κανένα e-mail πληρωμής δεν έμεινε απέσταλτο.').count()) > 0);
    const menu = page.locator('aside nav[aria-label="Διαχείριση"]');
    const lastLink = menu.getByRole('link').last();
    const firstLink = menu.getByRole('link', { name: 'Επισκόπηση', exact: true });
    const signOutButton = page.getByRole('button', { name: 'Αποσύνδεση' });
    const scrollMenu = (position: 'top' | 'bottom') => menu.evaluate((el, where) => { el.scrollTop = where === 'top' ? 0 : el.scrollHeight; }, position);
    const inWindow = (box: { x: number; y: number; width: number; height: number } | null) => !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 500;

    await scrollMenu('bottom');
    await lastLink.scrollIntoViewIfNeeded();
    const lastBox = await lastLink.boundingBox();
    check('the last menu link («Ρυθμίσεις») can be scrolled fully into view', ((await lastLink.textContent()) ?? '').includes('Ρυθμίσεις') && inWindow(lastBox), { text: await lastLink.textContent(), lastBox });
    const signOutAtBottom = await signOutButton.boundingBox();
    check('«Αποσύνδεση» stays visible inside the window while the menu is scrolled to the bottom', inWindow(signOutAtBottom), signOutAtBottom);

    await scrollMenu('top');
    await firstLink.scrollIntoViewIfNeeded();
    const firstBox = await firstLink.boundingBox();
    check('the first item («Επισκόπηση») can be scrolled back into view', inWindow(firstBox), firstBox);
    const signOutAtTop = await signOutButton.boundingBox();
    check('«Αποσύνδεση» stays visible without scrolling the menu', inWindow(signOutAtTop), signOutAtTop);

    await page.setViewportSize(previousViewport);

    console.log('Sign out');
    await page.goto(`${base}/admin`);
    await page.getByRole('button', { name: 'Αποσύνδεση' }).click();
    await page.waitForURL(`${base}/admin/login`, { timeout: 20_000 });
    const afterLogout = await context.request.get(`${base}/admin`, { maxRedirects: 0 });
    check('signing out closes the session', page.url() === `${base}/admin/login` && afterLogout.status() === 307);

    await context.close();

    console.log('An administrator without an authenticator');
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`${base}/admin/login`);
    await secondPage.locator('input[name="email"]').fill(unenrolledEmail);
    await secondPage.locator('input[name="password"]').fill(password);
    await secondPage.getByRole('button', { name: 'Σύνδεση' }).click();
    await secondPage.waitForURL(`${base}/admin`, { timeout: 20_000 });
    check('an account without 2FA still signs in with its password', secondPage.url() === `${base}/admin`);
    await secondPage.goto(`${base}/admin/settings`);
    const secondIdentity = secondPage.locator('#identity');
    check('its confirmation form asks for no authenticator code', (await secondIdentity.locator('input[name="totp"]').count()) === 0);
    await secondIdentity.locator('input[name="currentPassword"]').fill(password);
    await secondIdentity.getByRole('button', { name: 'Επιβεβαίωση' }).click();
    const secondAlert = secondIdentity.getByRole('alert');
    await secondAlert.waitFor({ timeout: 10_000 });
    check('it cannot obtain the privileged confirmation', ((await secondAlert.textContent()) ?? '').includes('2FA'));
    const secondDownload = await secondContext.request.get(`${base}/admin/backup`, { maxRedirects: 0 });
    check('…so it cannot download the database either', secondDownload.status() === 307 && Boolean(secondDownload.headers().location?.includes('sudo=1')));
    await secondContext.close();
  } finally {
    await browser?.close().catch(() => undefined);
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await delay(1_000);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
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
    console.log(failures ? `\n${failures} flow check(s) FAILED` : '\nAll flow checks passed');
    process.exit(failures ? 1 : 0);
  });
