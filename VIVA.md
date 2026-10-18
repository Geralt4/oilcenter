# Viva card payments — pre-draft

Assessment of taking card payments through Viva (viva.com) once the shop opens. Written 18.10.2026. **Nothing here is
switched on and nothing in the application changed for it**: the site stays a website. Read top to bottom once; sections 4
and 7 are the to-do lists. Facts taken from Viva's own documentation and price list carry their source; anything I could not
confirm is marked **UNCONFIRMED** and collected in section 9.

## 1. Verdict

**Possible, and most of it already exists.** `src/lib/payments/viva.ts` is a Viva *Smart Checkout* adapter: the customer is
sent to Viva's hosted payment page, so card numbers never reach our server. The return page, the webhook and the "mark the
order paid" logic are written, and every payment is re-checked with Viva before an order is marked paid (the browser
redirect is never trusted). Viva's current documentation describes the same flow the adapter uses; no deprecation of any
endpoint it calls was found.

**Can one developer build and maintain it? Yes, with two conditions.**

1. **Close the money gaps before opening** (section 4: items 1–3 are *must-fix*). They are small, about 3–5 days of work
   with tests, but they are the cases where a customer pays and the shop does not notice, or the other way round.
2. **Run it once against Viva's free demo account** (section 6). The adapter has never talked to a real Viva server; until
   it has, "works" means "matches the documentation". The new `npm run test:viva` proves the second statement only.

**Ongoing load is low:** a look at Viva's release notes every few months, an eye on failed webhooks, and settling the odd
"paid at Viva, not in the shop" case by hand. At the expected volume, refunds are done in Viva's dashboard (section 4,
item 5). The owner, not the developer, has to open and verify the Viva merchant account (section 5).

## 2. How a payment flows

1. Checkout creates the order (status pending, payment pending) and `startCardPayment` asks Viva to create a *payment order*
   for the total in cents (`POST /checkout/v2/orders`). The order number goes along as `merchantTrns`.
2. Viva answers with an order code; the customer is redirected to Viva's checkout (`/web/checkout?ref=<code>`), where Viva
   handles 3-D Secure (PSD2) and the payment methods.
3. Viva sends the customer back to `/api/payments/viva/return`, which asks Viva for the transaction, and only if it is
   finished (`statusId` `F`) marks the order paid and shows `/order/<number>`.
4. In parallel Viva calls `/api/payments/viva/webhook` (event 1796, "Transaction Payment Created"). The webhook also
   re-fetches the transaction and settles the order if it is not already settled. Whichever arrives first wins; the second
   changes nothing.
5. `markOrderPaid` checks that the amount equals the order total, sets the order paid and sends the confirmation e-mail once.

## 3. What is in the code today

| Part | Where | State |
| --- | --- | --- |
| Smart Checkout adapter (token, order, redirect, transaction check) | `src/lib/payments/viva.ts` | written, never run against Viva |
| Return page / webhook | `src/app/api/payments/viva/{return,webhook}/route.ts` | written; return is rate-limited, webhook is not |
| Mark paid (idempotent, amount check) | `markOrderPaid` in `src/lib/orders.ts` | tested (`test:orders`) |
| Attempt history, outcomes, alerts | `src/lib/payments/attempts.ts`, `recordPayment` in `src/lib/orders.ts`, `settle.ts` | tested (`test:orders`, `test:viva`) |
| Adapter, routes, gates | — | `npm run test:viva` (mocked network) and `npm run test:card` (real browser against a fake Viva server) |
| Switches | `COMMERCE_ENABLED`, `VIVA_*` keys, Admin → Ρυθμίσεις | all three keep it off today |

## 4. Gaps, ranked

Code for gaps 1–4 and 6–10 was written on 18.10.2026 and is covered by mocked-network tests; it has still never talked to Viva. Everything is behind the same switches, so the shop behaves exactly as before until the e-shop opens. The Stripe routes keep their old lookup (same weakness as gap 1, not touched). Stripe attempts are recorded too, but the Stripe routes never mark them, so a Stripe attempt that stays `created` does not mean unpaid.

Effort S ≈ hours, M ≈ a day or two. "Money risk" is what goes wrong if it is left as it is.

