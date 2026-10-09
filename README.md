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
| `npm run test:orders` | order-logic regression test, incl. availability (runs on a throwaway snapshot of the DB) |
| `npm run test:feed` | Skroutz feed regression test: what is listed, valid XML, barcodes (same throwaway snapshot) |
| `npm run lint` / `typecheck` | ESLint / TypeScript |

## ⚠️ Before going live

The shop ships in **demo mode** (hidden from Google, orders flagged as tests) with **online ordering closed**. The
admin dashboard (`/admin`) shows a live checklist of what is still missing. The plan for going public in two steps —
first as a catalogue, later with ordering — is in [`TEST-RUN.md`](TEST-RUN.md). In short:

1. **Some prices are still placeholders.** 157 of 215 are real (see "Prices from the shop's Skroutz listing"); the rest
   were generated from a rough market heuristic and carry `price_verified = false`. **An unconfirmed price is never
   shown**: the storefront says «Καλέστε για τιμή», offers a call button instead of add-to-cart, and the amount is
   zeroed on the server so it cannot leak. Confirm prices in *Τιμές* — on screen, or export the CSV, fill it in Excel
   and import it back.
1b. **Instagram and Skroutz links are empty.** Paste them in *Ρυθμίσεις → Instagram, Facebook & Skroutz* (an Instagram
   `@handle` is accepted too). Filled-in links appear in the header strip, the mobile menu, the footer, next to the map
   (home / about / contact) and in the `sameAs` structured data; empty ones are simply not rendered.
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
5. **ΑΦΜ, Αρ. ΓΕΜΗ and ΔΟΥ** were supplied by the owner on 22.09.2026 (defaults in `src/lib/settings.ts`, data patch
   `2026-09-22-shop-details` for existing databases) and appear in the footer and the terms page, as ΠΔ 131/2003 art. 4
   and N. 2251/1994 require. The same patch keeps a single landline, drops the old fax / mobile / e-mail and marks the
   opening hours confirmed. **The shop's e-mail is empty until the owner's new Gmail arrives** — enter it in
   *Ρυθμίσεις → Στοιχεία*; until then the pages simply omit it and site mail has no recipient (see `ORDERS_NOTIFY_EMAIL`).
6. **Bank account (IBAN)** — only needed *if* bank transfer is offered; it is shown solely to a buyer who picks that
   method (order page + e-mail). Otherwise switch bank transfer off in the settings.
7. **Shipping rates** (3,90 € up to 2 kg, +0,90 €/kg, free over 60 € up to 15 kg, COD +2,00 €) are sensible defaults,
   not the courier's actual contract. Set the real ones.
8. **Legal pages** (terms, privacy, cookies, returns, shipping) are good-faith templates around Greek/EU consumer law.
   They are not legal advice — have a lawyer review them.
9. **E-mail**: set the `SMTP_*` variables. Without them, e-mails are written to `data/outbox/*.html` instead of sent.
10. **Card payments**: see below. Until a provider is configured the "card" option is simply not offered.
10b. **Online ordering is closed** (*Ρυθμίσεις → Λειτουργία καταστήματος → «Το κατάστημα δέχεται online παραγγελίες»*,
    off by default). Visitors can browse, see prices and fill a cart, but the cart and `/checkout` show "οι online
    παραγγελίες ανοίγουν σύντομα — καλέστε μας" and the `placeOrder` action refuses them server-side. A logged-in admin
    still gets the full checkout, and whatever they place is flagged as a test order — that is how to test before launch.
11. **Demo mode** (*Ρυθμίσεις → Λειτουργία καταστήματος*) keeps the site out of Google (`noindex` + robots.txt) and
    flags orders as tests. It can be switched off while ordering stays closed — that is the public *catalogue* of the
    test run. Product structured data carries offers only when demo mode is off **and** ordering is open.

