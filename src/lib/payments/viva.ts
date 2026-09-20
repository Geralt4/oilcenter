/*
 * Viva (viva.com) Smart Checkout — https://developer.viva.com/smart-checkout/smart-checkout-integration/
 *
 *   1. OAuth2 client-credentials token
 *   2. POST /checkout/v2/orders            → 16-digit orderCode
 *   3. redirect to /web/checkout?ref=…     → customer pays on Viva
 *   4. Viva redirects to the payment source's Success / Failure URL with ?t=<transactionId>&s=<orderCode>
 *   5. GET /checkout/v2/transactions/{t}   → statusId "F" + matching orderCode + amount = paid
 *
 * In the Viva dashboard set the payment source URLs to:
 *   Success:  {SITE_URL}/api/payments/viva/return
 *   Failure:  {SITE_URL}/api/payments/viva/return?failed=1
 *   Webhook (Transaction Payment Created):  {SITE_URL}/api/payments/viva/webhook
 *
 * NOT YET EXERCISED AGAINST A REAL VIVA ACCOUNT — run it end-to-end in VIVA_ENV=demo before going live.
 */

const LIVE = process.env.VIVA_ENV === 'live';
const ACCOUNTS = LIVE ? 'https://accounts.vivapayments.com' : 'https://demo-accounts.vivapayments.com';
const API = LIVE ? 'https://api.vivapayments.com' : 'https://demo-api.vivapayments.com';
const WEB = LIVE ? 'https://www.vivapayments.com' : 'https://demo.vivapayments.com';

export function vivaConfigured(): boolean {
  return Boolean(process.env.VIVA_CLIENT_ID && process.env.VIVA_CLIENT_SECRET && process.env.VIVA_SOURCE_CODE);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const basic = Buffer.from(`${process.env.VIVA_CLIENT_ID}:${process.env.VIVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/connect/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Viva token request failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/** Order codes are 16 digits and can exceed Number.MAX_SAFE_INTEGER, so never let JSON.parse touch them. */
function extractOrderCode(body: string): string | null {
  return body.match(/"orderCode"\s*:\s*"?(\d{10,20})"?/i)?.[1] ?? null;
}

export async function vivaCreateOrder(input: {
  amountCents: number;
  orderNumber: string;
  email: string;
  fullName: string;
  phone: string;
}): Promise<{ orderCode: string; redirectUrl: string }> {
  const res = await fetch(`${API}/checkout/v2/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      amount: input.amountCents,
      customerTrns: `Παραγγελία ${input.orderNumber} — Oil Center`,
      merchantTrns: input.orderNumber,
      customer: { email: input.email, fullName: input.fullName, phone: input.phone, countryCode: 'GR', requestLang: 'el-GR' },
      paymentTimeout: 1800,
      preauth: false,
      allowRecurring: false,
      maxInstallments: 0,
      paymentNotification: false,
      disableCash: true,
      sourceCode: process.env.VIVA_SOURCE_CODE,
    }),
  });
  const text = await res.text();
  const orderCode = extractOrderCode(text);
  if (!res.ok || !orderCode) throw new Error(`Viva create order failed (${res.status}): ${text.slice(0, 300)}`);
  return { orderCode, redirectUrl: `${WEB}/web/checkout?ref=${orderCode}&lang=el` };
}

export type VivaTransaction = { paid: boolean; orderCode: string | null; amountCents: number; statusId: string; merchantTrns: string | null };

export async function vivaRetrieveTransaction(transactionId: string): Promise<VivaTransaction> {
  if (!/^[0-9a-f-]{36}$/i.test(transactionId)) throw new Error('Invalid Viva transaction id');
  const res = await fetch(`${API}/checkout/v2/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Viva retrieve transaction failed (${res.status})`);
  const json = JSON.parse(text) as { statusId?: string; amount?: number; merchantTrns?: string };
  return {
    paid: json.statusId === 'F',
    orderCode: extractOrderCode(text),
    amountCents: Math.round((json.amount ?? 0) * 100),
    statusId: json.statusId ?? '',
    merchantTrns: json.merchantTrns ?? null,
  };
}

/** Viva verifies a webhook URL with a GET that must echo back this key. Needs Merchant ID + API key (basic auth). */
export async function vivaWebhookVerificationKey(): Promise<string> {
  const { VIVA_MERCHANT_ID, VIVA_API_KEY } = process.env;
  if (!VIVA_MERCHANT_ID || !VIVA_API_KEY) throw new Error('VIVA_MERCHANT_ID / VIVA_API_KEY are not set');
  const basic = Buffer.from(`${VIVA_MERCHANT_ID}:${VIVA_API_KEY}`).toString('base64');
  const res = await fetch(`${WEB}/api/messages/config/token`, { headers: { Authorization: `Basic ${basic}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Viva webhook key request failed (${res.status})`);
  return ((await res.json()) as { Key: string }).Key;
}
