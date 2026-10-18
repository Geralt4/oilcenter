/*
 * A stand-in for the Viva Smart Checkout API, used by scripts/test-card-flow.ts. The shop reaches it through
 * VIVA_TEST_BASE_URL (src/lib/payments/viva.ts), so the card flow runs end to end without a Viva account.
 *
 * Only the endpoints the shop calls are answered:
 *   POST /connect/token                     OAuth token
 *   POST /checkout/v2/orders                creates a checkout, answers the 16-digit orderCode as raw text
 *   GET  /checkout/v2/transactions/{id}     the transaction as Viva reports it (knobs can distort it)
 *   GET  /api/messages/config/token         webhook verification key
 *   GET  /web/checkout?ref=…                the page the buyer lands on: «Πληρωμή» or «Αποτυχία»
 *   GET  /fake/pay?ref=…  and  /fake/fail?ref=…   what those links do: record the transaction, webhook, redirect back
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type WebhookMode = 'before-return' | 'after-return' | 'none';

export type FakeOrder = { amountCents: number; merchantTrns: string; createdAt: number };

export type FakeTransaction = {
  statusId: 'F' | 'E';
  amountCents: number;
  orderCode: string;
  merchantTrns: string;
};

export type FakeViva = {
  baseUrl: string;
  /** POST /checkout/v2/orders answers 500 while true */
  failCreateOrder: boolean;
  /** amount the transactions endpoint reports (euro cents); null = the real amount */
  reportAmountCents: number | null;
  /** currency the transactions endpoint reports; null = 978 (EUR) */
  reportCurrency: string | number | null;
  /** when the webhook is sent relative to the buyer's redirect back to the shop */
  webhookMode: WebhookMode;
  readonly orders: Map<string, FakeOrder>;
  readonly transactions: Map<string, FakeTransaction>;
  /** POSTs a webhook to the shop and answers its HTTP status */
  sendWebhook(orderCode: string, transactionId: string, eventTypeId?: number): Promise<number>;
  /** registers a paid transaction (for an order code the fake does not know yet, a placeholder order is created) */
  payNow(orderCode: string, opts?: { amountCents?: number }): { transactionId: string };
  close(): Promise<void>;
};

const NO_SUCH_ORDER = 'NO-SUCH-ORDER-E2E';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

export async function startFakeViva(opts: { siteBase: string }): Promise<FakeViva> {
  const siteBase = opts.siteBase.replace(/\/$/, '');
  const orders = new Map<string, FakeOrder>();
  const transactions = new Map<string, FakeTransaction>();
  let nextCode = 5000000000000001n;

  const fake: FakeViva = {
    baseUrl: '',
    failCreateOrder: false,
    reportAmountCents: null,
    reportCurrency: null,
    webhookMode: 'none',
    orders,
    transactions,

    async sendWebhook(orderCode, transactionId, eventTypeId = 1796) {
      // Built by hand: the 16-digit OrderCode must reach the shop as typed, not rounded through a JS number.
      const body = `{"EventTypeId":${eventTypeId},"EventData":{"TransactionId":"${transactionId}","OrderCode":${orderCode}}}`;
      const res = await fetch(`${siteBase}/api/payments/viva/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      await res.text();
      return res.status;
    },

    payNow(orderCode, o) {
      let order = orders.get(orderCode);
      if (!order) {
        order = { amountCents: o?.amountCents ?? 0, merchantTrns: NO_SUCH_ORDER, createdAt: Date.now() };
        orders.set(orderCode, order);
      }
      const transactionId = randomUUID();
      transactions.set(transactionId, {
        statusId: 'F',
        amountCents: o?.amountCents ?? order.amountCents,
        orderCode,
        merchantTrns: order.merchantTrns,
      });
      return { transactionId };
    },

    async close() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };

  /** Answers the buyer's redirect; the webhook goes before or after it, as the knob says. */
  async function redirectWithWebhook(res: ServerResponse, location: string, ref: string, transactionId: string, eventTypeId: number) {
    if (fake.webhookMode === 'before-return') await fake.sendWebhook(ref, transactionId, eventTypeId).catch(() => 0);
    res.writeHead(302, { Location: location });
    res.end();
    if (fake.webhookMode === 'after-return') void fake.sendWebhook(ref, transactionId, eventTypeId).catch(() => 0);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://fake.invalid');
    const method = req.method ?? 'GET';
    const ref = url.searchParams.get('ref') ?? '';

    if (method === 'POST' && url.pathname === '/connect/token') {
      return send(res, 200, JSON.stringify({ access_token: 'fake-token', expires_in: 3600, token_type: 'Bearer' }), 'application/json');
    }

    if (method === 'POST' && url.pathname === '/checkout/v2/orders') {
      if (fake.failCreateOrder) return send(res, 500, '{"error":"fake: order creation refused"}', 'application/json');
      const input = JSON.parse(body) as { amount: number; merchantTrns: string };
      const code = String(nextCode++);
      orders.set(code, { amountCents: input.amount, merchantTrns: input.merchantTrns, createdAt: Date.now() });
      return send(res, 200, `{"orderCode":${code}}`, 'application/json');
    }

    if (method === 'GET' && url.pathname.startsWith('/checkout/v2/transactions/')) {
      const tx = transactions.get(url.pathname.slice('/checkout/v2/transactions/'.length));
      if (!tx) return send(res, 404, '{"error":"not found"}', 'application/json');
      const euros = (fake.reportAmountCents ?? tx.amountCents) / 100;
      const currency = fake.reportCurrency ?? '978';
      const currencyText = typeof currency === 'number' ? String(currency) : JSON.stringify(currency);
      const text = `{"statusId":"${tx.statusId}","amount":${euros},"orderCode":${tx.orderCode},"merchantTrns":${JSON.stringify(tx.merchantTrns)},"currencyCode":${currencyText}}`;
      return send(res, 200, text, 'application/json');
    }

    if (method === 'GET' && url.pathname === '/api/messages/config/token') {
      return send(res, 200, '{"Key":"fake-key"}', 'application/json');
    }

    if (method === 'GET' && url.pathname === '/web/checkout') {
      if (!/^\d{10,20}$/.test(ref) || !orders.has(ref)) return send(res, 404, 'unknown checkout');
      const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Fake Viva checkout</title></head><body>
<h1>Fake Viva checkout</h1>
<p>Κωδικός παραγγελίας: ${ref}</p>
<ul>
<li><a href="/fake/pay?ref=${ref}">Πληρωμή</a></li>
<li><a href="/fake/fail?ref=${ref}">Αποτυχία</a></li>
</ul>
</body></html>`;
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (method === 'GET' && (url.pathname === '/fake/pay' || url.pathname === '/fake/fail')) {
      const order = orders.get(ref);
      if (!/^\d{10,20}$/.test(ref) || !order) return send(res, 404, 'unknown checkout');
      const paid = url.pathname === '/fake/pay';
      const transactionId = randomUUID();
      transactions.set(transactionId, {
        statusId: paid ? 'F' : 'E',
        amountCents: order.amountCents,
        orderCode: ref,
        merchantTrns: order.merchantTrns,
      });
      if (paid) {
        return redirectWithWebhook(res, `${siteBase}/api/payments/viva/return?t=${transactionId}&s=${ref}`, ref, transactionId, 1796);
      }
      return redirectWithWebhook(res, `${siteBase}/api/payments/viva/return?s=${ref}&failed=1`, ref, transactionId, 1798);
    }

    return send(res, 404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'fake viva error');
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.baseUrl = `http://127.0.0.1:${port}`;
  return fake;
}