12. **Hazard labelling of chemicals.** 52 products (antifreeze & fluids, additives, sprays, 2-stroke oils) have no
    hazard data yet — see "Borrowed from the competition" → hazard labelling. The dashboard lists it; the legal question
    behind it is F1 in [`questions.md`](questions.md).
13. **The domain.** `oilcenter.gr` is registered at Papaki inside the old web agency's account, together with a free
    hosting package that also serves the domain's DNS and still shows the 2015 site. The handover (owner's own Papaki
    account, domain moved or re-registered to him, DNS rebuilt off the old server, both hostnames on Railway,
    `SITE_URL` set, old hosting deleted last) is the runbook in [`DOMAIN.md`](DOMAIN.md). Nothing public can happen before it.

## Borrowed from the competition (September 2026)

A review of two local competitors (lazaridis-lubricants.gr, todos.gr) produced seven additions. None copies their
material; each is a common technique built from this shop's own data. Everything that needs the owner's input ships
empty or switched off and **renders nothing until he fills it in**. `npm run test:catalog` (73 checks) covers the logic.

- **Viscosity pages** — `/viscosity` and `/viscosity/5w-30`. Filtered listings are `noindex` with `/products` as their
  canonical, so nothing could rank for «λάδια 5W-30»; each SAE grade now has an indexable page whose title, intro and
  "from" price come from the live catalogue (`getViscosities()` in `src/lib/catalog.ts`). Adding any filter turns it
  `noindex`. Grades with ≥ 2 products are in the sitemap; home chips, product pages and the footer link to them.
- **Category facet** — `?cat=` on every listing that is not a category page (so `/brand/castrol` can be narrowed to
  motorcycle oils). A facet the page hides (`?cat=` on a category page, `?visc=` on a viscosity page) is ignored.
- **«Ποιο λάδι χρειάζεται το όχημά μου;»** — `/find-my-oil`. The big parts sites answer this with a licensed vehicle
  database; this shop answers with a person. The form (vehicle, make, model, year, fuel, engine, km, phone) lands in
  *Admin → Μηνύματα* and in the shop's e-mail; `?product=<slug>` carries the product being asked about. All forms now
  go through `src/lib/enquiries.ts`; `contact_messages.kind` (`contact` / `oil-finder` / `quote`) filters the inbox.
- **Product codes** — every size's SKU, manufacturer code and barcode are searchable (added to the in-memory index at
  load time, because *Admin → Skroutz* edits codes without rebuilding `search_text`), shown per size on the product
  page, named in search suggestions, and — for single-size products — sent as `mpn` / `gtin` in the JSON-LD. The
  catalogue has no codes yet (question N5).
- **Hazard labelling + safety data sheets** — `products.hazard` (`src/lib/ghs.ts`): pictograms, signal word, hazard and
  precautionary statements as printed on the pack, an SDS link or uploaded PDF (`DATA_DIR/uploads/sds`, served by
  `/media`, not part of the DB backup — same as photos). Edited in the product form; **public only once «Το έλεγξα με
  τη συσκευασία» is ticked**. Source must be the pack or the manufacturer's SDS (section 2.2), never our AI-upscaled
  photos. Worklist: *Προϊόντα → «Χωρίς σήμανση κινδύνου»*. The nine symbols in `public/ghs/` are the public-domain
  UNECE artwork (via Wikimedia Commons) — official signs, never restyle them. `src/lib/ghs-statements-el.ts` is
  **generated** from the regulation's consolidated Greek text (EU Publications Office, version of 01.07.2026; 245
  statements, identical in the 01.12.2023 text): typing a bare code (`H302`, `P301+P330+P331`) prints the official
  wording. 35 statements are templates the label completes (`H373` organs, `EUH208` substance, `P501` where to dispose)
  — those are never auto-filled; the form asks for the pack's own wording. No product has hazard data yet.
- **Real social proof** — *Ρυθμίσεις → «Κριτικές & ιστορία»*: Google link / rating / count, Skroutz rating / count,
  founding year, typed in exactly as the platforms show them. `<TrustBadges>` renders what is filled (home hero, footer,
  contact, about), each rating linking to the platform. Deliberately **no `aggregateRating`** in the JSON-LD.
