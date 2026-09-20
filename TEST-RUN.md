# Test run — what has to happen

**The plan.** Put the new site on `oilcenter.gr` as a public *catalogue* — products, prices, phone, map — with online
ordering closed, keep it up for 6–8 weeks, measure traffic and demand, then decide whether to open online orders.

**Where we are (20/9/2026).** The ordering side is already built and switched off (*Admin → Ρυθμίσεις → «Το κατάστημα
δέχεται online παραγγελίες»*). 157 of 215 prices are real (from Skroutz). The Railway preview is offline.

Legend: **[dev]** our work · **[you]** · **[Ilias]** · `→ D1` = waits for that answer in section 5.
All the questions of section 5 are in Greek, with room for each answer, in [`questions.md`](questions.md) — same codes.

## 1. Before launch

### Site behaviour — [dev] — built and tested locally on 20/9/2026, not deployed (the site is offline)
- [x] **Test-run mode**: demo mode can now be switched off while ordering stays closed — no "δοκιμαστική λειτουργία" ribbon, visible to Google, top strip says online orders have not opened yet
- [x] **Unconfirmed prices are hidden**: «Καλέστε για τιμή» and no add-to-cart until the price is confirmed in *Admin → Τιμές*
- [x] Products are not advertised to Google as buyable while ordering is closed (structured data without offers)
- [x] **Statistics page in the admin** — Greek, no cookies, so no consent banner: visits per day, where they come from, phone vs desktop, top products and categories, what people type in the search box (especially searches with **no results**), add-to-cart, how many reach the closed checkout, clicks on call / directions / Skroutz / Instagram
- [x] "Notify me when online orders open" sign-up on the closed checkout — on by default, switch in *Ρυθμίσεις* `→ C3`
- [x] Privacy and cookies pages updated for the statistics and the sign-up; terms carry a catalogue-mode note (still to be read by the lawyer)
- [x] Password on the whole site until launch day: set `SITE_PASSWORD` on the host `→ needs a password chosen by you`

### Content — [Ilias] answers, [dev] applies
- [ ] Business identity in the footer: ΑΦΜ, Αρ. ΓΕΜΗ, legal name `→ B1–B4`
- [ ] Real opening hours `→ H1`
- [ ] The 17 probable Skroutz matches confirmed, the 58 remaining prices filled in (or left as «Καλέστε για τιμή») `→ P1, P2`
- [ ] Name / pack fixes the Skroutz listing pointed to `→ P3`
- [ ] Marketing claims and About text approved `→ B5, T3`
- [ ] Instagram link `→ L1`

### Safety net — [dev]
- [x] Automatic nightly database backup, kept 14 days (runs inside the live server; first one 30 s after it starts)
- [x] "Download backup" button in the admin (*Ρυθμίσεις → Αντίγραφα ασφαλείας*)
- [ ] A copy of the backups **outside** Railway — needs a storage account `→ D4`. Until then: download one by hand now and then. Photos uploaded through the admin are not in the snapshot yet.
- [ ] Uptime check on `/api/health` with an e-mail alert `→ C1` (an external service; nothing to build)
- [ ] E-mail sending (SMTP), so contact-form messages and sign-ups actually arrive `→ C1, C2` (the code is there; it needs the account and DNS records)
- [ ] Move `railway.json` to Railway's new config format (their deadline: 1/12/2026) — **prepared** in `.railway/railway.ts`, not applied: applying it starts a deployment, so it waits until the site may come back up. Steps in the README.

### Domain — [you] / [Ilias], then [dev]
- [ ] Find out who controls `oilcenter.gr` and get DNS access `→ D1`
- [ ] Make sure no mailbox on the domain breaks `→ D2`
- [ ] Keep a copy of the old site before replacing it `→ D3`
- [ ] Railway plan active on the account that will own the site `→ D4`

