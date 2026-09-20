# Oil Center — e-shop

Ηλεκτρονικό κατάστημα για το **Oil Center — Τσακιρίδης Ηλίας** (Σόλωνος 52, Θεσσαλονίκη · 2310 850778).
Replaces the 2015 static site at oilcenter.gr with a full shop: catalogue, cart, checkout, orders, customer
accounts and an admin panel the owner runs himself.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Drizzle ORM on libSQL/SQLite · zustand · zod.
No external services are required to run it.

## Quick start

```bash
npm install
cp .env.example .env.local      # then set AUTH_SECRET and ADMIN_PASSWORD (already done on the dev machine)
npm run setup                   # migrate + seed the catalogue + create the admin user
npm run dev                     # http://localhost:3000   ·   admin: http://localhost:3000/admin
```

Admin login = `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env.local`. Change the password from *Ρυθμίσεις* after the first login.

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | development server / production build / production server |
| `npm run db:migrate` | apply SQL migrations in `drizzle/` (idempotent) |
| `npm run db:seed` | load `catalog/catalog.json` into an **empty** catalogue + create the first admin. `-- --force` replaces the catalogue (never touches orders or customers) |
| `npm run db:reset` | **local only** — delete the SQLite file, migrate, seed |
| `npm run db:generate` | create a new migration after editing `src/lib/db/schema.ts` |
| `npm run admin:create -- <email> <password> [name]` | add an admin or reset a password |
| `npm run catalog:build` | rebuild `catalog/catalog.json` + `public/catalog/*.webp` from the client's photos |
| `npm run test:orders` | order-logic regression test (runs on a throwaway copy of the DB) |
| `npm run lint` / `typecheck` | ESLint / TypeScript |

## ⚠️ Before going live

The shop ships in **demo mode**: a ribbon tells visitors that prices are indicative, and orders are flagged as test
orders. The admin dashboard (`/admin`) shows a live checklist of what is still missing. In short:

1. **Prices are placeholders.** The old site never listed prices, so all 215 were generated from a rough market
   heuristic and are stored with `price_verified = false`. Confirm them in *Τιμές & απόθεμα* — on screen, or export the
   CSV, fill it in Excel and import it back.
2. **43 products are flagged "προς έλεγχο".** Mostly pack sizes that are not printed on the front of the container
   (e.g. Liqui Moly additives) and were inferred from its shape, plus a few labels that were hard to read. Each one
   carries a note explaining what to check.
3. **Product specifications are deliberately conservative.** The client photos are AI-upscaled, so small print on many
   labels is garbled. Only approvals that were clearly legible were recorded; the rest were left empty rather than
   guessed, because a wrong OEM approval means the wrong oil in a customer's engine. Complete them from the
   manufacturers' data sheets.
4. **Opening hours are a guess** (Mon–Fri 08:30–17:00, Sat 09:00–14:00). Correct them and tick "επιβεβαιωμένο" — only
   then are they published to Google via structured data.
2b. The full list of those 43, grouped by what to check, is in [`REVIEW.md`](REVIEW.md).
5. **ΑΦΜ and Αρ. ΓΕΜΗ** are empty. A Greek e-shop must identify the seller (ΠΔ 131/2003 art. 4: trade-register number
   and VAT number; N. 2251/1994: trader identity) — they appear in the footer and the terms page. ΔΟΥ is optional.
   Payment providers also look for these details when they approve a merchant's site. Confirm with the accountant.
6. **Bank account (IBAN)** — only needed *if* bank transfer is offered; it is shown solely to a buyer who picks that
   method (order page + e-mail). Otherwise switch bank transfer off in the settings.
7. **Shipping rates** (3,90 € up to 2 kg, +0,90 €/kg, free over 60 € up to 15 kg, COD +2,00 €) are sensible defaults,
   not the courier's actual contract. Set the real ones.
8. **Legal pages** (terms, privacy, cookies, returns, shipping) are good-faith templates around Greek/EU consumer law.
   They are not legal advice — have a lawyer review them.
9. **E-mail**: set the `SMTP_*` variables. Without them, e-mails are written to `data/outbox/*.html` instead of sent.
10. **Card payments**: see below. Until a provider is configured the "card" option is simply not offered.
11. Turn **demo mode off last** (*Ρυθμίσεις → Λειτουργία καταστήματος*). Product structured data (prices) is only
    exposed to search engines once demo mode is off.

## Card payments

Two adapters are included; a provider switches on as soon as its keys are present (Viva wins if both are set).
**Neither has been exercised against a real merchant account yet — run a full sandbox payment before going live.**

**Viva (viva.com) Smart Checkout** — the usual choice for Greek shops.
Set `VIVA_ENV=demo|live`, `VIVA_CLIENT_ID`, `VIVA_CLIENT_SECRET`, `VIVA_SOURCE_CODE` (+ `VIVA_MERCHANT_ID`, `VIVA_API_KEY`
for webhook verification). In the Viva dashboard, on the payment source, set:

- Success URL: `{SITE_URL}/api/payments/viva/return`
- Failure URL: `{SITE_URL}/api/payments/viva/return?failed=1`
- Webhook "Transaction Payment Created": `{SITE_URL}/api/payments/viva/webhook`

