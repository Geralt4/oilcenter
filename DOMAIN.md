# oilcenter.gr — keep the name, delete the rest

Runbook for taking the domain over from the old web agency and pointing it at the new site on Railway.
Written 23.09.2026 after the agency forwarded Papaki's hosting activation e-mail. Read top to bottom once;
then work through section 2 in order. Every step says who does it. The client is Ilias (Τσακιρίδης Ηλίας);
"you" is Giannis.

## 1. What we are looking at

**The e-mail is a hosting activation notice, not a domain document.** Papaki bundles a free Plesk hosting package
("Basic - Linux (Free)", server `linux248.papaki.gr`) with every .gr domain it registers. The e-mail is that
package's welcome message, sent to the Papaki *customer* — the agency — and forwarded to us. It lists the Plesk
and FTP passwords in plain text. Nobody logs in with them (nothing in this plan needs them, and Plesk logs every
login with its IP), nobody reuses them anywhere, and they become void when the package is deleted in step 8.

**The domain is the only asset.** Registry WHOIS on 23.09.2026 (grweb.ics.forth.gr):

| | |
| --- | --- |
| Registrar | Papaki (ENARTIA ΜΟΝΟΠΡΟΣΩΠΗ A.E.) |
| Created / last renewed | 03.11.2015 / 01.11.2025 |
| Expires | **02.11.2027** — no hurry, and no reason to accept "urgent" payments from anyone |
| Nameservers | `ns123.papaki.gr`, `ns223.papaki.gr` |
| DNSSEC | off (no DS record) |
| Registrant | **hidden by the .gr registry** — it is either Ilias or the agency; step 0 finds out |

**The domain's DNS lives on the hosting server that is being deleted.** `ns123`/`ns223.papaki.gr`, the e-mail's
`ns1248`/`ns2248`, the old website and `mail.oilcenter.gr` all resolve to `213.158.90.222`, the Plesk box.
Delete the hosting first and the domain stops resolving. That fixes the order below: new DNS first, hosting last.

**Mail records exist but were never used.** The zone has `MX 10 mail.oilcenter.gr` (the same box) and an SPF record
that authorises a third-party relay (`include:_spf.fastmail.gr`) to send as `@oilcenter.gr`. Ilias confirmed no shop
mailbox ever existed (question D2). Both records disappear with the hosting and are replaced by records that say
"this domain sends and receives no mail" — until the day the shop wants an `@oilcenter.gr` sender (section 3).

**The old 2015 site is still live** on that server, with a self-signed certificate. No copy is wanted (decided
23.09.2026). All fifteen of its pages already 301-redirect to the new site (`next.config.ts` → `redirects()`; checked
against the live pages' links on 23.09.2026). If that decision changes, one command before step 8 keeps a copy:
`wget --mirror --page-requisites --convert-links -P old-site "http://www.oilcenter.gr/"`.

## 2. Order of operations

Steps 0–3 are administrative (Papaki), 4–7 technical (Railway + DNS), 8–9 clean-up. Two things cannot be undone:
an owner change in step 2, if one is needed, and the hosting deletion in step 8.

**The goal of steps 0–3 is full rights for Ilias.** In .gr terms that means all five of these at once:

1. He is the **registrant (Φορέας)** in the .gr Registry, i.e. the legal owner. The registrar "may not perform any
   act on a .gr domain without the registrant's prior consent" (EETT regulation 1110/6/2024, ΦΕΚ Β' 2908/2024,
   art. 17 §25).
2. The **registrant e-mail on file is his.** The authorisation code is created only on request and sent only to that
   address (art. 2; registry FAQ). The registry's expiry and renewal notices go there too.
3. The domain sits in **his own Papaki account**, with 2FA on and auto-renew on his card. That is the practical
   control: DNS, renewals, support tickets.
4. He has **tested item 2**: he pressed "Send Authorization Code" and the registry's e-mail reached him. The code
   expires after 14 days (Papaki), so it is nothing to store. What matters is that he can get a fresh one any day and
   move the name to any registrar without anyone's permission (art. 14).
5. The agency has no way in any more: the domain is not in its account, or, if the account was opened in Ilias's
   name, the agency no longer receives its e-mail or knows its password.

Registrant and account holder should both be Ilias, not you. Then he never again depends on a supplier the way he
depends on the agency today, and you work from his account with his permission. Papaki also supports "owner Ilias,
administrator someone else" (case 3 of its help page), but that recreates today's dependency.

