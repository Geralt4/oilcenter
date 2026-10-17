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
import { chromium, type Browser } from 'playwright-core';
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
  const { adminUsers, products, productImages, variants } = await import('../src/lib/db/schema');
  const { hashPassword } = await import('../src/lib/auth/password');
  const { newTotpSecret, totpFor } = await import('../src/lib/auth/totp');

  const email = 'e2e-owner@example.invalid';
  const password = 'E2E-Only-Password-123!';
  const totpSecret = newTotpSecret();
  await db.delete(adminUsers);
  await db.insert(adminUsers).values({ email, name: 'E2E owner', passwordHash: await hashPassword(password), totpSecret, totpConfirmedAt: new Date() });

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

    console.log('Authentication and privileged download');
    await page.goto(`${base}/admin/login`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="totp"]').fill(totpFor(totpSecret, email).generate());
    await page.getByRole('button', { name: 'Σύνδεση' }).click();
    await page.waitForURL(`${base}/admin`, { timeout: 20_000 });
    check('password + TOTP signs the administrator in', page.url() === `${base}/admin`);

    await page.goto(`${base}/admin/settings`);
    const identity = page.locator('#identity');
    await identity.locator('input[name="currentPassword"]').fill(password);
    await identity.locator('input[name="totp"]').fill(totpFor(totpSecret, email).generate({ timestamp: Date.now() + 30_000 }));
    await identity.getByRole('button', { name: 'Επιβεβαίωση' }).click();
    await identity.getByText('Η ταυτότητα είναι επιβεβαιωμένη').waitFor({ timeout: 20_000 });
    check('password + a fresh TOTP code confirms the identity', await identity.getByText('Η ταυτότητα είναι επιβεβαιωμένη').isVisible());

    // A direct download navigation is awkward in headless browsers; the context request below
    // shares the browser's HttpOnly cookies, so it exercises the same confirmed session.
    const snapshot = await context.request.get(`${base}/admin/backup`);
    const bytes = Buffer.from(await snapshot.body());
    check('the confirmed administrator receives a gzipped database snapshot', snapshot.ok() && bytes.length > 20 && bytes[0] === 0x1f && bytes[1] === 0x8b, { status: snapshot.status(), bytes: bytes.length });

    console.log('CSV import');
    await page.goto(`${base}/admin/prices`);
    const csvInput = page.locator('input[type="file"][accept*="csv"]');
    const nextPriceCents = Math.max(100, variant.priceCents + 123);
    const csv = `sku;price\n${variant.sku};${(nextPriceCents / 100).toFixed(2).replace('.', ',')}\nNO-SUCH-SKU-E2E;9,99\n`;
    await csvInput.setInputFiles({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.locator('input[type="hidden"][name="file"]').waitFor({ state: 'attached', timeout: 20_000 });
    await page.getByRole('button', { name: 'Εισαγωγή CSV' }).click();
    await page.getByText(/Άγνωστοι κωδικοί: NO-SUCH-SKU-E2E/).waitFor({ timeout: 20_000 });
    const [afterImport] = await db.select({ priceCents: variants.priceCents }).from(variants).where(eq(variants.sku, variant.sku));
    check('the CSV changes the known price and reports the unknown SKU', afterImport?.priceCents === nextPriceCents);
    await page.waitForFunction(() => document.querySelectorAll('input[type="hidden"][name="file"]').length === 0, undefined, { timeout: 10_000 });
    check('the completed import clears the consumed upload token', (await page.locator('input[type="hidden"][name="file"]').count()) === 0);

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

    await context.close();
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