## 2. Launch day — [dev], about two hours
- [ ] Bring the app back up, set `SITE_URL=https://www.oilcenter.gr`, attach `www` and the bare domain, add the DNS records, wait for the certificate
- [ ] Check: old `.html` addresses redirect, canonical links, sitemap, robots.txt, phone and map links on a real phone
- [ ] Switch off demo mode, remove the site password, leave ordering **closed**
- [ ] Google Search Console: verify the domain, submit the sitemap `→ L3`
- [ ] Point everything at the site: Google Business Profile, Instagram bio, Facebook page, Skroutz shop profile, a QR code at the counter `→ L2` — without these, two months of traffic will be too thin to read

## 3. During the test run (6–8 weeks)
- [ ] [Ilias] keeps prices current in *Admin → Τιμές* (and on Skroutz, until the feed below exists)
- [x] [dev] Skroutz XML feed, so a price is changed once and Skroutz follows — **built, tested locally and passed Skroutz's own validator (20/9/2026: compliant, no warnings); switched off, not connected.** *Admin → Skroutz* has the address, the switch, what is left out and why, and the barcode editor. README → "Skroutz XML feed".
- [ ] [Ilias] Barcodes (EAN) and manufacturer codes for every size — *Admin → Skroutz*, ideally with a USB barcode scanner (about 25 €): scan, and it saves and moves to the next size. Skroutz matches products on these; without them more products wait in its manual review `→ N5`
- [ ] [you / Ilias] Connect the feed: site public on the real domain → switch the feed on → send the address through the Skroutz merchant panel. **Before that, ask Skroutz what happens to the 133 listings that are not on the site yet** `→ N4, P5`
- [ ] [dev] Add the missing products as photos arrive, best sellers first `→ P5`
- [x] [dev] Availability labels — **built and tested locally (20/9/2026), not deployed.** Per size: «Άμεσα διαθέσιμο» (default) / «Σε 1–3 ημέρες» / «Κατόπιν παραγγελίας» / «Μη διαθέσιμο» (shown, cannot be bought, not sent to Skroutz). Set next to each price in *Admin → Τιμές*. README → "Availability".
- [ ] [Ilias] Mark the sizes he does not keep on the shelf — everything starts as «Άμεσα διαθέσιμο» `→ P6`
- [ ] [dev] Go through the 43 flagged products with Ilias (`REVIEW.md`) `→ P4`
- [ ] [you] Report at week 4 and week 8: visits, sources, top products, searches with no results, closed-checkout hits, sign-ups, calls / directions clicks
- [ ] [you + Ilias] Go / no-go against the target agreed in `T2`

## 4. Start now, because it takes weeks — needed only to open online orders
- [ ] [Ilias] Card payments: merchant application (Viva or his bank) — they want ΑΦΜ / ΓΕΜΗ and the legal pages visible on the site `→ N1`
- [ ] [Ilias] Courier contract and real rates; do they take 20 L drums and liquids? `→ N2`
- [ ] [Ilias] Accountant: how receipts / invoices for web orders will be issued (myDATA) `→ N3`
- [ ] [Ilias] Lawyer review of terms, privacy, returns
- [ ] [dev] Connect the card provider in its sandbox, real order e-mails, automated checkout test that runs on every change, then flip the ordering switch

## 5. Questions — answer one by one

Where there is a default, "OK" is a complete answer.

### Domain and accounts — these gate everything
- **D1.** Who manages `oilcenter.gr` (which company — Papaki, Top.Host, Pointer…)? Does Ilias have the login, or whoever built the old site?
- **D2.** Is any e-mail address on the domain in use (`something@oilcenter.gr`)?
- **D3.** May the old site be replaced completely on launch day? (We keep a copy.)
- **D4.** *(you)* Should hosting stay on your Railway account or move to one Ilias owns? Who pays (about 5–10 $ a month, plus roughly 1 $ for backup storage)?