### Step 0 — two questions to the agency (you, now), one mailbox search (Ilias)

A Papaki **account** and the domain's **registrant** are two different things, so ask about both. The account is
where the domain is managed: it may be the agency's own account, or one the agency opened in Ilias's name. The
registrant is the legal owner recorded in the .gr Registry. The Plesk and FTP passwords in the forwarded e-mail
belong to neither; they only open the hosting package. Ask in writing, so the answer stays on record. On the phone,
ask the same and request the screenshot afterwards.

> Καλησπέρα σας. Για να περάσει το domain oilcenter.gr πλήρως στον κ. Τσακιρίδη, χρειάζομαι δύο πληροφορίες:
>
> 1. Ο λογαριασμός στο Papaki όπου βρίσκεται το oilcenter.gr είναι δικός σας, της εταιρείας σας, ή είναι
>    λογαριασμός στο όνομα του κ. Τσακιρίδη;
> 2. Στα στοιχεία του domain, ποιος είναι δηλωμένος ως κάτοχος, με ποιο όνομα και ΑΦΜ, και ποιο e-mail κατόχου είναι
>    καταχωρημένο;
>
> Αν γίνεται, στείλτε μου ένα screenshot με τα στοιχεία κατόχου του domain. Μέχρι να τα τακτοποιήσουμε, σας
> παρακαλώ να μην αλλάξει τίποτα στο domain. Ευχαριστώ πολύ!

**Answer 1, 24.09.2026:** the account belongs to the developer of the 2015 site, and he has agreed to hand the domain
over. Answer 2 is no longer needed from him: once the domain is in Ilias's account, the registrant shows there
(step 2). The mailbox search below is now only a fallback.

Meanwhile Ilias searches every mailbox he has used since 2015, the old hotmail first, for **oilcenter.gr**. The
likeliest period is August to November 2025. The registry sends its expiry warnings (91, 61, 31, 16, 6, 3 and 1 days
before) and the renewal notice to the registrar, the registrant and all domain contacts (registry FAQ), and the name
was renewed on 01.11.2025. Such mail in his inbox means his address is on file, a strong sign that he is the
registrant. It is also what the fallback after step 2 relies on. Nothing in those e-mails needs to be clicked.

While waiting: nothing is changed anywhere. The domain is paid up to 02.11.2027.

### Step 1 — act on answer 1 (agency, Ilias)

**If the account is in Ilias's name**, nothing has to move and nobody sends a password. The agency changes the
account's contact e-mail to Ilias's, in both the old and the new Papaki panel, because the two do not sync (Papaki,
«Πώς αλλάζω τα στοιχεία του λογαριασμού μου»). It also switches off any two-factor authentication of its own. Ilias
then sets his own password with «Ξέχασες τον κωδικό σου;» on the login page, turns 2FA on, and changes the username
if it is the agency's e-mail; only the new panel allows that. The e-mail for invoices is separate, and Papaki
support changes it on request.

**If the account is the agency's** (our case, answered 24.09.2026), the domain moves into an account of Ilias's own.
The move comes first and the ownership question second, because that way the developer only has to send one ticket,
plus a signature if step 2 applies. His consent counts when he sends the ticket from his own account, so nobody
needs his passwords.

1. Ilias opens his own Papaki account, with you next to him; ten minutes, no cost: papaki.com → «Δημιουργία
   λογαριασμού». His own e-mail (the new store Gmail once it exists) and a strong unique password. Then
   **two-factor authentication on**: *Λογαριασμός, τιμολόγια και πληρωμές → Two-Factor Authentication*, with an
   authenticator app on his phone (Papaki help, «2nd level authentication»). Note the account's **billing code**;
   Papaki support tells him if he cannot find it.
2. Send the developer the message below with the billing code filled in. It carries the ticket text, so he only has
   to paste it. If he cannot find how, Papaki support takes the same request by phone: 215 215 5000.
3. The developer's ticket moves the administration of `oilcenter.gr` to that billing code. Papaki's help article
   (2.0 panel) describes exactly this, free; the bundled free services, the old hosting included, move with the
   domain, and we delete them in step 8. For a domain still in the old 1.0 panel the article sends him to customer
   service, and the same ticket covers that.

