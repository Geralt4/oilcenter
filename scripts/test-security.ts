/*
 * Security-boundary regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:security
 * Covers the deployment-level commerce switch (COMMERCE_ENABLED=false): no order creation, no accounts,
 * no payment sessions — regardless of the owner's settings, a logged-in admin, or a real order in the database.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  const { eq, sql } = await import('drizzle-orm');
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
  // The counters themselves; the login actions that use them (per address, failure-only per account) are exercised in test-admin.ts.
  // The per-IP pool is what stops spraying; simulate it directly (no request context here for clientIp()).
  for (let i = 0; i < 20; i++) await rateLimit('login:ip:9.9.9.9', 20, 15 * 60 * 1000);
  const exhausted = await rateLimit('login:ip:9.9.9.9', 20, 15 * 60 * 1000);
  check('the 21st login attempt from one IP is refused', !exhausted.ok, exhausted);
  // ...while each separate account still has its own budget
  const otherAccount = await rateLimit('login:9.9.9.9:other@example.com', 8, 15 * 60 * 1000);
  check('per-account budget is independent of the IP pool', otherAccount.ok, otherAccount);
  // The counter is in SQLite: inspect the row directly (raw keys are hashed, never stored).
  const { client } = await import('../src/lib/db');
  // a counter that only failures move: peeking spends nothing, and the limit trips exactly when it is reached
  const { peekLimit } = await import('../src/lib/rate-limit');
  check('peeking at an untouched counter is allowed', (await peekLimit('peek:untouched', 3, 60_000)).ok);
  for (let i = 0; i < 2; i++) await rateLimit('peek:counter', 3, 60_000);
  check('peeking does not spend anything', (await peekLimit('peek:counter', 3, 60_000)).ok && (await peekLimit('peek:counter', 3, 60_000)).ok);
  await rateLimit('peek:counter', 3, 60_000);
  const peeked = await peekLimit('peek:counter', 3, 60_000);
  check('after the 3rd recorded failure the 4th attempt is paused, with a retry time', !peeked.ok && peeked.retryAfterSec > 0, peeked);
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

  // Non-fatal warning: Resend without MAIL_FROM while commerce is on
  const { checkProductionWarnings } = await import('../src/lib/startup-check');
  const mailEnv = ['RESEND_API_KEY', 'MAIL_FROM', 'SMTP_HOST', 'COMMERCE_ENABLED'] as const;
  const savedMail = Object.fromEntries(mailEnv.map((n) => [n, process.env[n]]));
  const warnWith = (env: Partial<Record<(typeof mailEnv)[number], string>>): string[] => {
    for (const n of mailEnv) delete process.env[n];
    for (const [n, v] of Object.entries(env)) process.env[n] = v;
    return checkProductionWarnings();
  };
  const noSender = warnWith({ RESEND_API_KEY: 're_test' });
  check('Resend without MAIL_FROM while commerce is on → one warning naming MAIL_FROM', noSender.length === 1 && noSender[0].includes('MAIL_FROM'), noSender);
  const blankSender = warnWith({ RESEND_API_KEY: 're_test', MAIL_FROM: '   ' });
  check('…a blank MAIL_FROM counts as unset', blankSender.length === 1, blankSender);
  const explicitCommerce = warnWith({ RESEND_API_KEY: 're_test', COMMERCE_ENABLED: 'true' });
  check('…also with COMMERCE_ENABLED=true', explicitCommerce.length === 1, explicitCommerce);
  const withSender = warnWith({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Oil Center <no-reply@oilcenter.gr>' });
  check('no warning when MAIL_FROM is set', withSender.length === 0, withSender);
  const catalogue = warnWith({ RESEND_API_KEY: 're_test', COMMERCE_ENABLED: 'false' });
  check('no warning in catalogue mode (COMMERCE_ENABLED=false)', catalogue.length === 0, catalogue);
  const smtpOnly = warnWith({ SMTP_HOST: 'smtp.example.gr' });
  check('no warning when mail goes through SMTP', smtpOnly.length === 0, smtpOnly);
  const fileFallback = warnWith({});
  check('no warning with the file fallback (no Resend, no SMTP)', fileFallback.length === 0, fileFallback);
  const fatalToo = (() => {
    for (const n of mailEnv) delete process.env[n];
    process.env.RESEND_API_KEY = 're_test';
    return cfg('x'.repeat(48), 'https://www.oilcenter.gr', undefined);
  })();
  check('the warning is not a boot-stopping problem', fatalToo.length === 0, fatalToo);
  for (const n of mailEnv) { if (savedMail[n] === undefined) delete process.env[n]; else process.env[n] = savedMail[n]; }

  if (saved.secret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved.secret;
  if (saved.site === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved.site;
  if (saved.commerce === undefined) delete process.env.COMMERCE_ENABLED; else process.env.COMMERCE_ENABLED = saved.commerce;

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
  const { decryptBackup, encryptBackup, expired, expiredBackups, expiredVersions } = await import('../src/lib/backup-offsite');
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
  // a busy week of deploys: 20 days of daily copies, 5 boot snapshots and 5 uploads versions per day
  const busy: Array<{ fileName: string; uploadTimestamp: number }> = [];
  for (let d = 1; d <= 20; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    busy.push({ fileName: `shop-${day}.db.gz.enc`, uploadTimestamp: d * 100 });
    for (let b = 1; b <= 5; b++) {
      busy.push({ fileName: `shop-${day}-0${b}0000.db.gz.enc`, uploadTimestamp: d * 100 + b });
      busy.push({ fileName: `uploads-${day}.tar.gz.enc`, uploadTimestamp: d * 100 + b });
    }
  }
  const pruned = new Set(expiredBackups(busy));
  const left = busy.filter((v) => !pruned.has(v));
  check('frequent deploys do not shorten the 14 daily database copies', left.filter((v) => /^shop-[\d-]{10}\.db/.test(v.fileName)).length === 14, left.map((v) => v.fileName));
  check('…boot snapshots are kept separately (7 newest)', left.filter((v) => /^shop-[\d-]{10}-\d{6}/.test(v.fileName)).length === 7);
  check('…and the uploads archives of 14 days survive, one version each', new Set(left.filter((v) => v.fileName.startsWith('uploads-')).map((v) => v.fileName)).size === 14 && left.filter((v) => v.fileName.startsWith('uploads-')).length === 14);
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

  console.log('Off-site backup: timeouts and stuck runs');
  {
    const { B2Error, ensureOffsiteBackup, offsiteIsFresh, offsiteLimits, offsiteStatus, pushSnapshotNow, uploadTimeoutMs } = await import('../src/lib/backup-offsite');
    const nodePath = (await import('node:path')).default;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const lim0 = { ...offsiteLimits };
    check('the limits: 30 s for a call, 60 s + 4 s per MiB for an upload, 2 h before a run is taken for dead', lim0.callMs === 30_000 && lim0.uploadBaseMs === 60_000 && lim0.uploadPerMibMs === 4_000 && lim0.staleMs === 7_200_000, lim0);
    check('an upload of 5 MiB gets 80 s, an empty one 60 s, and the cap holds', uploadTimeoutMs(5 * 1024 * 1024) === 80_000 && uploadTimeoutMs(0) === 60_000 && uploadTimeoutMs(10_000 * 1024 * 1024) === 1_800_000);

    // a fake B2: every step answers, hangs (and gives up when its signal aborts, like the real fetch) or answers an HTTP error
    type Rule = 'hang' | 'deaf' | number;
    let rules: Partial<Record<string, Rule>> = {};
    const release: Array<() => void> = [];
    const stepOf = (url: string) => url.includes('b2_authorize_account') ? 'authorize' : url.includes('b2_list_buckets') ? 'bucket' : url.includes('b2_list_file_names') ? 'list' : url.includes('b2_get_upload_url') ? 'upload URL' : url.includes('up.b2.test') ? 'upload' : 'cleanup';
    const answers: Record<string, unknown> = {
      authorize: { apiUrl: 'https://api.b2.test', authorizationToken: 't', accountId: 'acc' },
      bucket: { buckets: [{ bucketId: 'b1', bucketName: 'bucket-test' }] },
      list: { files: [], nextFileName: null },
      'upload URL': { uploadUrl: 'https://up.b2.test/file', authorizationToken: 'u' },
      upload: {},
      cleanup: { files: [], nextFileName: null, nextFileId: null },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const step = stepOf(String(input));
      const rule = rules[step];
      if (rule === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      // a hang the deadline cannot reach: it ignores the signal until the test lets it go, and then fails
      if (rule === 'deaf') { await new Promise<void>((resolve) => release.push(resolve)); throw new Error('connection reset'); }
      if (typeof rule === 'number') return new Response('boom', { status: rule });
      return new Response(JSON.stringify(answers[step]));
    }) as typeof fetch;

    const saved = { data: process.env.DATA_DIR, key: process.env.BACKUP_ENCRYPTION_KEY };
    const offDir = nodePath.join(dir, 'offsite-data');
    await mkdir(nodePath.join(offDir, 'backups'), { recursive: true });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
    await writeFile(nodePath.join(offDir, 'backups', `shop-${day}.db.gz`), 'a tiny snapshot');
    process.env.DATA_DIR = offDir;
    process.env.B2_KEY_ID = 'k'; process.env.B2_APP_KEY = 'a'; process.env.B2_BUCKET = 'bucket-test';
    process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    offsiteLimits.callMs = 150; offsiteLimits.uploadBaseMs = 150; offsiteLimits.uploadPerMibMs = 0; offsiteLimits.uploadMaxMs = 150; offsiteLimits.staleMs = 400;

    const attempt = async () => {
      const t = Date.now();
      try {
        return { result: await ensureOffsiteBackup(), err: null as unknown as InstanceType<typeof B2Error>, ms: Date.now() - t };
      } catch (err) {
        return { result: null, err: err as InstanceType<typeof B2Error>, ms: Date.now() - t };
      }
    };
    const steps = ['authorize', 'bucket', 'list', 'upload URL', 'upload', 'cleanup'];
    // AbortSignal.timeout timers do not keep a process alive, and the fake fetch has no socket: hold the loop open while the section runs
    const keepAlive = setInterval(() => undefined, 1000);
    try {
      for (const step of steps) {
        rules = { [step]: 'hang' };
        const r = await attempt();
        check(`a «${step}» call that never answers fails within the limit and says so`, r.err instanceof B2Error && r.err.step === step && r.err.timedOut && r.err.message.includes(step) && r.err.message.includes('timed out') && r.ms < 2000, { message: r.err?.message, ms: r.ms });
        const status = await offsiteStatus();
        check('…the failure is recorded with the step', status?.ok === false && (status.error ?? '').includes(step), status);
        rules = {};
        const next = await attempt();
        check('…and the next run goes ahead (the flag was reset)', next.result === 'uploaded', next.err?.message ?? next.result);
      }
      for (const step of steps) {
        rules = { [step]: 500 };
        const r = await attempt();
        check(`an HTTP 500 at «${step}» names the step and is not a timeout`, r.err instanceof B2Error && r.err.step === step && !r.err.timedOut && r.err.message.includes(step) && r.err.message.includes('500'), r.err?.message);
        rules = {};
        check('…and the next run goes ahead', (await attempt()).result === 'uploaded');
      }

      // a hang the deadline cannot reach: the run stays marked as running until the stale limit passes
      rules = { authorize: 'deaf' };
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      try {
        const stuck = ensureOffsiteBackup().then(() => 'finished', (err: Error) => err.message);
        await sleep(20);
        check('while a run is young, the next call leaves it alone', (await ensureOffsiteBackup()) === 'exists' && warnings.length === 0, warnings);
        await sleep(450);
        const takeover = ensureOffsiteBackup().then(() => 'finished', (err: Error) => err.message);
        await sleep(20);
        check('a run marked as running past the stale limit is taken for dead, with a warning', warnings.length === 1 && warnings[0].includes('treating it as dead'), warnings);
        release[0]();
        check('the dead run failing late is reported to its own caller', (await stuck).includes('authorize'));
        check('…and does not clear the flag of the run that replaced it', (await ensureOffsiteBackup()) === 'exists');
        release[1]();
        await takeover;
        rules = {};
        check('once the replacement ends, runs go ahead again', (await attempt()).result === 'uploaded');
      } finally {
        console.warn = realWarn;
      }

      // the time of the last success survives a failed attempt
      const good = await offsiteStatus();
      check('a successful run records the time of the success', good?.ok === true && good.lastOkAt === good.at, good);
      rules = { upload: 500 };
      await attempt();
      const failed = await offsiteStatus();
      check('a failed run keeps the time of the last success', failed?.ok === false && failed.lastOkAt === good?.at, failed);
      check('…so the checklist stays green for a day after one failed run', offsiteIsFresh(failed));
      const H = 3600 * 1000;
      check('fresh at 25 h, not at 27 h', offsiteIsFresh({ at: Date.now(), ok: true, object: 'x', lastOkAt: Date.now() - 25 * H }) && !offsiteIsFresh({ at: Date.now(), ok: true, object: 'x', lastOkAt: Date.now() - 27 * H }));
      check('a failed attempt after an old success is not fresh', !offsiteIsFresh({ at: Date.now(), ok: false, object: null, lastOkAt: Date.now() - 30 * H }));
      check('a status file from before lastOkAt existed still reads right', offsiteIsFresh({ at: Date.now() - H, ok: true, object: 'x' }) && !offsiteIsFresh({ at: Date.now() - H, ok: false, object: null }) && !offsiteIsFresh(null));

      // the «backup now» path has the same deadlines
      rules = { upload: 'hang' };
      const pushed = await pushSnapshotNow().then(() => null, (err: InstanceType<typeof B2Error>) => err);
      check('«backup now» also gives up on a hung upload and says which step', pushed instanceof B2Error && pushed.step === 'upload' && pushed.timedOut, pushed?.message);
    } finally {
      clearInterval(keepAlive);
      globalThis.fetch = realFetch;
      Object.assign(offsiteLimits, lim0);
      if (saved.data === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved.data;
      if (saved.key === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = saved.key;
      delete process.env.B2_KEY_ID; delete process.env.B2_APP_KEY; delete process.env.B2_BUCKET;
    }
  }

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
  const { stageUpload, claimUpload, releaseUpload, finishUpload, readBodyLimited, isUploadKind, uploadLimit, isSameOrigin, stagingDir } = await import('../src/lib/uploads');
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
  const stalled = new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } });
  const startedAt = Date.now();
  const stalledResult = await readBodyLimited(stalled, 1024, 30);
  check('a stalled upload deadline interrupts the pending read', stalledResult === null && Date.now() - startedAt < 1000, Date.now() - startedAt);
  const hungCancel = new ReadableStream<Uint8Array>({ cancel() { return new Promise<void>(() => undefined); } });
  const hungStarted = Date.now();
  const hungResult = await Promise.race([readBodyLimited(hungCancel, 1024, 30), new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1000))]);
  check('cancellation that never settles cannot hold the request open', hungResult === null && Date.now() - hungStarted < 1000, hungResult);
  const late = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Simulates a read that was already in flight while the event loop was blocked past the deadline.
      const until = Date.now() + 60;
      while (Date.now() < until) { /* deliberately block */ }
      controller.close();
    },
  });
  const lateStarted = Date.now();
  check('a completion delivered after the deadline is still refused', (await readBodyLimited(late, 1024, 10)) === null, Date.now() - lateStarted);

  const movedToken = await stageUpload(1, 'photo', 'moved.webp', Buffer.from('synthetic-photo'));
  await claimUpload(movedToken, 'photo', 1);
  const movedStaging = path.join(stagingDir(), movedToken);
  const movedFinal = path.join(dir, 'synthetic-moved.webp');
  await rename(movedStaging, movedFinal);
  await releaseUpload(movedToken, movedFinal);
  check('a moved file is restored to staging on rollback', await stat(movedStaging).then(() => true).catch(() => false));
  check('…and its token is claimable again', Boolean(await claimUpload(movedToken, 'photo', 1)));
  await finishUpload(movedToken);

  const brokenToken = await stageUpload(1, 'photo', 'broken.webp', Buffer.from('synthetic-photo'));
  await claimUpload(brokenToken, 'photo', 1);
  await rm(path.join(stagingDir(), brokenToken), { force: true });
  let restoreReported = false;
  try {
    await releaseUpload(brokenToken, path.join(dir, 'missing', 'broken.webp'));
  } catch {
    restoreReported = true;
  }
  check('a failed file restore is reported instead of swallowed', restoreReported);
  check('…and the token is not made claimable while its bytes are missing', (await claimUpload(brokenToken, 'photo', 1)) === null);
  await releaseUpload(brokenToken);
  await finishUpload(brokenToken);

  // Bytes whose record cannot be written must not survive: the sweeper works from the table, so it
  // would never learn about them. Hiding the table makes the insert fail the way a locked database would.
  const stagedBefore = await readdir(stagingDir());
  await client.execute('ALTER TABLE pending_uploads RENAME TO pending_uploads_hidden');
  let registrationFailed = false;
  try {
    await stageUpload(1, 'photo', 'unregistered.png', Buffer.from('orphaned bytes'));
  } catch {
    registrationFailed = true;
  }
  await client.execute('ALTER TABLE pending_uploads_hidden RENAME TO pending_uploads');
  check('a failed token registration is reported', registrationFailed);
  check('…and the bytes it had already written are removed again', (await readdir(stagingDir())).length === stagedBefore.length);

  // The mirror case at the other end of the lifecycle: a file that cannot be deleted keeps its record,
  // so the hourly sweeper can still find it. Deleting the record first would orphan the bytes forever.
  const stuckToken = await stageUpload(1, 'price-csv', 'stuck.csv', Buffer.from('synthetic csv'));
  const stuckPath = path.join(stagingDir(), stuckToken);
  await rm(stuckPath, { force: true });
  await mkdir(stuckPath);
  await writeFile(path.join(stuckPath, 'child'), 'undeletable');
  let finishFailed = false;
  try {
    await finishUpload(stuckToken);
  } catch {
    finishFailed = true;
  }
  const stuckRow = await db.select().from(pendingUploads).where(eq(pendingUploads.token, stuckToken));
  check('a file that cannot be deleted fails the cleanup instead of hiding it', finishFailed);
  check('…and its record survives for the sweeper to finish the job', stuckRow.length === 1);
  await rm(stuckPath, { recursive: true, force: true });
  await finishUpload(stuckToken);
  check('the record is removed once the bytes are gone', (await db.select().from(pendingUploads).where(eq(pendingUploads.token, stuckToken))).length === 0);

  console.log('Upload submit coordination');
  const { beginUpload, endUpload, pendingUploads: pendingUploadCount } = await import('../src/components/admin/upload-pending');
  const button = { disabled: false };
  const listeners: Array<(event: { preventDefault: () => void; stopImmediatePropagation: () => void }) => void> = [];
  const fakeForm = {
    querySelector: () => button,
    addEventListener: (_name: string, fn: (typeof listeners)[number]) => listeners.push(fn),
  } as unknown as HTMLFormElement;
  beginUpload(fakeForm);
  beginUpload(fakeForm);
  check('save stays disabled while any upload runs', button.disabled && pendingUploadCount(fakeForm) === 2);
  let prevented = false;
  for (const listener of listeners) listener({ preventDefault: () => (prevented = true), stopImmediatePropagation: () => undefined });
  check('submitting while uploads run is blocked', prevented);
  endUpload(fakeForm);
  check('one finished upload does not re-enable save', button.disabled && pendingUploadCount(fakeForm) === 1);
  endUpload(fakeForm);
  check('save is enabled only after the last upload finishes', !button.disabled && pendingUploadCount(fakeForm) === 0);

  console.log('Statistics: visitor input cannot grow the counters table');
  {
    const { and: andOp } = await import('drizzle-orm');
    const { statCounters, products, brands } = await import('../src/lib/db/schema');
    const { recordEvent, athensDay, statLimits, statSearchKey, forgetStatSlugs, OTHER_SEARCH, OTHER_SOURCE } = await import('../src/lib/stats');
    const day = athensDay();
    let visitorNo = 0;
    const ctx = () => ({ ip: `203.0.113.${++visitorNo % 250}`, userAgent: `Mozilla/5.0 test-${visitorNo}`, host: 'www.oilcenter.gr', ordersEnabled: false });
    const countOf = async (kind: string, key: string) => (await db.select().from(statCounters).where(andOp(eq(statCounters.day, day), eq(statCounters.kind, kind), eq(statCounters.key, key))))[0]?.count ?? 0;
    const rowsOf = async (kind: string) => (await db.select().from(statCounters).where(andOp(eq(statCounters.day, day), eq(statCounters.kind, kind)))).length;

    const [product] = await db.select().from(products).where(eq(products.isActive, true)).limit(1);
    const [brand] = product.brandId ? await db.select().from(brands).where(eq(brands.id, product.brandId)) : [];
    forgetStatSlugs();
    const known0 = await countOf('product', product.slug);
    await recordEvent({ t: 'view', path: `/product/${product.slug}` }, ctx());
    check('a view of an existing product is counted', (await countOf('product', product.slug)) === known0 + 1);
    const productRows = await rowsOf('product');
    const brandRows = await rowsOf('brand');
    const categoryRows = await rowsOf('category');
    const cartRows = await rowsOf('cart');
    for (let i = 0; i < 20; i++) {
      await recordEvent({ t: 'view', path: `/product/no-such-oil-${i}` }, ctx());
      await recordEvent({ t: 'view', path: `/brand/no-such-brand-${i}` }, ctx());
      await recordEvent({ t: 'view', path: `/category/no-such-category-${i}` }, ctx());
      await recordEvent({ t: 'cart', slug: `no-such-oil-${i}` }, ctx());
    }
    check('views of unknown product, brand and category slugs add no rows', (await rowsOf('product')) === productRows && (await rowsOf('brand')) === brandRows && (await rowsOf('category')) === categoryRows, [await rowsOf('product'), productRows]);
    check('…nor does a cart event for an unknown product', (await rowsOf('cart')) === cartRows);
    const pv = await countOf('pageview', '/product');
    await recordEvent({ t: 'view', path: '/product/no-such-oil-x' }, ctx());
    check('…while the page view itself still counts in its section', (await countOf('pageview', '/product')) === pv + 1);
    const cart0 = await countOf('cart', product.slug);
    await recordEvent({ t: 'cart', slug: product.slug }, ctx());
    check('a cart event for a listed product is counted', (await countOf('cart', product.slug)) === cart0 + 1);
    if (brand) {
      const b0 = await countOf('brand', brand.slug);
      await recordEvent({ t: 'view', path: `/brand/${brand.slug}` }, ctx());
      check('a view of an existing brand is counted', (await countOf('brand', brand.slug)) === b0 + 1);
    }

    // the slug list is cached, not read per view: a product switched off still counts until the list is read again
    await db.update(products).set({ isActive: false }).where(eq(products.id, product.id));
    const cachedN = await countOf('product', product.slug);
    await recordEvent({ t: 'view', path: `/product/${product.slug}` }, ctx());
    check('the slug list is reused between views (no lookup per hit)', (await countOf('product', product.slug)) === cachedN + 1);
    forgetStatSlugs();
    await recordEvent({ t: 'view', path: `/product/${product.slug}` }, ctx());
    check('…and once read again, a product that is gone is no longer counted', (await countOf('product', product.slug)) === cachedN + 1);
    await db.update(products).set({ isActive: true }).where(eq(products.id, product.id));
    forgetStatSlugs();

    check('search text is trimmed, lower-cased and its spaces collapsed', statSearchKey('   Castrol    EDGE   5W-30  ') === 'castrol edge 5w 30', statSearchKey('   Castrol    EDGE   5W-30  '));
    check('…accents and final sigma folded as before', statSearchKey('Λάδι ΚΙΝΗΤΉΡΑ γρασσος') === 'λαδι κινητηρα γρασσοσ', statSearchKey('Λάδι ΚΙΝΗΤΉΡΑ γρασσος'));
    const long = statSearchKey('motul '.repeat(30));
    check('…a long search is cut to 60 characters at most', long.length <= 60 && long.startsWith('motul motul'), long.length);
    check('…text with control characters is dropped', statSearchKey('castrol\u0000edge') === '' && statSearchKey('mobil\n1') === '' && statSearchKey('total\u007f') === '');
    check('…empty, blank or one-letter text is dropped', statSearchKey('') === '' && statSearchKey('   ') === '' && statSearchKey(' ;; ') === '' && statSearchKey('a') === '');
    const searchRows0 = await rowsOf('search');
    await recordEvent({ t: 'search', q: 'motul\u0000injected', n: 3 }, ctx());
    await recordEvent({ t: 'search', q: '   ', n: 3 }, ctx());
    check('a dropped search writes nothing', (await rowsOf('search')) === searchRows0);
    await recordEvent({ t: 'search', q: '  ELF   Evolution ', n: 2 }, ctx());
    check('a counted search is stored normalised', (await countOf('search', 'elf evolution')) === 1);

    // the daily cap: a small one, so the test does not need hundreds of rows
    const savedCap = statLimits.dailyNewKeys;
    const distinctNow = async () => (await db.select().from(statCounters).where(andOp(eq(statCounters.day, day), sql`${statCounters.kind} in ('search', 'search_empty')`, sql`${statCounters.key} <> ${OTHER_SEARCH}`))).length;
    statLimits.dailyNewKeys = (await distinctNow()) + 3;
    try {
      for (let i = 0; i < 10; i++) await recordEvent({ t: 'search', q: `flood text ${i}`, n: i % 2 }, ctx());
      check('the daily cap of new search keys holds (3 new keys, not 10)', (await distinctNow()) === statLimits.dailyNewKeys, await distinctNow());
      const overflow = (await countOf('search', OTHER_SEARCH)) + (await countOf('search_empty', OTHER_SEARCH));
      check(`…the other 7 are counted under «${OTHER_SEARCH}»`, overflow === 7, overflow);
      const before = await countOf('search', 'elf evolution');
      await recordEvent({ t: 'search', q: 'elf evolution', n: 2 }, ctx());
      check('…a search already counted today still adds up after the cap', (await countOf('search', 'elf evolution')) === before + 1);
      const sourcesNow = await rowsOf('source');
      statLimits.dailyNewKeys = sourcesNow + 1;
      for (let i = 0; i < 5; i++) await recordEvent({ t: 'view', path: '/', ref: `https://spam-${i}.example/` }, ctx());
      check(`referrer hosts have the same cap, the rest under «${OTHER_SOURCE}»`, (await rowsOf('source')) === sourcesNow + 2 && (await countOf('source', OTHER_SOURCE)) === 4, [await rowsOf('source'), sourcesNow, await countOf('source', OTHER_SOURCE)]);
    } finally {
      statLimits.dailyNewKeys = savedCap;
    }
  }

  console.log('Mail file fallback (no Resend, no SMTP)');
  {
    const { sendMail } = await import('../src/lib/email');
    const saved = { data: process.env.DATA_DIR, resend: process.env.RESEND_API_KEY, smtp: process.env.SMTP_HOST };
    const realIso = Date.prototype.toISOString;
    process.env.DATA_DIR = path.join(dir, 'mail-fallback');
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    // every file name starts with the time: freeze it, so "the same millisecond" is certain and not a matter of luck
    Date.prototype.toISOString = () => '2026-01-01T00:00:00.000Z';
    try {
      const mail = { to: 'same@example.gr', subject: 'ίδιο', html: '<p>ένα</p>' };
      const results = await Promise.all([sendMail(mail), sendMail({ ...mail, html: '<p>δύο</p>' }), sendMail({ ...mail, html: '<p>τρία</p>' })]);
      const files = await readdir(path.join(process.env.DATA_DIR, 'outbox'));
      check('three mails to one address in the same millisecond are all reported as sent', results.every(Boolean), results);
      check('…and each lands in its own file (none overwritten)', files.length === 3 && new Set(files).size === 3, files);
      check('…the file name still carries the address', files.every((f) => f.includes('same@example.gr')), files);
    } finally {
      Date.prototype.toISOString = realIso;
      for (const [key, value] of [['DATA_DIR', saved.data], ['RESEND_API_KEY', saved.resend], ['SMTP_HOST', saved.smtp]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  console.log('SMTP transport and mail failure log');
  {
    const { redactEmail, sendMail, smtpOptions } = await import('../src/lib/email');
    const saved = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, resend: process.env.RESEND_API_KEY };
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens there: the connection is refused at once
    delete process.env.RESEND_API_KEY;
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    let sent: boolean;
    try {
      sent = await sendMail({ to: 'customer.name@example.gr', subject: 'Παραγγελία', html: '<p>x</p>' });
    } finally {
      console.error = realError;
      for (const [key, value] of [['SMTP_HOST', saved.host], ['SMTP_PORT', saved.port], ['RESEND_API_KEY', saved.resend]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const o = smtpOptions();
    check('the SMTP connection has a connection, a greeting and a socket timeout (all set, none longer than 30 s)', [o.connectionTimeout, o.greetingTimeout, o.socketTimeout].every((t) => t > 0 && t <= 30_000), o);
    check('a mail that cannot be sent reports failure', sent === false);
    check('…the failure is logged', logged.some((l) => l.includes('[mail] failed to send')), logged);
    check('…without the recipient\'s address', !logged.some((l) => l.includes('customer.name@example.gr')) && logged.some((l) => l.includes('c***@example.gr')), logged);
    check('redactEmail keeps the first letter and the domain only', redactEmail('a@b.gr') === 'a***@b.gr' && redactEmail('no-at-sign') === '***' && redactEmail('') === '***');
  }

  console.log('Test database guard');
  {
    const savedUrl = process.env.DATABASE_URL; // points at this run's copy now
    process.env.DATABASE_URL = 'libsql://x.io';
    let refused = '';
    try {
      await cloneDatabase('oc-guard-');
    } catch (err) {
      refused = String(err);
    } finally {
      process.env.DATABASE_URL = savedUrl;
    }
    check('cloneDatabase refuses a database that is not a local file', refused.includes('must be a local file'), refused);
    check('…and names only the scheme, not the host it refused', refused.includes('libsql:') && !refused.includes('x.io'), refused);
  }

  console.log('seed --force');
  {
    const { db } = await import('../src/lib/db');
    const { products, variants } = await import('../src/lib/db/schema');
    const { count } = await import('drizzle-orm');
    const catalogue = JSON.parse(readFileSync('catalog/catalog.json', 'utf8')) as { products: Array<{ slug: string; variants: unknown[] }> };
    const seed = (env: Record<string, string>, cwd = process.cwd()) =>
      spawnSync(path.resolve('node_modules/.bin/tsx'), [path.resolve('scripts/seed.ts'), '--force'], { cwd, env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('tsconfig.json'), ...env }, encoding: 'utf8' });
    const totals = async () => [(await db.select({ n: count() }).from(products))[0].n, (await db.select({ n: count() }).from(variants))[0].n];
    const before = await totals();

    const hosted = seed({ DATABASE_URL: 'libsql://hosted-shop.example.turso.io', DATABASE_AUTH_TOKEN: 'x' });
    check('--force refuses a hosted database before touching it', hosted.status === 1 && hosted.stderr.includes('only works on a local file database'), [hosted.status, hosted.stderr.slice(0, 200)]);

    // a catalogue that breaks half-way (the same slug twice): the wipe must roll back with it
    const broken = path.join(dir, 'broken-catalogue');
    mkdirSync(path.join(broken, 'catalog'), { recursive: true });
    const bad = structuredClone(catalogue);
    bad.products[5].slug = bad.products[0].slug;
    writeFileSync(path.join(broken, 'catalog', 'catalog.json'), JSON.stringify(bad));
    const failed = seed({}, broken);
    const afterFailure = await totals();
    check('--force on a catalogue that fails half-way exits non-zero', failed.status !== 0, failed.status);
    check('…and the old catalogue is still all there (wipe and re-insert are one transaction)', before[0] > 0 && afterFailure.join() === before.join(), [before, afterFailure]);

    const ok = seed({});
    const afterOk = await totals();
    const sizes = catalogue.products.reduce((n, p) => n + p.variants.length, 0);
    check('--force with a good catalogue replaces it completely', ok.status === 0 && afterOk[0] === catalogue.products.length && afterOk[1] === sizes, [ok.status, afterOk, ok.stderr.slice(0, 200)]);
  }

  console.log('package.json');
  {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; engines?: { node?: string } };
    // every `tsx scripts/<file>` an npm script runs must exist (the `images` script once pointed at a file that was never there)
    const missing = Object.entries(pkg.scripts).flatMap(([name, cmd]) => [...cmd.matchAll(/\btsx\s+(scripts\/[\w.-]+\.ts)/g)].map((m) => ({ name, file: m[1] }))).filter((s) => !existsSync(s.file));
    check('every npm script that runs a tsx file points at a file that exists', missing.length === 0, missing);
    // scripts/env.ts calls process.loadEnvFile, which arrived in Node 20.12
    const [major, minor] = (/(\d+)\.(\d+)/.exec(pkg.engines?.node ?? '') ?? []).slice(1).map(Number);
    check('engines.node asks for at least 20.12 (process.loadEnvFile in scripts/env.ts)', major > 20 || (major === 20 && minor >= 12), pkg.engines);
  }
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
