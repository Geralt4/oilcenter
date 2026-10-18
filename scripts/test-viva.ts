/*
 * Viva (Smart Checkout) integration test. Runs with NO network access, against a throwaway COPY of the local database:
 *   npm run test:viva
 * Every fetch is replaced by a recording mock with canned replies. Any URL outside the four Viva endpoints the code
 * is meant to call (token, order, transaction, webhook verification key) throws, and is also listed at the end.
 * The request shapes asserted here are the ones src/lib/payments/viva.ts is meant to send, per the Smart Checkout
 * integration guide linked from that file.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { cloneDatabase } from './test-db';

// Fake credentials, set BEFORE anything imports the payment modules (viva.ts reads VIVA_ENV at import time).
process.env.VIVA_ENV = 'demo';
process.env.VIVA_CLIENT_ID = 'test-client';
process.env.VIVA_CLIENT_SECRET = 'test-secret';
process.env.VIVA_SOURCE_CODE = '1234';
process.env.VIVA_MERCHANT_ID = 'test-merchant';
process.env.VIVA_API_KEY = 'test-key';
delete process.env.COMMERCE_ENABLED;
// keep the mail path offline: no Resend / SMTP, and the outbox goes into the temp dir
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.STRIPE_SECRET_KEY;

let dir = '';
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

// ---- network mock -------------------------------------------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Kind = 'token' | 'order' | 'transaction' | 'webhook-key';

const ROUTES: [RegExp, Kind][] = [
  [/^https:\/\/(demo-)?accounts\.vivapayments\.com\/connect\/token$/, 'token'],
  [/^https:\/\/(demo-)?api\.vivapayments\.com\/checkout\/v2\/orders$/, 'order'],
  [/^https:\/\/(demo-)?api\.vivapayments\.com\/checkout\/v2\/transactions\/[0-9a-f-]{36}$/i, 'transaction'],
  [/^https:\/\/(demo|www)\.vivapayments\.com\/api\/messages\/config\/token$/, 'webhook-key'],
];
const calls: Call[] = [];
const unexpected: string[] = [];
// canned replies; the order reply is RAW TEXT on purpose (the code must not JSON.parse the 16-digit code)
const canned = {
  tokenStatus: 200,
  orderStatus: 200,
  orderBody: '{"orderCode":9515982136481235}',
  txStatus: 200,
  txBody: '{}',
  keyStatus: 200,
  keyBody: '{"Key":"verify-key-123"}',
};
const kindOf = (url: string) => ROUTES.find(([re]) => re.test(url))?.[1];
const callsOf = (kind: Kind) => calls.filter((c) => kindOf(c.url) === kind);

function installFetchMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, headers, body });
    const kind = kindOf(url);
    if (!kind) {
      unexpected.push(`${method} ${url}`);
      throw new Error(`test: unexpected network call ${method} ${url}`);
    }
    if (kind === 'token') return new Response(canned.tokenStatus === 200 ? '{"access_token":"tok-test","expires_in":3600}' : 'denied', { status: canned.tokenStatus });
    if (kind === 'order') return new Response(canned.orderBody, { status: canned.orderStatus });
    if (kind === 'transaction') return new Response(canned.txBody, { status: canned.txStatus });
    return new Response(canned.keyStatus === 200 ? canned.keyBody : 'nope', { status: canned.keyStatus });
  }) as typeof fetch;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const TX_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CODE_BEYOND_SAFE = '9515982136481235'; // > Number.MAX_SAFE_INTEGER (9007199254740991)

async function main() {
  dir = await cloneDatabase('oc-viva-');
  process.env.DATA_DIR = path.join(dir, 'data');
  installFetchMock();

  const { eq } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  // the local database can be behind the code: bring the throwaway copy up to date first
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  await migrate(db, { migrationsFolder: './drizzle' });
  const { orders, orderEvents } = await import('../src/lib/db/schema');
  const { startCardPayment, cardProvider } = await import('../src/lib/payments');
  const viva = await import('../src/lib/payments/viva');
  const { availablePaymentMethods } = await import('../src/lib/pricing');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
  const webhook = await import('../src/app/api/payments/viva/webhook/route');
  const returnRoute = await import('../src/app/api/payments/viva/return/route');

  const fakeOrder = (over: Partial<{ id: number; number: string; totalCents: number }> = {}) => ({
    id: 1,
    number: 'OC-TEST-1',
    accessToken: 'secret-access-token',
    totalCents: 1234,
    email: 'buyer@example.com',
    firstName: 'Ιωάννης',
    lastName: 'Τεστ',
    phone: '6900000000',
    ...over,
  });

  console.log('1. Token request');
  const first = await startCardPayment(fakeOrder());
  const tokenCalls = callsOf('token');
  check('token request is POST to the demo accounts host', tokenCalls.length === 1 && tokenCalls[0].url === 'https://demo-accounts.vivapayments.com/connect/token' && tokenCalls[0].method === 'POST', tokenCalls);
  check("token request uses Basic auth 'test-client:test-secret'", tokenCalls[0]?.headers.authorization === basic('test-client', 'test-secret'), tokenCalls[0]?.headers);
  check('token body is grant_type=client_credentials', tokenCalls[0]?.body === 'grant_type=client_credentials', tokenCalls[0]?.body);
  calls.length = 0;
  await startCardPayment(fakeOrder({ id: 2, number: 'OC-TEST-2' }));
  check('a second order within the token lifetime reuses the cached token (no new token request)', callsOf('token').length === 0 && callsOf('order').length === 1, calls.map((c) => c.url));

  console.log('2. Create order request');
  calls.length = 0;
  await startCardPayment(fakeOrder({ number: 'OC-TEST-3', totalCents: 1234 }));
  const orderCall = callsOf('order')[0];
  check('order is POST to demo-api /checkout/v2/orders', orderCall?.url === 'https://demo-api.vivapayments.com/checkout/v2/orders' && orderCall?.method === 'POST', orderCall?.url);
  check('order is sent with the cached Bearer token', orderCall?.headers.authorization === 'Bearer tok-test', orderCall?.headers);
  const body = JSON.parse(orderCall?.body ?? '{}');
  check('amount is the order total in integer cents (1234)', body.amount === 1234 && Number.isInteger(body.amount), body.amount);
  check('merchantTrns equals the order number', body.merchantTrns === 'OC-TEST-3', body.merchantTrns);
  check("sourceCode is '1234'", body.sourceCode === '1234', body.sourceCode);
  check('customer email and fullName are sent', body.customer?.email === 'buyer@example.com' && body.customer?.fullName === 'Ιωάννης Τεστ', body.customer);
  check('no currency field is sent', !('currency' in body), Object.keys(body));

  console.log('3. Order code parsing');
  canned.orderBody = `{"orderCode":${CODE_BEYOND_SAFE}}`;
  const parsed = await startCardPayment(fakeOrder({ number: 'OC-TEST-4' }));
  check('ref is the exact 16-digit order code', parsed.ref === CODE_BEYOND_SAFE, parsed.ref);
  check('the code really exceeds MAX_SAFE_INTEGER (a JSON.parse round trip would corrupt it)', String(Number(CODE_BEYOND_SAFE)) !== CODE_BEYOND_SAFE);
  canned.orderBody = '{"orderCode":9515982136481235}';

  console.log('4. Redirect URL');
  check('demo redirect is https://demo.vivapayments.com/web/checkout?ref=<code>&lang=el', first.redirectUrl === `https://demo.vivapayments.com/web/checkout?ref=${first.ref}&lang=el`, first.redirectUrl);
  // viva.ts reads VIVA_ENV at import time, so the live branch is loaded as a separate module instance
  process.env.VIVA_ENV = 'live';
  const liveSpecifier = '../src/lib/payments/viva.ts?live=1'; // not a literal: the query string only exists to get a fresh module
  const liveViva: typeof viva = await import(liveSpecifier);
  process.env.VIVA_ENV = 'demo';
  calls.length = 0;
  const liveOrder = await liveViva.vivaCreateOrder({ amountCents: 1234, orderNumber: 'OC-TEST-5', email: 'b@example.com', fullName: 'A B', phone: '6900000000' });
  check('live token request goes to the live accounts host', callsOf('token')[0]?.url === 'https://accounts.vivapayments.com/connect/token', calls.map((c) => c.url));
  check('live order goes to the live api host', callsOf('order')[0]?.url === 'https://api.vivapayments.com/checkout/v2/orders', calls.map((c) => c.url));
  check('live redirect is https://www.vivapayments.com/web/checkout?ref=<code>&lang=el', liveOrder.redirectUrl === `https://www.vivapayments.com/web/checkout?ref=${liveOrder.orderCode}&lang=el`, liveOrder.redirectUrl);

  console.log('5. Transaction check');
  calls.length = 0;
  canned.txBody = `{"statusId":"F","amount":12.34,"orderCode":${CODE_BEYOND_SAFE},"merchantTrns":"OC-TEST-6"}`;
  const paid = await viva.vivaRetrieveTransaction(TX_ID);
  const txCall = callsOf('transaction')[0];
  check('transaction is GET .../checkout/v2/transactions/<uuid> with Bearer', txCall?.method === 'GET' && txCall?.url === `https://demo-api.vivapayments.com/checkout/v2/transactions/${TX_ID}` && txCall?.headers.authorization === 'Bearer tok-test', txCall);
  check("statusId 'F' is paid", paid.paid === true && paid.statusId === 'F', paid);
  check('12.34 EUR becomes 1234 cents', paid.amountCents === 1234, paid.amountCents);
  check('orderCode from the transaction keeps its exact digits', paid.orderCode === CODE_BEYOND_SAFE, paid.orderCode);
  canned.txBody = '{"statusId":"F","amount":19.99}';
  check('19.99 EUR (float 1998.9999...) rounds to 1999 cents', (await viva.vivaRetrieveTransaction(TX_ID)).amountCents === 1999);
  canned.txBody = '{"statusId":"F","amount":0.29}';
  check('0.29 EUR (float 28.999...) rounds to 29 cents', (await viva.vivaRetrieveTransaction(TX_ID)).amountCents === 29);
  canned.txBody = '{"statusId":"A","amount":12.34}';
  check("statusId 'A' is not paid", (await viva.vivaRetrieveTransaction(TX_ID)).paid === false);
  canned.txBody = '{}';
  const before = calls.length;
  const badId = await viva.vivaRetrieveTransaction('not-a-uuid').then(() => 'resolved', (e: Error) => e.message);
  check('a non-UUID transaction id is rejected without any fetch', /Invalid Viva transaction id/.test(badId) && calls.length === before, { badId, calls: calls.length - before });

  console.log('6. Webhook GET (verification key)');
  calls.length = 0;
  const getRes = await webhook.GET();
  check('GET answers 200 with {Key: ...}', getRes.status === 200 && JSON.stringify(await getRes.json()) === '{"Key":"verify-key-123"}');
  const keyCall = callsOf('webhook-key')[0];
  check('key request is GET https://demo.vivapayments.com/api/messages/config/token', keyCall?.method === 'GET' && keyCall?.url === 'https://demo.vivapayments.com/api/messages/config/token', keyCall?.url);
  check("key request uses Basic auth 'test-merchant:test-key'", keyCall?.headers.authorization === basic('test-merchant', 'test-key'), keyCall?.headers);
  canned.keyStatus = 500;
  const failedGet = await webhook.GET();
  check('when the key request fails the GET answers 503', failedGet.status === 503, failedGet.status);
  canned.keyStatus = 200;

  console.log('7. Webhook POST');
  const orderA = await addOrder('OC-TEST-VIVA-A', CODE_BEYOND_SAFE, 1999);
  const orderC = await addOrder('OC-TEST-VIVA-C', '9515982136481236', 1999);
  const postJson = (body: string) => webhook.POST(new Request('https://shop.example/api/payments/viva/webhook', { method: 'POST', body }));
  calls.length = 0;
  const ignored = await postJson(JSON.stringify({ EventTypeId: 1798, EventData: { TransactionId: TX_ID, OrderCode: CODE_BEYOND_SAFE } }));
  check('EventTypeId 1798 answers 200 and is ignored', ignored.status === 200 && (await ignored.json()).ignored === true);
  check('EventTypeId 1798 makes no Viva call and changes no order', calls.length === 0 && (await paymentStatusOf(orderA.id)) === 'pending', calls.map((c) => c.url));

  const event = JSON.stringify({ EventTypeId: 1796, EventData: { TransactionId: TX_ID, OrderCode: CODE_BEYOND_SAFE }, Created: '2026-10-18T10:00:00Z' });
  canned.txBody = `{"statusId":"F","amount":19.99,"orderCode":${CODE_BEYOND_SAFE},"merchantTrns":"OC-TEST-VIVA-A"}`;
  const first1796 = await postJson(event);
  check('EventTypeId 1796 answers 200', first1796.status === 200, first1796.status);
  const paidRow = (await db.select().from(orders).where(eq(orders.id, orderA.id)))[0];
  check('the matching order becomes paid after the transaction is re-read from Viva', paidRow.paymentStatus === 'paid' && paidRow.paymentProvider === 'viva' && paidRow.paidAt !== null, paidRow);
  check('the webhook re-reads the transaction (GET to the transactions endpoint)', callsOf('transaction').length >= 1);
  const eventsAfterFirst = (await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderA.id))).length;
  const paidAtFirst = paidRow.paidAt?.getTime();
  const second1796 = await postJson(event);
  const afterSecond = (await db.select().from(orders).where(eq(orders.id, orderA.id)))[0];
  const eventsAfterSecond = (await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderA.id))).length;
  check('a second identical POST answers 200 and changes nothing (idempotent)', second1796.status === 200 && afterSecond.paidAt?.getTime() === paidAtFirst && eventsAfterSecond === eventsAfterFirst, { status: second1796.status, eventsAfterFirst, eventsAfterSecond });

  canned.txBody = `{"statusId":"F","amount":9.99,"orderCode":9515982136481236,"merchantTrns":"OC-TEST-VIVA-C"}`;
  await postJson(JSON.stringify({ EventTypeId: 1796, EventData: { TransactionId: TX_ID, OrderCode: '9515982136481236' } }));
  check('a wrong amount leaves the order unpaid', (await paymentStatusOf(orderC.id)) !== 'paid');

  console.log('8. Closed gates');
  process.env.COMMERCE_ENABLED = 'false';
  calls.length = 0;
  const gateGet = await webhook.GET();
  const gatePost = await postJson(event);
  const gateReturn = await returnRoute.GET(new Request(`https://shop.example/api/payments/viva/return?t=${TX_ID}&s=${CODE_BEYOND_SAFE}`));
  check('COMMERCE_ENABLED=false: webhook GET answers 503', gateGet.status === 503);
  check('COMMERCE_ENABLED=false: webhook POST answers 503', gatePost.status === 503);
  check('COMMERCE_ENABLED=false: return route answers 503', gateReturn.status === 503);
  check('COMMERCE_ENABLED=false: the gated routes make no Viva call', calls.length === 0, calls.map((c) => c.url));
  const startErr = await startCardPayment(fakeOrder({ number: 'OC-TEST-7' })).then(() => 'resolved', (e: Error) => e.message);
  check('COMMERCE_ENABLED=false: startCardPayment throws', /switched off/.test(startErr), startErr);
  check('COMMERCE_ENABLED=false: no order call was made', calls.length === 0, calls.map((c) => c.url));
  delete process.env.COMMERCE_ENABLED;

  const savedVars = { id: process.env.VIVA_CLIENT_ID, secret: process.env.VIVA_CLIENT_SECRET, source: process.env.VIVA_SOURCE_CODE };
  delete process.env.VIVA_CLIENT_ID;
  delete process.env.VIVA_CLIENT_SECRET;
  delete process.env.VIVA_SOURCE_CODE;
  check('without the Viva variables cardProvider() is null', cardProvider() === null, cardProvider());
  const payments = { ...structuredClone(DEFAULT_SETTINGS.payments), card: true };
  const { bankAccounts: _ignored, ...publicPayments } = payments;
  check("without a card provider availablePaymentMethods omits 'card'", !availablePaymentMethods('courier', publicPayments, false).includes('card'));
  check("with a card provider availablePaymentMethods includes 'card' (control)", availablePaymentMethods('courier', publicPayments, true).includes('card'));
  const noProvider = await startCardPayment(fakeOrder({ number: 'OC-TEST-8' })).then(() => 'resolved', (e: Error) => e.message);
  check('without a provider startCardPayment throws', /No card payment provider/.test(noProvider), noProvider);
  process.env.VIVA_CLIENT_ID = savedVars.id;
  process.env.VIVA_CLIENT_SECRET = savedVars.secret;
  process.env.VIVA_SOURCE_CODE = savedVars.source;

  console.log('Mock');
  check('the mock saw no unexpected URL', unexpected.length === 0, unexpected);

  async function addOrder(number: string, paymentRef: string, totalCents: number) {
    const [row] = await db
      .insert(orders)
      .values({
        number,
        accessToken: `at-${number}`,
        paymentMethod: 'card',
        shippingMethod: 'courier',
        email: 'buyer@example.com',
        phone: '6900000000',
        firstName: 'Τεστ',
        lastName: 'Αγοραστής',
        subtotalCents: totalCents,
        totalCents,
        paymentProvider: 'viva',
        paymentRef,
      })
      .returning();
    return row;
  }
  async function paymentStatusOf(id: number) {
    return (await db.select().from(orders).where(eq(orders.id, id)))[0]?.paymentStatus;
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