- **«Για συνεργεία & επαγγελματίες»** — `/professionals`, behind *Ρυθμίσεις → Λειτουργία καταστήματος* (off = 404, no
  links, the action refuses). A quote form with Greek VAT-number check; the copy promises a quote, not terms.
- **Filter by approval** — `?spec=vw-504-00,mb-229.51`. `src/lib/approvals.ts` turns the specification lines ("as
  printed on the pack") into keys: it merges spellings of the same approval, splits lines naming several, **never
  infers compatibility and never guesses** — an unknown line stays a plain chip. Approvals *narrow* (an oil carrying
  all ticked ones). 45 lubricants have no specification lines yet: *Προϊόντα → «Χωρίς προδιαγραφές»*.

Considered and rejected: a make/model vehicle selector (licensed TecDoc data), on-site product reviews (empty review
blocks look worse than none), newsletter pop-ups, splash loaders, one product page per pack size.

### Pre-filled from the manufacturers' documents (22.09.2026)

Two data files, applied by `scripts/manufacturer-data.ts` at seed time and as data patches (`2026-09-22-*` in
`scripts/patches.ts`), so a fresh database and the hosted one end up the same. Both **only fill gaps**: a product that
already has specs keeps them, a hazard card that exists is never touched, and every entry names the document it came
from. `npm run test:catalog` checks the files against the catalogue and the regulation's table.

- `catalog/manufacturer-specs.json` — specification lines for 29 of the 45 lubricants that had none, copied from the
  current product data sheets: Castrol (portal `msdspds.castrol.com`), Motul (Greek product pages + TDS), Valvoline
  (PI sheets), Mobil 1 ESP 5W-30. "Warranted suitable" / "recommended for" lines were left out; "meets" lines are in.
  Each product's internal note records the source. Still empty (no reachable manufacturer document): Castrol POWER1
  15W-50 / 20W-50 / ULTIMATE 10W-50 (not in Castrol's portal for Greece), Mobil Super 3000 ×3 and Mobil 1 FS ×2
  (mobil.com blocks automated reading), Toyota ×3, Petronas Tutela ×4, Selenia 20K.
- `catalog/hazard-labels.json` — label elements (SDS section 2.2) for 14 of the 53 chemicals, **all `confirmed:
  false`**: Liqui Moly ×11 (Greek SDS via the public `pim.liqui-moly.com/sheets/<article>` endpoint, which lists the
  current sheet per language; the Greek-market article, language line EL-EN-IT, was chosen), Mannol ×3 (Greek SDS
  linked from mannol.de). Bare codes rely on the official wording; template statements carry the sheet's sentence
  (`EUH208 Περιέχει …`, `P501 …`); pictograms are the sheet's, or derived from the hazard classes as CLP Annex I
  prescribes. Discrepancies found on the way sit in the entry's `note` and in the product's internal note (Liqui Moly
  Radiator Stop Leak is a 150 ml product, not 250 ml; Mannol coolants: only the first six P statements copied). Not
  done: Mannol ×13 (their `sct-b2b.com` host refuses automated access; the Greek sheets on `b2b.sct.lt` could only be
  read in part), PRO-TEC ×10 (SDS behind the dealer login), MAG 1 ×7 (US-format sheets in a portal — the Greek
  importer's CLP label is the right source), Motul 2T ×2 (SDS behind a personal-data form), Castrol POWER1 ULTIMATE 2T,
  AISIN, Valeo, Avista, SilverSpin, Liqui Moly coolant. Question F1 in `questions.md` asks the distributors for these.

To redo or extend: put the sheet's section 2.2 into an entry (codes only where the official wording is complete), run
`npm run test:catalog`, then `npm run db:patch` locally — the hosted database picks it up at the next deploy only if
the patch id is new, so add a new `2026-…` patch entry rather than editing the applied one.

## Pre-launch tools

- **Site password** — while the `SITE_PASSWORD` variable is set, `src/proxy.ts` asks for HTTP Basic credentials
  (`SITE_USER`, default `oilcenter`) before showing anything: storefront, admin, images. `/api/health` and
  `/api/payments/*` stay open. Unset the variable on launch day. On Railway the variable must also be listed in
  `.railway/railway.ts`, or the next `railway config apply` deletes it and opens the gate.
- **Statistics** (*Admin → Στατιστικά*) — first-party and cookieless, so no consent banner: `src/lib/track.ts` sends
  beacons to `/api/t`, `src/lib/stats.ts` turns them into daily counters (`stat_counters`). A visitor counts once per day
  via a salted IP + user-agent hash that is deleted the next day. Robots, DNT / Global Privacy Control browsers and
  logged-in admins are not counted. The page shows visitors per day, top products / categories / brands, searches
  **with no results**, sources, devices, clicks on call / directions / Skroutz / social, cart adds and how many people
  reached the closed checkout.
- **"Notify me when online orders open"** — shown on the closed `/checkout` when *Ρυθμίσεις → «Ειδοποιήστε με…»* is on.
  Addresses land in `launch_signups`; the statistics page lists them, deletes one on request and exports a CSV.
- **Backups** — `src/instrumentation.ts` writes a gzipped `VACUUM INTO` snapshot to `DATA_DIR/backups` once a day (14
  kept); *Ρυθμίσεις → Αντίγραφα ασφαλείας* downloads a fresh one. They sit on the same disk as the database: an
  off-site copy is still missing, and product photos uploaded through the admin are not part of the snapshot.

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

## Changing prices

Prices move every few days, so this is the most-used admin screen: *Admin → Τιμές* (`/admin/prices`, also the
"Αλλαγή τιμών" button on the dashboard).

- Type a product, brand or code in the search box (accent-insensitive; `5w40` finds 5W-40 but not 15W-40), type the new
  price in the box, press **Enter** or *Αποθήκευση*. Only the touched rows are sent; the storefront reads prices live,
  so the change is visible immediately. ↑/↓ move between boxes. `/admin/prices?q=motul` deep-links to a search.
- *Αύξηση ή μείωση με ποσοστό* fills the boxes of the rows currently shown (e.g. +3 % on every Motul, rounded to
  10 cents / 50 cents / ending in ,90). Nothing is saved until the owner reviews and presses save. The percentage is
  always taken from the saved price, so pressing the button twice does not compound.
- Safety nets: a change of ±35 % or more asks for confirmation (the usual typo is 4,29 for 42,90), invalid input is
  refused, leaving the page with unsaved edits warns, and the success message offers a one-click *Αναίρεση*.
- Every real change — from this screen, from a product's own page or from a CSV import — is written to the
  `price_changes` table (old price, new price, source, time). The editor shows "άλλαξε 18/9 · ήταν 42,90 €" next to each
  box and lists the 30 latest changes underneath.
- Code: `src/components/admin/price-editor.tsx` (client) and `updatePrices` in `src/app/admin/actions.ts`.

### Prices from the shop's Skroutz listing

On 2026-09-20 the 290 listings of the shop's [Skroutz page](https://www.skroutz.gr/shop/30368/Tsakiridis-Oil-Center/products.html)
were matched by hand to the catalogue: 157 of the 215 SKUs got their real price (140 exact → marked confirmed, 17
probable → price applied but still flagged). The result lives in `catalog/skroutz-prices.json`; the report for the
shop owner — written in Greek: what to double-check, what is still a placeholder, and the 133 Skroutz products the site
does not list yet — is [`SKROUTZ-PRICES.md`](SKROUTZ-PRICES.md).

- `npm run db:seed` applies the file to a fresh database; `npm run prices:skroutz` applies it to an existing one
  (`--dry` previews, `--force` also overwrites prices the owner already confirmed).
- The hosted database got it through **`scripts/patches.ts`** (`npm run db:patch`, part of the container start-up):
  one-time data patches, each recorded in the `settings` table under `dataPatches` so it runs once per database. That
  is the way to ship any future data fix to the hosted shop — `railway ssh` needs an SSH key registered with Railway,
  which has not been set up.
- Skroutz blocks non-browser clients, so the listing was read through a normal browser session; there is no scraper in
  the repo. The durable fix for "two places to update every three days" is the opposite direction — the XML product
  feed below, which Skroutz polls.

## Skroutz XML feed

`/feeds/skroutz.xml` is the product file skroutz.gr reads ([their specification](https://developer.skroutz.gr/products/xml_feed)).
Once Skroutz has the address it downloads the file about every hour (08:00–00:00), so a price saved in *Admin → Τιμές*
reaches Skroutz without being typed a second time. Everything the owner needs is on **Admin → Skroutz**
(`/admin/skroutz`): the address to hand over, an on/off switch, what is in the file and what is left out and why, when
Skroutz last read it, and a quick editor for barcodes and manufacturer codes. **It is built and tested but not connected:**
nobody has given the address to Skroutz, and the switch ships **off** (the address answers 404 to everyone but a
logged-in admin).

- **One `<product>` per pack size.** On Skroutz "…5W-30 1lt" and "…4lt" are separate products and their `<size>` field is
  for clothing only, so the pack goes into the title: brand + name + pack ("Castrol MAGNATEC 5W-40 C3 4L").
- **`<id>` is the SKU.** Skroutz requires an id that never changes and is never reused; the SKU survives a rebuild of
  the database, a row id does not. Renaming a SKU makes Skroutz see a new product — don't, once the feed is connected.
- **Only confirmed prices.** A size whose price is still a placeholder is left out, as are switched-off products and
  sizes, and sizes with counted stock at 0 (Skroutz then shows them as unavailable until they return).
- **Links open on the advertised size:** `/product/<slug>?v=<size id>` preselects the pack (Skroutz spot-checks that the
  page shows the price in the file). The canonical URL stays without the parameter.
- **Barcode (EAN) and manufacturer code (MPN)** are what Skroutz matches products on; both are "required" in their
  spec and the catalogue has none yet. Until they are entered the feed sends the SKU as `<mpn>` and omits `<ean>`;
  Skroutz then falls back to matching by title, which is slower and lands more products in manual review. Entry is
  built for a USB barcode scanner — click the first box, scan, and every scan saves and moves to the next size — and
  there is a CSV import (`sku;ean;mpn`). Barcodes are checked against their check digit (`src/lib/gtin.ts`) here and in
  the product form; a wrong or duplicated one is refused and never sent.
- Availability phrase (one of the four Skroutz recognises) and the quantity declared for sizes whose stock is not
  counted are settings on the same page. Weight, VAT rate, category path and a `<specifications>` block (viscosity,
  type, approvals, pack) come from the catalogue. Paragraphs that talk to the shop's own customer ("…ή καλέστε μας")
  are dropped from `<description>`.
- SkroutzBot cannot log in anywhere, so while `SITE_PASSWORD` locks the site it can read neither the file nor the
  product pages and photos it checks. The admin page warns about this, about demo mode, about a temporary domain and
  about closed ordering. `robots.txt` keeps `/feeds/` out of search engines.
- **Validated on 2026-09-20** at [validator.skroutz.gr](https://validator.skroutz.gr) with a file generated from the
  local catalogue (139 products, `https://www.oilcenter.gr` addresses): *"Your feed is compliant with the Skroutz
  specification"*, no errors, no warnings. The first run had one warning — a top-level category ("Γράσα") counts as a
  partial path — which is why every category path now starts from a common root (`CATEGORY_ROOT`). A second file with
  barcodes on only two products passed as well, so partial barcode coverage does not fail validation. The validator
  could not guess three of our element names by itself (name, image, category) and had to be told in its mapping step;
  when the feed is connected Skroutz's staff do that mapping once. It checks structure and field formats only — it does
  not open the product links or photos.
- Code: `src/lib/skroutz-feed.ts` (builder + fetch log), `src/app/feeds/skroutz.xml/route.ts`,
  `src/app/admin/(panel)/skroutz/page.tsx`, `src/components/admin/codes-editor.tsx`. Test: `npm run test:feed`.

**Connecting it** (after launch on the real domain): switch the feed on → *Λήψη XML* and upload the file to
[validator.skroutz.gr](https://validator.skroutz.gr) → send the address to Skroutz through the merchant panel
(*Βοήθεια → Προϊόντα → Αρχείο XML*); they review it and reply with corrections if they want any. **Ask them first what
happens to the listings the shop has on Skroutz today that are not on this site** (133 when last counted, see
`SKROUTZ-PRICES.md`): as a rule, once a feed is connected the shop shows only what the file contains.

## Availability

The shop does not count stock — nearly every size is "sold freely" — so the only way to say "I have run out of the 4 L"
used to be switching the size off, which hides it. Each pack size now carries an availability the owner sets by hand
(`src/lib/availability.ts`):

| State | The customer reads | Can be bought | Skroutz feed |
| --- | --- | --- | --- |
| `in_stock` (default) | Άμεσα διαθέσιμο | yes | the phrase chosen in *Admin → Skroutz* («Άμεσα διαθέσιμο» or «1 έως 3 ημέρες») |
| `days_1_3` | Διαθέσιμο σε 1–3 ημέρες — comes from the supplier | yes | «Διαθέσιμο από 4 έως 6 ημέρες» |
| `on_order` | Κατόπιν παραγγελίας — call for the lead time | yes | «Διαθέσιμο από 7 έως 12 ημέρες» |
| `unavailable` | Προσωρινά μη διαθέσιμο | **no** — shown with its price, refused by the cart and by `createOrder` | left out |

- **Where it is set:** the select next to every price in *Admin → Τιμές* (saved together with the prices; the chip
  «Όχι άμεσα διαθέσιμα» lists everything that is not on the shelf), the *Διαθεσιμότητα* column of a product's sizes,
  or an `availability` column in the price CSV (the export writes it, the import reads it).
- **Counted stock still wins:** a size whose stock is counted and has reached 0 is unavailable whatever the label says
  (`effectiveAvailability`). The «Τελευταία Ν τεμάχια» warning is unchanged.
- **Where it shows:** the status line under the buy button (with one line of explanation), product cards, cart lines,
  the checkout summary (plus a "this order will take longer" notice), the order page, the order e-mail and the admin
  order page — the last three from a snapshot on `order_items.availability`, so an order keeps what the buyer was told.
  Anything that is simply on the shelf stays quiet everywhere except the product page. Structured data reports
  `InStock` / `BackOrder` / `OutOfStock`.
- Skroutz's phrases promise delivery to the customer's door while ours say when the size is in the shop, which is why
  each state maps one step later than it sounds.
- Every size starts as `in_stock`, which is what the site already claimed before this existed — nothing changes for
  visitors until the owner marks a size. Migration `0004_availability.sql`.

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
(`railway.json` sets the builder and the `/api/health` check until the move to `.railway/railway.ts` described below is
finished), with the volume `web-volume` (500 MB) mounted at `/app/data`.

- URL: <https://web-production-2fe57.up.railway.app> — admin at `/admin`. The admin e-mail and password of the hosted
  shop are in the git-ignored `.env.railway.local`; on Railway they are the `ADMIN_EMAIL` / `ADMIN_PASSWORD` variables.
  The password variable is only read when the admin user is first created: change it afterwards from *Admin → Ρυθμίσεις*.
- Ship a new version: `railway up --service web --ci` from this directory (uploads the working tree, honours `.gitignore`).
- Logs: `railway logs --service web --deployment --lines 100`. Variables: `railway variable list --service web`
  (prints secret values — do not paste the output anywhere).
- `SITE_URL` is not set: the app falls back to Railway's `RAILWAY_PUBLIC_DOMAIN`. The move to `www.oilcenter.gr` — both
  hostnames on the service, DNS off the old Papaki hosting, `SITE_URL=https://www.oilcenter.gr`, redeploy — is the
  step-by-step runbook in [`DOMAIN.md`](DOMAIN.md). Once `SITE_URL` is set, `src/proxy.ts` redirects every other host
  (the bare domain, this preview address) to it.
- The volume survives redeploys: a restart logs "Database already has 175 products — skipping catalogue seed".
  Catalogue edits made in the hosted admin therefore stay; `catalog/catalog.json` is only used for an empty database.
- Anything set on Railway outside the repo (a variable, the custom domain) must also be listed in `.railway/railway.ts`
  once that file is in force — see below.

#### Railway settings: from `railway.json` to `.railway/railway.ts`

Railway stops reading `railway.json` (Config as Code) on **2026-12-01**. Its replacement, `.railway/railway.ts`, is written
and checked but **not applied yet**: the preview was offline on purpose when it was prepared (2026-09-20), and finishing the
move needs a deploy. Until the steps below are done `railway.json` stays in force — the builder, the `/api/health` check
and the restart policy come from it alone; the service on Railway has none of them stored.

What is different: Railway never reads `.railway/railway.ts` on deploy. `railway config apply` compares the file with the live
project and writes the difference into the service settings. The file describes the **whole project, and whatever it
leaves out is deleted**. The file that `railway config migrate` generates lists only the health check — applying that one
would have deleted the service variables and detached the database volume. The file in this repo therefore lists the
volume, its mount and every variable of `.env.example` (as `preserve()`: the value stays on Railway, and a variable that
is not set is left alone), and keeps the restart policy in a raw `deploy` block, which `migrate` silently drops.

Finish the move at the next deploy:

1. `npm install --prefix .railway` — the SDK the CLI needs; it lives there so it never reaches the production image.
2. `railway config plan` has to show `2 to change, 0 to destroy`: `build.builder → "DOCKERFILE"`, and
   `deploy.healthcheckPath`, `healthcheckTimeout`, `restartPolicyType`, `restartPolicyMaxRetries`. The two custom domains
   of [`DOMAIN.md`](DOMAIN.md) show up as `2 to add` unless `railway domain` already created them. **Stop at any `Delete`
   line or any change to `web-volume`** (the shop database) and fix the file instead; never pass `--confirm-destructive`.
   A `Delete variable` line means the variable is missing from the `env` list.
3. `railway config apply` and confirm. It may start a deployment by itself.
4. `git rm railway.json` (do not commit yet), then `railway up --service web --ci`. Only a deploy *without* `railway.json`
   proves the new settings, because that file overrides them.
5. Check all four: the build log (`railway logs --service web --build --lines 200`) shows the Dockerfile build and a health
   check on `/api/health`; `curl https://web-production-2fe57.up.railway.app/api/health` answers `{"ok":true,"products":175}`;
   the runtime log says "Database already has 175 products — skipping catalogue seed"; `railway config plan` reports that
   the configuration is up to date.
6. All four hold: commit the removal and shorten this section. Otherwise `git restore --staged --worktree railway.json` and
   `railway up` again — that is the configuration that was running before.

Afterwards the settings change like this: edit `.railway/railway.ts`, `railway config plan`, `railway config apply`. A new variable
goes into the `env` list, a custom domain into the `domains` list — always as `{ domain, port: 3000 }`, a bare string means
port 8080 — (`railway config pull --json` shows how Railway describes the live project), or the next apply proposes to delete it.

Old URLs from the 2015 site (`/castrol.html`, `/contact.html`, …) are 301-redirected in `next.config.ts`.