> Καλησπέρα και ευχαριστούμε πολύ που συμφωνείτε. Ο κ. Τσακιρίδης άνοιξε λογαριασμό στο Papaki με
> billing code: **[____]**
>
> Μπορείτε, σας παρακαλώ, να ανοίξετε ένα ticket στο Papaki από τον λογαριασμό σας με αυτό το κείμενο:
>
> «Παρακαλώ μεταφέρετε τη διαχείριση του domain oilcenter.gr στον λογαριασμό Papaki με billing code **[____]**,
> που ανήκει στον κ. Ηλία Τσακιρίδη.»
>
> Η δωρεάν φιλοξενία του domain θα μεταφερθεί μαζί του, και θα την ακυρώσουμε εμείς αργότερα. Μέχρι τότε σας
> παρακαλούμε να μη διαγραφεί και να μην αλλάξει τίποτα. Ευχαριστούμε!

**Invoices:** a Papaki account keeps a single set of billing details, fixed at its first order, and switching from
receipt to invoice later means a new account (Papaki help, «πολλαπλοί λογαριασμοί τιμολόγησης»). At Ilias's first
payment, choose **Τιμολόγιο** with the shop's ΑΦΜ.

### Step 2 — look at the registrant in Ilias's account; change of owner only if it is not him

Once the domain appears in Ilias's account, its page shows the registrant. If it is «Τσακιρίδης Ηλίας», skip to
step 3.

If it is the developer, Ilias orders the change of registrant **from his own account**: the domain → *Domain & DNS →
Αλλαγή ιδιοκτήτη-δικαιούχου*, enters himself as the new owner, and pays 25,70 € + ΦΠΑ 24 % = 31,87 € (Papaki price
list, updated 03.07.2026). Papaki then produces the **LAR letter** («Επιστολή LAR για Αλλαγή Κατόχου», under the
domain's documents). The developer and Ilias both sign it, and each adds a gov.gr υπεύθυνη δήλωση addressed to
«Εναρτια Μονοπρόσωπη Α.Ε.», an ID copy, or a signature certified at a ΚΕΠ. If the developer's business is a company,
its statutes naming the legal representative go too. Everything goes to Papaki by ticket from Ilias's account, and
Papaki says it completes within hours once the documents check out. The regulation calls the transfer declaration
"clear, irrevocable and unconditional" (art. 13), so check Ilias's details before anyone signs.

### If the agency does not answer or refuses (at any of steps 0–2)

With Ilias as registrant the agency is not needed:

- Papaki has a door for owners (its help page, case 2: «Είμαι ο ιδιοκτήτης και θέλω να αναλάβω και τη
  διαχείριση»). Ilias opens a ticket from *his* account, proves he is the registrant (ID or gov.gr υπεύθυνη δήλωση,
  ΑΦΜ), and Papaki moves the domain into his account itself.
- The regulation backs him. At the registrant's request, registrars must send the assignment details to the
  registrant e-mail on file and make the authorisation code available (art. 17 §24). With that code he can move the
  name to any other registrar at any time (art. 14). The new registrar notifies the registry within three working
  days, and the expiry date does not change (registry FAQ).
- If the registrant e-mail on file is the agency's, the registry FAQ sends him to EETT: info@eett.gr, 210 6151000.

With the *agency* as registrant there is no self-service route: a lawyer's letter first, then a complaint to EETT.
Backstop only: 15 days after 02.11.2027 the name becomes free for anyone (registry FAQ), a race we might lose.

### Step 3 — tick the five items of full rights (Ilias, you)

In Ilias's Papaki account, check that the domain is listed and that the registrant is «Τσακιρίδης Ηλίας» with the
shop's ΑΦΜ. The registrant e-mail and phone must be his; change them now if not (only a change of the registrant's
*name* is chargeable, per the registry FAQ). Turn **auto-renew on** with his card; renewal is 29,90 € + ΦΠΑ per two
years at today's prices. Check that 2FA is on.

Then the test: domain → *Domain & DNS → Auth-info Code* → "Send Authorization Code" (old panel: *Domains* → the
domain → "Send by email"). The registry e-mails the owner a link that works once, within six hours; the code it
produces is valid for 14 days (Papaki). If that e-mail reaches Ilias, nobody can hold the name hostage any more.
Nothing else changes yet, and the old site keeps running.

### Step 4 — prepare Railway (you)

1. Check the plan in the Railway dashboard first: the **Trial** plan allows one custom domain per service, **Hobby**
   allows two. We need two (`www` + bare).