### Business identity — shown in the footer
- **B1.** ΑΦΜ
- **B2.** Αρ. ΓΕΜΗ
- **B3.** ΔΟΥ (optional)
- **B4.** Exact registered name. Default: «Τσακιρίδης Ηλίας».
- **B5.** Address, phones, e-mail as shown today: Σόλωνος 52, 546 44 Θεσσαλονίκη · 2310 850778 · 6977 440388 · fax 2310 850267 · iliastsakiridis@hotmail.com. Anything to change or remove (is the fax still in use)? Does he approve the line «Τιμές χονδρικής, ακόμα και για αγορές λιανικής»?

### Opening hours
- **H1.** Real hours per day. Default (a guess): Mon–Fri 08:30–17:00, Sat 09:00–14:00, Sun closed. Any midday break or summer hours?

### Prices and catalogue
- **P1.** The 17 probable matches in `SKROUTZ-PRICES.md` section 1: correct, or which are not?
- **P2.** The 58 sizes of section 2: real prices now, or show «Καλέστε για τιμή» during the test run? Default: «Καλέστε για τιμή».
- **P3.** Confirm: (a) "Mobil Super 3000 10W-40" is really **Super 2000 X1**; (b) the Mannol air-filter oil is code **9964**; (c) the Selenia Gold can of unknown size is the **2 L**; (d) pack size of Selenia K Power Plus 5W-30; (e) Tutela MR3 grease is **850 g**; (f) Mobil Super 3000 XE 5W-30 is **4 L** (as on Skroutz) or 5 L.
- **P4.** When can he go through the 43 flagged products (`REVIEW.md`)? About an hour together.
- **P5.** The 133 products that are on Skroutz but not on the site: does he want them added? Can he photograph them (plain wall, phone is fine) or get pack shots from his distributors? Which 20–30 sell most?
- **P6.** Availability: every size now says «Άμεσα διαθέσιμο» until he changes it (*Admin → Τιμές*, the box next to each price). Which sizes are not on the shelf — brought from the supplier in 1–3 days, ordered specially, or not available at all? Are «1–3 ημέρες» the right words for his supplier, and what should «Κατόπιν παραγγελίας» promise? Does he keep stock counts anywhere?

### Links and Google
- **L1.** Instagram profile link.
- **L2.** Is the Facebook page still active (facebook.com/TsakiridisOilCenter)? Does he have access to the shop's Google Business Profile (the listing on Google Maps) — with which Google account?
- **L3.** *(you)* Which Google account should own Search Console — his or yours?

### Communication
- **C1.** Which e-mail address should receive contact-form messages and alerts, and is it checked daily? Default: iliastsakiridis@hotmail.com.
- **C2.** *(you)* Which sender address for the site's e-mails? Default: `info@oilcenter.gr` through a mail service (needs the DNS access of D1).
- **C3.** Does he want the "notify me when online orders open" sign-up? It collects e-mail addresses, so he becomes responsible for them. Default: yes.

### Test-run decisions
- **T1.** Start date and length. Default: start as soon as section 1 is done, run 8 weeks, review at week 4.
- **T2.** What result means "open online orders"? Suggestion: at least 30 visitors reaching the closed checkout or 15 sign-ups in a month.
- **T3.** Since which year does the shop operate? Is he an official dealer for any brand? Better photos of the shop, and a logo file if one exists?

### For opening orders later — not needed for the test run
- **N1.** Does he already take cards in the shop (which provider or bank)?
- **N2.** Which courier ships his Skroutz orders today, and at what rates?
- **N3.** How does he issue receipts for Skroutz orders today (cash register, software)?
- **N4.** How does he update prices on Skroutz today — by hand in the merchant panel, or from a file? Are his Skroutz orders placed through Skroutz itself (Marketplace)?
- **N5.** Who has the login of the Skroutz merchant panel (Χώρος Συνεργατών)? Can he enter the barcode and the manufacturer's code of every size in *Admin → Skroutz* — does he have a barcode scanner, or will he type them?