| # | Gap | Money risk | Effort | Verdict | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **Retrying a payment overwrites the stored Viva order code** (`retryCardPayment`, `src/app/(store)/checkout/actions.ts`). If the customer then pays an older, still-open checkout tab (each stays open 30 minutes), neither route can find the order: money taken, order stays pending. Fix: keep every attempt, or fall back to `merchantTrns` (the order number, already sent) when the code is unknown. | customer charged, no paid order | M | **must-fix** | **done** (attempt history + `merchantTrns` fallback; a second payment on an older checkout is flagged as a double charge and the owner is told) |
| 2 | **A late payment lands on a cancelled order.** Unpaid card orders are cancelled after 2 hours and their stock released (`orders.ts`); `markOrderPaid` does not look at the status, so a payment after that marks a cancelled order paid. Fix: detect it and alert the owner instead of marking it paid. | paid order with no stock reserved | S | **must-fix** | **done** (recorded as received, order stays cancelled, owner alerted) |
| 3 | **A wrong amount only writes a log line** and nobody is told; the currency is not checked. Fix: owner e-mail on any mismatch, currency check. | partial/odd payments unnoticed | S | **must-fix** | **done** (owner e-mail once per incident; currency checked when Viva reports one) |
| 4 | **Failed payments leave no record** — only event 1796 is handled. Viva's event 1798 ("Transaction Failed") is ignored. Note 1798 does not fire for cancelled payments or failed 3-D Secure, and the customer may retry and succeed later. Fix: record it on the order. | none (support questions) | S | should-fix | **done** (webhook 1798, one event per checkout) |
| 5 | **No refunds in the application.** `cancelOrder` only restocks; the `refunded` status exists but nothing sets it. Start with refunds by hand in Viva's dashboard plus a manual mark. Doing it from the admin needs the Basic-auth refund call. | manual work | M | optional | not done (manual in Viva) |
| 6 | **Abandoned-order cleanup runs only when someone opens the admin dashboard** and never asks Viva first. Fix: check with Viva before cancelling; run on a schedule. | cancelling an order that was paid | S | should-fix | **done** (hourly job; skips orders with a fresh attempt) |
| 7 | **The webhook has no rate limit and no IP allow-list**, and each POST costs a call to Viva. | abuse / noise | S | should-fix | **done** (60/min limit; optional `VIVA_WEBHOOK_IPS`) |
| 8 | **The Viva transaction id is only in the event text**, not in a column, which makes reconciliation and refunds slower. | slower support | S | should-fix | **done** (`orders.payment_transaction_id`) |
| 9 | **A paid payment that matches no order** (Viva reports money for a checkout we cannot find) left only a log line. It is now kept in `unmatched_payments`, the shop is e-mailed once, and it shows on the admin dashboard until it is marked handled. | payment with no trace | M | should-fix | **done** |
| 10 | **Admin could not see payment problems**, and the «paid» checkbox could undo a card payment. Orders with a payment problem now sit on a dashboard list (and a nav count, and an orders filter) until marked handled; the payment status is a select with «Επιστροφή χρημάτων» for refunds done by hand in Viva; un-paying a card payment is refused. | missed alerts | M | should-fix | **done** |

Not a gap but a decision: installments (δόσεις) are off in the code (`maxInstallments: 0`). Viva offers 2–36 installments
to Greek merchant accounts; the owner decides whether to want them (section 8).

## 5. What the owner has to do

1. **Open and verify a Viva merchant account** (sole trader or company). In Greece onboarding is online: identity through
   gov.gr plus a remote ID check, business details pulled from the registry, companies declare owners of 25 % or more and
   sign digitally. Viva says verification "can take only a few minutes"; the real approval time for an e-shop is
   **UNCONFIRMED**. Source: euhelp.viva.com (verification and onboarding articles).
2. In the dashboard create a **payment source** ("Add Website/App"): the site's domain without protocol, integration method
   "Redirection/Native Checkout v2", Success URL `{SITE_URL}/api/payments/viva/return`, Failure URL
   `{SITE_URL}/api/payments/viva/return?failed=1`. The 4-digit source code becomes `VIVA_SOURCE_CODE`.
3. Copy the Smart Checkout **client id and secret** (`VIVA_CLIENT_ID`, `VIVA_CLIENT_SECRET`) and, under Settings → API
   Access, the **merchant id and API key** (`VIVA_MERCHANT_ID`, `VIVA_API_KEY`, used for the webhook handshake and refunds).
   Where exactly the client credentials live is **UNCONFIRMED**.
4. Register the **webhook** (Settings → API Access → Webhooks): URL `{SITE_URL}/api/payments/viva/webhook`, events 1796 (payment created) and
   1798 (payment failed). Viva verifies the URL by asking it for a key, which the route already answers.
5. Tick "Allow refunds" for the API access if refunds will ever be issued from the admin.

Never paste any of these values into chat or commit them: they go into the Railway service variables
(`railway variable set KEY --stdin --skip-deploys`) and must stay in the `keep` list of `.railway/railway.ts`.

## 6. Test with the demo account (nothing live is touched)

Viva's sandbox is self-service: https://demo.vivapayments.com/en/signup (two-factor code is always `111111`). Demo has its
own credentials, payment source and webhook. Minimum test payment is 30 cents; use the test cards in
https://developer.viva.com/getting-started/sandbox-demo-account.

`npm run test:card` already runs the whole customer journey in a real browser against a fake Viva server written from
Viva's documentation (`scripts/fake-viva.ts`, pointed at through the test-only `VIVA_TEST_BASE_URL`). It proves our side;
the demo run below proves that the fake behaves like the real thing, so any difference found there is fixed in both.

1. Put the **demo** keys in a local, git-ignored environment (not Railway): `VIVA_ENV=demo`, the four `VIVA_*` values,
   `COMMERCE_ENABLED=true`, and turn ordering on in the local admin.