2. From the repo root (the project is linked to the CLI):
   ```bash
   railway domain www.oilcenter.gr --service web --port 3000
   ```
   ```bash
   railway domain oilcenter.gr --service web --port 3000
   ```
   Each command prints **two records**: a `CNAME` target of the form `<hash>.up.railway.app` and a `TXT`
   ownership record. Both are mandatory per domain — with the CNAME alone the host answers 404 forever. Keep all four.
3. Both hostnames are already declared in `.railway/railway.ts` (`domains`, port 3000). Nothing to edit; but never
   run `railway config apply` with a `Delete` line in its plan (README → "Hosted preview (Railway)").

### Step 5 — build the new DNS zone next to the old one (you)

Create the zone at the new DNS host *before* touching nameservers, so nothing goes dark. Two options:

**Option A — Papaki's own free DNS (`dns1.papaki.gr` / `dns2.papaki.gr`), fewest moving parts.** Every Papaki domain
includes it; its zone editor (help article of 20.05.2026) lists A, AAAA, CNAME, MX, TXT, SRV, NS, CAA, **ALIAS**, SPF.
Railway has no static IP, so the bare domain cannot use an A record — it needs an ALIAS (or CNAME flattening) at
the apex. Whether Papaki's ALIAS behaves the way Railway wants is untested; step 7 tells us, and Option B is the fallback.

**Option B — Cloudflare (free plan), Railway's documented fallback.** Add `oilcenter.gr` as a zone, enter the
records below (a CNAME at the apex is flattened automatically), keep them **DNS-only (grey cloud)**; if you ever
proxy them (orange), set SSL/TLS to *Full*, never *Full (strict)*. DNSSEC is off at the registry, so nothing to
disable first.

Records, either option (replace the `<…>` values with what step 4 printed):

| Name | Type | Value | Why |
| --- | --- | --- | --- |
| `@` | ALIAS (Papaki) / CNAME (Cloudflare) | `<apex hash>.up.railway.app` | bare domain → Railway |
| `www` | CNAME | `<www hash>.up.railway.app` | the canonical host |
| `_railway-verify` (exact name as printed) | TXT | `railway-verify=<…>` | ownership of the bare domain |
| `_railway-verify.www` (exact name as printed) | TXT | `railway-verify=<…>` | ownership of `www` |
| `@` | MX, priority 0 | `.` | "null MX": this domain receives no mail (RFC 7505) — senders get an immediate bounce instead of retrying for days |
| `@` | TXT | `v=spf1 -all` | nobody may send mail as `@oilcenter.gr` |
| `_dmarc` | TXT | `v=DMARC1; p=reject; rua=mailto:<store Gmail>` | receivers must reject spoofed `@oilcenter.gr` mail |

Do **not** copy the old `A 213.158.90.222`, the old MX or the old SPF (`include:_spf.fastmail.gr`, Hetzner IPv6):
they describe the hosting that is being deleted and the SPF currently lets third parties send as the shop.
Use TTL 300 s during the cutover. Pre-flight before switching:

```bash
dig @dns1.papaki.gr www.oilcenter.gr CNAME +short
```

(or `@<assigned Cloudflare nameserver>`) must return the Railway target, and the same for the apex and the TXT records.

### Step 6 — switch the nameservers (you, in Ilias's Papaki account)

Domain → *Domain & DNS → Διαμόρφωση DNS → Διαχείριση nameservers*: choose Papaki's default pair
(`dns1`/`dns2.papaki.gr`) for Option A, or type Cloudflare's two names for Option B, save. No unlock step exists
for .gr. Papaki quotes 4–48 h for the world to notice; while both zones exist, visitors may see either site.
The moment resolvers pick up the new zone the old static site is gone from the domain — intended.

### Step 7 — go live on the new hostnames (you)

1. Wait until `dig NS oilcenter.gr @1.1.1.1 +short` shows only the new nameservers and
   `railway domain status www.oilcenter.gr` / `railway domain status oilcenter.gr` both report valid DNS with a
   certificate (usually within an hour, worst case 72 h). If a certificate stalls after DNS is right, run
   `railway domain certificate retry <domain>` **once** — never delete and re-add a domain repeatedly, Let's Encrypt
   blocks duplicates for a week.
