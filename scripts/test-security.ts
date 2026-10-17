/*
 * Security-boundary regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:security
 * Covers the deployment-level commerce switch (COMMERCE_ENABLED=false): no order creation, no accounts,
 * no payment sessions — regardless of the owner's settings, a logged-in admin, or a real order in the database.
 */
import { rmSync } from 'node:fs';
import { cloneDatabase } from './test-db';

let dir = '';
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main() {
  // Set BEFORE importing: the flag is read per call, but every module here should see the restricted deployment.
  process.env.COMMERCE_ENABLED = 'false';
  dir = await cloneDatabase('oc-sec-');
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  const { orders } = await import('../src/lib/db/schema');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
  const { commerceEnabled } = await import('../src/lib/commerce-flag');
  const { accountsAvailable } = await import('../src/lib/catalogue-mode');
  const { createOrder } = await import('../src/lib/orders');
  const { startCardPayment } = await import('../src/lib/payments');

  const settings = structuredClone(DEFAULT_SETTINGS);
  // As if the owner had already opened the shop, then locked the deployment down.
  settings.storefront.ordersEnabled = true;

  console.log('Commerce switch (COMMERCE_ENABLED=false)');
  check('flag reads as disabled', commerceEnabled() === false);

  const base = {
    email: 'buyer@example.com', phone: '6900000000', firstName: 'Τεστ', lastName: 'Αγοραστής', shippingMethod: 'courier' as const, paymentMethod: 'cod' as const,
    street: 'Οδός 1', city: 'Θεσαλονίκη', postalCode: '54624', docType: 'receipt' as const, acceptTerms: true as const,
  };
  const before = (await db.select().from(orders)).length;
  const refused = await createOrder({ ...base, lines: [{ variantId: 1, quantity: 1 }] }, settings, { customerId: null, cardProviderConfigured: false });
  check('createOrder refuses even with ordering enabled in settings', !refused.ok && refused.reason === 'commerce_disabled', refused);
  check('…and no order row was written', (await db.select().from(orders)).length === before);

  let cardThrew = false;
  try {
    await startCardPayment({ id: 1, number: 'OC-00001', accessToken: 'x', totalCents: 1000, email: 'a@b.gr', firstName: 'Α', lastName: 'Β', phone: '69' });
  } catch {
    cardThrew = true;
  }
  check('startCardPayment refuses without touching the gateway', cardThrew);

  // A real (non-test) order exists afterwards: the history escape hatch must STILL stay shut.
  await db.insert(orders).values({
    number: 'OC-99001', email: 'old@buyer.gr', phone: '6900000000', firstName: 'Παλιός', lastName: 'Πελάτης',
    street: 'Οδός 1', city: 'Θεσαλονίκη', postalCode: '54624', docType: 'receipt',
    shippingMethod: 'courier', paymentMethod: 'cod', paymentStatus: 'paid', status: 'completed',
    subtotalCents: 1000, shippingCents: 390, codFeeCents: 0, discountCents: 0, totalCents: 1390, totalWeightGrams: 1000,
    accessToken: 'tok', isTest: false,
  });
  check('a real order exists in the database', (await db.select().from(orders).where(eq(orders.isTest, false))).length === 1);
  check('accountsAvailable stays false with a real order present (no history escape)', (await accountsAvailable()) === false);

  console.log('Public form size guard');
  const { formTooBig } = await import('../src/lib/form-size');
  const small = new FormData();
  small.set('name', 'Γιώργος');
  small.set('message', 'Θέλω ένα λάδι για το αυτοκίνητό μου.');
  check('an ordinary Greek submission passes', !formTooBig(small));
  const big = new FormData();
  big.set('message', 'x'.repeat(300 * 1024));
  check('a 300 KB submission is refused', formTooBig(big));
  const fileFd = new FormData();
  fileFd.set('f', new File([new Uint8Array(300 * 1024)], 'a.txt'));
  check('file bytes count toward the limit too', formTooBig(fileFd));

  console.log('Login budgets (persistent)');
  const { rateLimit } = await import('../src/lib/rate-limit');
  // The per-IP pool is what stops spraying; simulate it directly (no request context here for clientIp()).
  for (let i = 0; i < 20; i++) await rateLimit('login:ip:9.9.9.9', 20, 15 * 60 * 1000);
  const exhausted = await rateLimit('login:ip:9.9.9.9', 20, 15 * 60 * 1000);
  check('the 21st login attempt from one IP is refused', !exhausted.ok, exhausted);
  // ...while each separate account still has its own budget
  const otherAccount = await rateLimit('login:9.9.9.9:other@example.com', 8, 15 * 60 * 1000);
  check('per-account budget is independent of the IP pool', otherAccount.ok, otherAccount);
  // The counter is in SQLite: inspect the row directly (raw keys are hashed, never stored).
  const { client } = await import('../src/lib/db');
  const stored = await client.execute('select count(*) as n from rate_limits');
  check('limit counters are persisted in the database', Number(stored.rows[0]?.n ?? 0) >= 2, stored.rows[0]);

  // A fresh process against the SAME database simulates a deploy/restart.
  const { execFileSync } = await import('node:child_process');
  const probe = (mode: string, key: string) =>
    JSON.parse(execFileSync('npx', ['tsx', 'scripts/limiter-probe.ts', mode, key, '2'], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })) as { ok: boolean };
  const exhaustedBefore = probe('exhaust', 'restart-probe');
  const afterRestart = probe('check', 'restart-probe');
  check('an exhausted budget stays exhausted in a fresh process (restart)', !exhaustedBefore.ok && !afterRestart.ok, { exhaustedBefore, afterRestart });
  const freshKey = probe('check', 'restart-probe-untouched');
  check('a different key still has its own budget after the restart', freshKey.ok, freshKey);

  console.log('Startup configuration checks');
  const { checkProductionConfig } = await import('../src/lib/startup-check');
  const saved = { secret: process.env.AUTH_SECRET, site: process.env.SITE_URL, commerce: process.env.COMMERCE_ENABLED };
  const cfg = (secret: string | undefined, site: string | undefined, commerce?: string): string[] => {
    if (secret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = secret;
    if (site === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = site;
    if (commerce === undefined) delete process.env.COMMERCE_ENABLED; else process.env.COMMERCE_ENABLED = commerce;
    return checkProductionConfig();
  };
  const missing = cfg(undefined, 'https://www.oilcenter.gr');
  check('missing AUTH_SECRET is reported', missing.some((p) => p.includes('AUTH_SECRET')), missing);
  const http = cfg('x'.repeat(48), 'http://shop.example.gr');
  check('a public http SITE_URL is reported', http.some((p) => p.includes('https')), http);
  const local = cfg('x'.repeat(48), 'http://localhost:3000');
  check('…but http on the developer machine is fine', local.length === 0, local);
  const weird = cfg('x'.repeat(48), 'https://www.oilcenter.gr', 'maybe');
  check('a nonsense COMMERCE_ENABLED is reported', weird.some((p) => p.includes('COMMERCE_ENABLED')), weird);
  const good = cfg('x'.repeat(48), 'https://www.oilcenter.gr', 'false');
  check('a complete production configuration passes', good.length === 0, good);
  process.env.AUTH_SECRET = saved.secret; process.env.SITE_URL = saved.site; process.env.COMMERCE_ENABLED = saved.commerce;

  console.log('Admin second factor (TOTP)');
  const { newTotpSecret, totpFor, totpStep, totpUri, verifyTotp } = await import('../src/lib/auth/totp');
  const secret = newTotpSecret();
  check('secret is base32 (160-bit), as authenticator apps expect', /^[A-Z2-7]{32}$/.test(secret), secret);
  const email = 'owner@example.com';
  const now = totpFor(secret, email).generate();
  check('the current 6-digit code verifies', /^\d{6}$/.test(now) && verifyTotp(secret, email, now), now);
  check('a wrong code is refused', !verifyTotp(secret, email, now === '000000' ? '111111' : '000000'));
  check('a non-numeric token is refused', !verifyTotp(secret, email, 'abcdef'));
  check('a code from the previous 30 s step is accepted (clock drift)', verifyTotp(secret, email, totpFor(secret, email).generate({ timestamp: Date.now() - 30_000 })));
  check('a code three steps old is refused', !verifyTotp(secret, email, totpFor(secret, email).generate({ timestamp: Date.now() - 90_000 })));
  const uri = totpUri(secret, email);
  check('otpauth URI names the issuer and the account', uri.startsWith('otpauth://totp/') && uri.includes('Oil%20Center') && uri.includes(encodeURIComponent(email)), uri);
  const step = totpStep(secret, email, now);
  check('a valid code maps to one stable time step (single-use storage)', step !== null && step === totpStep(secret, email, now), step);
  check('a code outside the drift window maps to no step', totpStep(secret, email, totpFor(secret, email).generate({ timestamp: Date.now() - 90_000 })) === null);

  console.log('Off-site backup encryption');
  process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const { decryptBackup, encryptBackup, expired, expiredVersions } = await import('../src/lib/backup-offsite');
  const plain = Buffer.from('SQLite format 3\0customer data and password hashes');
  const sealed = encryptBackup(plain);
  check('decrypt(encrypt(x)) === x', decryptBackup(sealed).equals(plain));
  check('the ciphertext does not contain the plaintext', !sealed.subarray(20).includes('customer data'));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  let tamperRefused = false;
  try {
    decryptBackup(tampered);
  } catch {
    tamperRefused = true;
  }
  check('a flipped ciphertext byte is refused (GCM authentication)', tamperRefused);
  let foreignRefused = false;
  try {
    decryptBackup(Buffer.from('not a backup at all................'));
  } catch {
    foreignRefused = true;
  }
  check('a foreign file is refused (magic header)', foreignRefused);
  const names = ['shop-2026-10-16.db.gz.enc', 'shop-2026-10-17.db.gz.enc', 'shop-2026-10-15.db.gz.enc', 'uploads-2026-10-17.tar.gz.enc'];
  check('retention keeps the newest N and marks the rest for deletion', JSON.stringify(expired(names, 'shop-', '.db.gz.enc', 2)) === JSON.stringify(['shop-2026-10-15.db.gz.enc']));
  check('uploads archives and database snapshots never mix', expired(names, 'uploads-', '.tar.gz.enc', 4).length === 0);
  const versions = [
    { fileName: 'shop-a.db.gz.enc', uploadTimestamp: 1 },
    { fileName: 'shop-b.db.gz.enc', uploadTimestamp: 3 },
    { fileName: 'shop-c.db.gz.enc', uploadTimestamp: 2 },
    { fileName: 'uploads-x.tar.gz.enc', uploadTimestamp: 9 },
  ];
  check('version retention keeps the newest and marks older versions', expiredVersions(versions, 'shop-', 2).map((v) => v.fileName).join(',') === 'shop-a.db.gz.enc');
  check('version retention never mixes archive families', expiredVersions(versions, 'uploads-', 2).length === 0);
  process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(31, 1).toString('base64');
  let badKeyRefused = false;
  try {
    encryptBackup(plain);
  } catch {
    badKeyRefused = true;
  }
  check('a key that is not 32 bytes is refused', badKeyRefused);
  delete process.env.BACKUP_ENCRYPTION_KEY;

  console.log('Off-site backup configuration check');
  process.env.B2_KEY_ID = 'only-one-of-four';
  const partialB2 = cfg('x'.repeat(48), 'https://www.oilcenter.gr', 'false');
  check('a partially configured B2 is reported', partialB2.some((p) => p.includes('partially configured')), partialB2);
  delete process.env.B2_KEY_ID;
  process.env.B2_KEY_ID = 'a'; process.env.B2_APP_KEY = 'b'; process.env.B2_BUCKET = 'c';
  process.env.BACKUP_ENCRYPTION_KEY = 'too-short';
  const badBackupKey = cfg('x'.repeat(48), 'https://www.oilcenter.gr', 'false');
  check('a bad BACKUP_ENCRYPTION_KEY is reported', badBackupKey.some((p) => p.includes('BACKUP_ENCRYPTION_KEY')), badBackupKey);
  delete process.env.B2_KEY_ID; delete process.env.B2_APP_KEY; delete process.env.B2_BUCKET; delete process.env.BACKUP_ENCRYPTION_KEY;

  console.log('Request-size boundaries');
  const { readJsonLimited } = await import('../src/lib/form-size');
  const okBody = await readJsonLimited(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ lines: [] }), headers: { 'Content-Type': 'application/json' } }), 1024);
  check('valid JSON within the cap is parsed', okBody.ok && JSON.stringify(okBody.value) === '{"lines":[]}');
  const bigBody = await readJsonLimited(new Request('http://localhost/x', { method: 'POST', body: 'x'.repeat(5000) }), 1024);
  check('an oversized streamed body is refused', !bigBody.ok && bigBody.tooLarge);
  const badJson = await readJsonLimited(new Request('http://localhost/x', { method: 'POST', body: '{not json' }), 1024);
  check('malformed JSON is refused separately from an oversized body', !badJson.ok && !badJson.tooLarge);

  console.log('Staged admin uploads');
  const path = (await import('node:path')).default;
  process.env.DATA_DIR = path.join(dir, 'data');
  const { stageUpload, claimUpload, releaseUpload, readBodyLimited, isUploadKind, uploadLimit, isSameOrigin } = await import('../src/lib/uploads');
  const { pendingUploads } = await import('../src/lib/db/schema');
  check('only explicit upload kinds are accepted', isUploadKind('photo') && !isUploadKind('toString') && !isUploadKind('__proto__'));
  check('an explicit kind has a positive byte limit', uploadLimit('photo') > 0);
  check('inherited/unknown kinds have no limit', uploadLimit('toString' as 'photo') === 0);
  const sameHost = new Request('https://shop.example/api/admin/upload', { method: 'POST', headers: { origin: 'https://shop.example', host: 'shop.example', 'sec-fetch-site': 'same-origin' } });
  const crossHost = new Request('https://shop.example/api/admin/upload', { method: 'POST', headers: { origin: 'https://evil.example', host: 'shop.example' } });
  const crossSite = new Request('https://shop.example/api/admin/upload', { method: 'POST', headers: { origin: 'https://shop.example', host: 'shop.example', 'sec-fetch-site': 'cross-site' } });
  check('a same-origin upload request is accepted', isSameOrigin(sameHost));
  check('a foreign Origin is rejected', !isSameOrigin(crossHost));
  check('cross-site fetch metadata is rejected', !isSameOrigin(crossSite));
  const token = await stageUpload(1, 'photo', 'x.jpg', Buffer.from('synthetic-webp-bytes'));
  check('a staged upload can be claimed once', Boolean(await claimUpload(token, 'photo', 1)));
  check('the same upload cannot be claimed twice', (await claimUpload(token, 'photo', 1)) === null);
  await releaseUpload(token);
  check('a released upload can be claimed again after a failed save', Boolean(await claimUpload(token, 'photo', 1)));
  const foreign = await stageUpload(1, 'photo', 'y.jpg', Buffer.alloc(4));
  check('another administrator cannot claim it', (await claimUpload(foreign, 'photo', 2)) === null);
  check('a different kind cannot claim it', (await claimUpload(foreign, 'sds', 1)) === null);
  const expiredToken = await stageUpload(1, 'price-csv', 'z.csv', Buffer.from('a'));
  await db.update(pendingUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pendingUploads.token, expiredToken));
  check('an expired upload cannot be claimed', (await claimUpload(expiredToken, 'price-csv', 1)) === null);
  const smallStream = new Request('http://localhost/x', { method: 'POST', body: '12345' });
  check('a streamed body within the upload cap is read', (await readBodyLimited(smallStream.body, 10))?.toString() === '12345');
  const largeStream = new Request('http://localhost/x', { method: 'POST', body: 'x'.repeat(100) });
  check('a streamed body over the upload cap is refused', (await readBodyLimited(largeStream.body, 10)) === null);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  });