2. The webhook needs a public URL: use a tunnel to the local server, and register that URL in the demo dashboard.
3. Walk through: successful payment; payment declined; closing the tab and paying later; retry after a failure (this is
   gap 1); an abandoned order. Check each against the order page, the admin and the e-mails.
4. Record what differs from the documentation in section 9 and fix `viva.ts` accordingly.

## 7. Maintenance, in practice

- **Every few months:** skim https://developer.viva.com/releasenotes/2026 for changes to the calls we use. Recent entries
  (2025–2026) added fields (`disableSurcharge`, incremental pre-auth) and Apple Pay on every browser; none touched our flow.
- **After any deploy that touches payments:** `npm run test:viva` and `npm run test:orders`.
- **When the e-shop is open:** a weekly glance at orders that are pending with the card method for more than 2 hours, and
  at the webhook log lines; a monthly comparison of Viva's transaction export with paid orders.
- **Credentials:** rotate the API key if anyone who had it leaves; the client secret likewise.
- **Money disputes:** refunds and chargebacks are handled in Viva's dashboard.

## 8. Costs and Greek specifics

Viva Greece's published price list (https://www.viva.com/en-gr/pricing; negotiated pricing exists, confirm before signing):
online cards from domestic/EEA consumers 2.19 % + €0.24 per transaction; domestic consumer cards up to €20 at 0.50 %
(Law 5167/2024); commercial and non-EEA cards interchange + scheme fees + 1.16 % (Amex 2.95 %); IRIS 0.60 %; Klarna
4.99 % + €0.35; refunds cost the acceptance fee + €0.30, cancellations are free.

- **IRIS:** accepting it has been mandatory for Greek shops since 1 December 2025; it is part of Smart Checkout and needs
  no work from us.
- **Methods:** cards, Apple Pay, Google Pay, Viva Wallet, IRIS, PayPal, Klarna and others appear depending on the account
  and category; some need activation by Viva (**UNCONFIRMED** which, for this shop).
- **Installments:** 2–36, Greek merchant accounts only; the customer picks, or we force a number. Minimum amount per
  installment is **UNCONFIRMED**.
- **PCI and 3-D Secure:** the hosted redirect keeps card data off our server; Viva does the 3-D Secure (PSD2) step. The
  lightest PCI questionnaire (SAQ A) is the expected one for a full redirect, but Viva does not say so (**UNCONFIRMED**).
- **Settlement:** Viva advertises real-time settlement; Viva Wallet payments are documented as next day. Actual timing for
  this account is **UNCONFIRMED**.

## 9. Unconfirmed — to check in the dashboard or with Viva

1. Where the Smart Checkout client id and secret are, and whether demo and live each need their own.
2. Whether the transaction endpoint reports the currency (the code checks it only when a `currencyCode`/`currency` field is present; without one it cannot refuse a non-euro payment), and whether the webhook's `Amount` is in euros or cents (Viva's example shows euros; the adapter treats the re-fetched
   transaction amount as euros).
3. The current list of webhook source IP addresses (copy it from Viva's webhooks page into `VIVA_WEBHOOK_IPS`; unset = no allow-list).
4. Whether the refund call (`DELETE /api/transactions`, Basic auth) is being deprecated and has an OAuth equivalent.
5. Minimum amount and fees for installments on Greek cards.
6. Real settlement time for online cards on this account.
7. The shop's actual pricing and which payment methods need manual activation for its category.
8. Real approval time for an e-shop and whether Viva reviews the website first.
9. The PCI questionnaire type for this setup.
10. Whether AADE/myDATA rules require linking online card payments to receipts.

## 10. Switching it on — and off again

Order on the day the e-shop opens: (1) re-run all tests (`test:viva`, `test:orders`, `test:admin`, `test:card`); (2) demo run
(section 6); (3) real account and its payment source and webhook; (4) set the live keys and `VIVA_ENV=live` on Railway;
(5) remove `COMMERCE_ENABLED=false`; (6) turn ordering on in Admin → Ρυθμίσεις; (7) place and refund one real small order.

Two things to remember on that day:
- **The domain.** Viva binds the payment source (and the Success/Failure/Webhook URLs) to the address the shop really
  answers on. If `oilcenter.gr` still points at the old site, either move the domain first, or set the payment source up
  with the Railway address and change it when the domain moves; `SITE_URL` must match whichever it is.
- **Railway variables.** Every variable set on Railway must also be in the `keep` list of `.railway/railway.ts`, or the next
  `railway config apply` deletes it (read `railway config plan` first). That includes the `VIVA_*` keys and, if used,
  `VIVA_WEBHOOK_IPS`. `VIVA_TEST_BASE_URL` is test-only: it must never be set on a server, and the startup check refuses to
  boot with it when `VIVA_ENV=live`.

**Off again at any moment:** set `COMMERCE_ENABLED=false` (orders, accounts and payments refuse server-side), or unset the
`VIVA_CLIENT_ID` key (card disappears from checkout and is refused). Orders already paid stay paid.