2. If the bare domain never verifies on Papaki DNS, that is the ALIAS question answered: move to Option B (Cloudflare).
3. Set the canonical origin and redeploy from this worktree (the README explains `--path-as-root`):
   ```bash
   railway variable set SITE_URL=https://www.oilcenter.gr --service web --skip-deploys
   ```
   ```bash
   railway up "$PWD" --path-as-root --service web --ci
   ```
4. Check, from any machine:
   ```bash
   curl -sI "https://oilcenter.gr/products?x=1" | grep -i '^location'
   ```
   → `https://www.oilcenter.gr/products?x=1` (the app's canonical-host redirect in `src/proxy.ts`, 301); the same for
   `https://web-production-2fe57.up.railway.app/`. Then `curl -sI https://www.oilcenter.gr/` → 200 with a
   `strict-transport-security` header; `curl -s https://www.oilcenter.gr/this-does-not-exist | grep canonical` → `www`;
   `https://www.oilcenter.gr/castrol.html` → `/brand/castrol`. In the admin, *Skroutz* no longer warns about a
   temporary address.
5. Only now the launch-day list in `TEST-RUN.md` continues (demo mode off, Search Console, and so on).

### Step 8 — delete the old hosting (Ilias's account; **irreversible**)

After the site has been stable on the new DNS for two or three days. In Papaki's subscriptions page set the hosting
package's renewal to *off*, then open a ticket — Papaki publishes no self-service delete button for this package:

> Παρακαλώ να ακυρωθεί και να διαγραφεί άμεσα το πακέτο φιλοξενίας **Basic - Linux (Free)** του domain
> **oilcenter.gr** (Plesk στον server linux248, FTP, όλα τα e-mail και τα αρχεία). Δεν χρειαζόμαστε αντίγραφο.
> Το ίδιο το domain oilcenter.gr να παραμείνει κατοχυρωμένο, με τους τρέχοντες nameservers και χωρίς αλλαγή στην
> ανανέωσή του. Παρακαλώ επιβεβαιώστε γραπτώς την ημερομηνία διαγραφής.

Do not use Plesk's own "remove domain/website" button before step 7 is complete — that Plesk instance is the
old zone's nameserver. Afterwards it is unnecessary anyway. Verify: `dig A oilcenter.gr +short` no longer contains
`213.158.90.222`; `ftp.oilcenter.gr` and `mail.oilcenter.gr` no longer resolve.

### Step 9 — close the door (Ilias, you)

Confirm the agency's Papaki account lists nothing of the shop's any more; ask the agency in writing to delete any
stored credentials; Ilias changes his Papaki password if anyone else ever saw it; the passwords in the forwarded
e-mail are now void (if Ilias ever reused one of them elsewhere, change that too). Put a reminder for
**September 2027** in a calendar even with auto-renew on. Record the final DNS zone at the end of this file.

## 3. Decisions still open

| Decision | Recommendation |
| --- | --- |
| Whose Papaki account holds the domain | Ilias's, and he is also the registrant (the five items in section 2). You work from his account with his permission. |
| Leave Papaki for another registrar right away? (asked 24.09.2026) | No, it is not simpler. Leaving needs the authorisation code, which goes only to the registrant's e-mail. The new registrar accepts the request only from the registrant (art. 14 §2β), so an owner change is still needed if the developer is the registrant. And Papaki's free services stop when a domain leaves (Papaki, authorisation-code article): the free hosting that serves the domain's DNS today is one, so the name would go dark until new DNS exists. Once Ilias holds the name he can move it to any registrar, any time, without anyone's permission. |
| DNS host | Papaki free DNS first (one supplier); Cloudflare only if the apex refuses to verify. |
| Sender address for the site's e-mail (question C2) | For now **Resend with its shared test sender** (`RESEND_API_KEY` set, `MAIL_FROM` empty): the host blocks outgoing SMTP, so Gmail SMTP is not an option there. Resend then delivers only to its own account mailbox (the store Gmail), which covers the shop's notifications but not mail to customers. No mail records on the domain, the "no mail" records above stay. Later, an `orders@oilcenter.gr` sender means verifying the domain at Resend, setting `MAIL_FROM`, and adding its SPF include + DKIM records at the DNS host, DMARC starting at `p=none`; the null MX must go if replies should arrive. |
| Copy of the old site | None (your decision); one command above if you change your mind before step 8. |

## 4. Code and docs in this branch for the cutover

- `src/proxy.ts` — canonical-host redirect: once `SITE_URL` is set in production, any other host (bare domain,
  preview address) gets a 301 (308 for POST) to the same path on `SITE_URL`. Health check untouched. Tested against a
  production build with forged `Host` / `X-Forwarded-Host` headers.
- `src/app/layout.tsx` — `dynamic = 'force-dynamic'` so the 404 page is not prerendered with a build-time origin
  (Railway exposes variables to a Dockerfile build only through `ARG`); root canonical removed, the home page declares its own.
- `src/app/admin/(panel)/skroutz/page.tsx` — the "temporary address" warning now fires for anything but
  `https://www.oilcenter.gr` (also the bare domain or a typo in `SITE_URL`).
- `src/lib/email.ts` — sender falls back to the SMTP login when `MAIL_FROM` is empty (Gmail).
- `.railway/railway.ts` — both custom domains declared with port 3000 (a bare string would mean port 8080).
- `next.config.ts` — comment on what HSTS `includeSubDomains` means once the apex is served here; `preload` stays out.
- `README.md`, `TEST-RUN.md`, `questions.md` (D1–D3, C2), `.env.example` — updated to this plan.

## 5. Sources (read 23.09.2026)

- Registry WHOIS: https://grweb.ics.forth.gr/public/whois — and the registry FAQ on the registrant, authorisation
  codes, registrar change, the 15-day grace period and who receives which registry e-mail:
  https://grweb.ics.forth.gr/public/faqs?lang=en
- EETT regulation 1110/6/2024 (ΦΕΚ Β' 2908/23.05.2024), codified Greek text: art. 2 (authorisation code), art. 13
  (owner change), art. 14 (registrar change), art. 17 §24–25 (registrar duties), art. 19 §10 (registry details via the code):
  https://grweb.ics.forth.gr/public/assets/docs/el/2908-B-2024-a5047b5eec71c03ecd3007c179bcbff7.pdf
- Papaki, authorisation code (menu paths, six-hour link, 14-day validity):
  https://support.papaki.com/help/how-do-i-find-the-authorization-code-to-transfer-my-domain/?lang=en
- Papaki, moving a domain to another Papaki account (ticket + billing code; 1.0 panel menu; "Περίπτωση 2"):
  https://support.papaki.com/help/pos-mporo-na-metafero-domains-se-kapoion-allo-logariasmo-sto-papaki/
- Papaki, change of holder for .gr (LAR letter, documents, timing): https://support.papaki.com/help/pos-mporo-na-allaxo-idioktiti-sto-domain-moy/
- Papaki price list, updated 03.07.2026, prices without ΦΠΑ 24 % (.gr renewal 29,90 €/2 years, owner change 25,70 €,
  registrar change 0 €): https://www.papaki.com/domain-names-timokatalogos
- Papaki free DNS zone editor and record types: https://support.papaki.com/help/how-can-i-manage-my-dns-records/?lang=en
- Papaki, activating the free DNS / nameserver change: https://support.papaki.com/help/how-do-i-add-nameservers-to-my-domain?lang=en
- Papaki, domain forwarding limits (why the redirect is not done there): https://support.papaki.com/help/how-can-i-forward-my-domain-to-another-page-domain-forwarding?lang=en
- Railway custom domains (CNAME + TXT, apex via ALIAS/flattening, no static IP, Cloudflare notes):
  https://docs.railway.com/networking/domains/working-with-domains and https://docs.railway.com/integrations/api/manage-domains
- Railway CLI `domain` command: https://docs.railway.com/cli/domain — IaC `domains` property: https://docs.railway.com/infrastructure-as-code/reference
- Railway, variables in Dockerfile builds need `ARG`: https://docs.railway.com/builds/dockerfiles
- Plesk cannot hold a CNAME/ALIAS at the apex: https://support.plesk.com/hc/en-us/articles/12377439446039
- Null MX: https://datatracker.ietf.org/doc/html/rfc7505 — parked-domain mail records (SPF `-all`, DMARC reject):
  https://www.m3aawg.org/sites/default/files/doc_files/m3aawg_parked_domains_bcp-2022-06.pdf

Papaki procedures were read on their live help pages on 23.09.2026; Railway apex/TXT/IaC facts were cross-checked
against the live docs the same day. Menu names change — if a button is missing, the ticket texts above work regardless.

## 6. Final DNS zone (fill in after step 7)

_(pending)_