**Stripe Checkout** — set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; webhook endpoint
`{SITE_URL}/api/payments/stripe/webhook`, event `checkout.session.completed`.

Both flows re-verify the payment server-side with the provider's API (the browser redirect is never trusted), check the
paid amount against the order total, and are idempotent, so a return + webhook for the same payment settles it once.

## How it is put together

```
catalog/            labels/*.json (what is printed on each photographed product) → catalog.json (seed data)
drizzle/            SQL migrations
public/catalog/     normalised 1000×1000 product images        public/shop/   shop photos
scripts/            migrate · seed · build-catalog · create-admin · test-orders
src/app/(store)/    storefront pages            src/app/admin/   admin panel          src/app/api/   cart, search, payments
src/components/     store/ · admin/ · ui/
src/lib/            db/ (schema, client) · catalog (read model) · orders · pricing · payments/ · email · settings · images
```

- **Money** is integer cents, VAT included. **The browser never supplies a price**: the cart stores `{variantId, quantity}`
  and checkout re-prices everything from the database, then re-runs the same pure functions in `src/lib/pricing.ts`.
- **Stock** is reserved with an atomic `UPDATE … WHERE stock >= qty`, so the last unit cannot be sold twice. Cancelling
  an order restocks exactly once. Variants are sold freely until the owner opts them into stock tracking.
- **Products have size variants** (1L / 4L / 5L / 20L …), each with its own price, SKU, weight, stock and photo.
- **Search** is accent- and case-insensitive for Greek via a normalised `search_text` column (SQLite's `LIKE` only folds ASCII).
- **Listings** are filtered from a per-request in-memory index with exact facet counts; filter state lives in the URL.
  Comfortable up to a few thousand products; past ~10k move the filtering into SQL inside `src/lib/catalog.ts`.
- **Orders** are reachable by an unguessable link (`/order/OC-10001?t=…`) or by the logged-in owner — never by number alone.
- **Settings** (`/admin/settings`) drive phone, address, map pin, hours, shipping, payment methods and VAT at runtime.
- Client components must never import a module that imports `@/lib/db` — that is why `settings.ts` (pure, shared) and
  `settings.server.ts` (database) are separate files.

## Adding products

*Admin → Προϊόντα → Νέο προϊόν.* Upload photos taken against a light background: the server whitens the backdrop, trims,
centres and converts them to the same 1000×1000 format as the rest of the catalogue (`src/lib/images.ts`).

## Deployment

The app needs Node ≥ 20.9 and **one persistent directory** (`DATA_DIR`) for the SQLite file and uploaded images.

- **Any VPS / Docker host** (Hetzner, Railway, Fly.io, Render with a disk, Coolify…): `docker build -t oilcenter .` then run
  with `-v oilcenter-data:/app/data --env-file .env.production`. The container migrates and seeds (if empty) on start.
  Put Caddy or nginx in front for HTTPS.
- **Serverless (Vercel etc.)**: the filesystem is not persistent, so point `DATABASE_URL` at a Turso database
  (`libsql://…` + `DATABASE_AUTH_TOKEN`; same schema and migrations) and move uploads to object storage
  (`storeUploads` in `src/app/admin/actions.ts` and the `/media` route are the two places to change).

Set `SITE_URL` to the public origin, generate a fresh `AUTH_SECRET` (`openssl rand -base64 48`), and back up
`DATA_DIR` nightly. The in-memory rate limiter assumes a single Node process.

### Hosted preview (Railway)

The preview the owner reviews runs on Railway: project `oilcenter`, service `web`, built from the `Dockerfile`
(`railway.json` sets the builder and the `/api/health` check), with the volume `web-volume` (500 MB) mounted at `/app/data`.

- URL: <https://web-production-2fe57.up.railway.app> — admin at `/admin`. The admin e-mail and password of the hosted
  shop are in the git-ignored `.env.railway.local`; on Railway they are the `ADMIN_EMAIL` / `ADMIN_PASSWORD` variables.
  The password variable is only read when the admin user is first created: change it afterwards from *Admin → Ρυθμίσεις*.
- Ship a new version: `railway up --service web --ci` from this directory (uploads the working tree, honours `.gitignore`).
- Logs: `railway logs --service web --deployment --lines 100`. Variables: `railway variable list --service web`
  (prints secret values — do not paste the output anywhere).
- `SITE_URL` is not set: the app falls back to Railway's `RAILWAY_PUBLIC_DOMAIN`. When the real domain is attached
  (`railway domain www.oilcenter.gr --service web`, then the DNS records it prints), set `SITE_URL=https://www.oilcenter.gr`.
  Railway injects the domain variable only into deployments created **after** the domain exists, so redeploy after adding one.
- The volume survives redeploys: a restart logs "Database already has 175 products — skipping catalogue seed".
  Catalogue edits made in the hosted admin therefore stay; `catalog/catalog.json` is only used for an empty database.
- Railway is retiring `railway.json` in favour of `.railway/railway.ts` on 2026-12-01 (`railway config migrate` shows the
  translation as a dry run). Until it is migrated, a deploy after that date may lose the health check.

Old URLs from the 2015 site (`/castrol.html`, `/contact.html`, …) are 301-redirected in `next.config.ts`.
