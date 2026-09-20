# Products to review before going live

**43 of the 175 products** have one detail I could not confirm from the photos. Nothing is broken — every one
of them is live in the demo shop — but each carries something I *estimated* or *could not read*, so it should
be checked once against the real product on the shelf.

Why this happens: most of the product photos are AI-upscaled, which sharpens the bottle but scrambles small
print. Large text (brand, product line, viscosity) reads fine; tiny text (the volume on the base of a can,
approval codes) often does not. Where I could not read something I did **not** guess silently — I flagged it.

## How to clear an item

1. Admin → **Προϊόντα** → chip **«Προς έλεγχο»** (`/admin/products?filter=review`), or use the direct link in the tables below.
2. Open the product, correct what is wrong (see "What to check").
3. **Delete the text in «Εσωτερικές σημειώσεις»** at the bottom of the form and save.
   The product then drops off this list and off the dashboard checklist.

If you change a pack size, also fix that row's **weight** (shipping is charged by weight — roughly
0,9 kg per litre of oil plus the container) and its **price**.

Links assume the dev server (`http://localhost:3000`). The number in each link is the product's database id.

## Summary

| Group | What is uncertain | Products |
| --- | --- | ---: |
| [A](#a-is-this-the-right-product-5) | Product name / identity — **check these first** | 5 |
| [B](#b-pack-size-missing-3) | Pack size missing (shop currently shows «Τεμάχιο») | 3 |
| [C](#c-jug-4-l-or-5-l-2) | Jug could be 4 L or 5 L | 2 |
| [D](#d-pack-size-estimated-32) | Pack size estimated from the container's shape | 32 |
| [E](#e-specifications-incomplete-1) | Specification line partly unreadable | 1 |
| | **Total** | **43** |

---

## A. Is this the right product? (5)

These matter most: a wrong name or viscosity means a customer orders the wrong oil.

| ☐ | Brand | Product as listed | Shown as | What to check | Edit |
| --- | --- | --- | --- | --- | --- |
| ☐ | Mobil | **Super 3000 10W-40** | 1L / 5L | The label in the photo reads "Super 3000 10W-40 · Super Premium". Mobil's 10W-40 is normally sold as **Super 2000 X1 10W-40** — the upscaling may have changed "2000" into "3000". Check the real bottle and rename if needed. | [/admin/products/96](http://localhost:3000/admin/products/96) |
| ☐ | Selenia | **ECO2** | 1L | Least certain item on the list (≈45 %). The line name reads "ECO" plus one distorted character, and **the viscosity could not be read at all** (probably 0W-20). Fill in the exact name, the SAE grade and the Fiat specification from the bottle. | [/admin/products/136](http://localhost:3000/admin/products/136) |
| ☐ | Selenia | **Digitek Pure Energy** | 1L | The name is legible but **the viscosity and Fiat spec line are not** (probably 0W-30). The product currently has no viscosity, so it does not appear when customers filter by SAE grade. | [/admin/products/135](http://localhost:3000/admin/products/135) |
| ☐ | Motul | **8100 X-cess 5W-40** | 1L / 5L | The 1 L photo reads clearly. The **5 L jug photo** is blurred (≈50 %): confirm the jug really is *X-cess* 5W-40 and not *X-cess gen2* or an *X-clean* variant, which look almost identical. | [/admin/products/110](http://localhost:3000/admin/products/110) |
| ☐ | Mannol | **9966 Radiator Leak-Stop** | 325ml | Neither the 4-digit product code nor the volume is legible. "9966" and "325ml" are my best guess for this bottle — confirm both. | [/admin/products/90](http://localhost:3000/admin/products/90) |

## B. Pack size missing (3)

No volume is printed on the visible side of these metal tins, so the shop shows the neutral label **«Τεμάχιο»**
instead of a size. Replace it with the real size (the two oil tins look like 2 L, but I could not verify that).

| ☐ | Brand | Product | Shown as | What to check | Edit |
| --- | --- | --- | --- | --- | --- |
| ☐ | Petronas Tutela | **Grease MR 3** (NLGI 3) | Τεμάχιο | Net weight of the tin (e.g. 850 g / 1 kg). | [/admin/products/150](http://localhost:3000/admin/products/150) |
| ☐ | Selenia | **Gold Synth 10W-40** — metal tin | Τεμάχιο / 1L | The 1 L bottle is fine. The **metal tin** variant has no size: probably 2 L. | [/admin/products/137](http://localhost:3000/admin/products/137) |
| ☐ | Selenia | **K Power Plus 5W-30** (Jeep Prime Oils) — metal tin | Τεμάχιο | Size of the tin: probably 2 L. | [/admin/products/138](http://localhost:3000/admin/products/138) |

## C. Jug: 4 L or 5 L? (2)

Both brands sell the same jug shape in 4 L and 5 L, and the size is not visible in the photo.

| ☐ | Brand | Product | Shown as | What to check | Edit |
| --- | --- | --- | --- | --- | --- |
| ☐ | Avista | **pace EVO 0W-20 FE** | 5L | Listed as 5 L — could be 4 L. | [/admin/products/18](http://localhost:3000/admin/products/18) |
| ☐ | accelerate | **10W-40 High Power CSS** | 1L / 4L | The 1 L is confirmed. The **jug** is listed as 4 L (it matches the 15W-40 jug, whose label does say 4 L) — could be 5 L. | [/admin/products/2](http://localhost:3000/admin/products/2) |

## D. Pack size estimated (32)

The volume is not printed on the front of the container (or is unreadable), so I used the manufacturer's
standard size for that container. These are very likely correct — a quick look at each shelf settles them.

### Liqui Moly (13) — no volume on the front of any can

| ☐ | Product | Shown as | Edit |
| --- | --- | --- | --- |
| ☐ | Catalytic System Cleaner | 300ml | [/admin/products/52](http://localhost:3000/admin/products/52) |
| ☐ | Common Rail Additive | 250ml | [/admin/products/53](http://localhost:3000/admin/products/53) |
| ☐ | Diesel Particulate Filter Protector | 250ml | [/admin/products/54](http://localhost:3000/admin/products/54) |
| ☐ | Hydraulic Lifter Additive | 300ml | [/admin/products/55](http://localhost:3000/admin/products/55) |
| ☐ | Hypoid Getriebeöl GL5 LS 85W-90 | 1L | [/admin/products/56](http://localhost:3000/admin/products/56) |
| ☐ | Injection Cleaner | 300ml | [/admin/products/57](http://localhost:3000/admin/products/57) |
| ☐ | Motor Oil Saver | 300ml | [/admin/products/59](http://localhost:3000/admin/products/59) |
| ☐ | Pro-Line Diesel System Reiniger | 500ml | [/admin/products/60](http://localhost:3000/admin/products/60) |
| ☐ | Pro-Line Motorspülung (Engine Flush) | 500ml | [/admin/products/61](http://localhost:3000/admin/products/61) |
| ☐ | Radiator Cleaner | 300ml | [/admin/products/62](http://localhost:3000/admin/products/62) |
| ☐ | Radiator Stop Leak | 250ml | [/admin/products/63](http://localhost:3000/admin/products/63) |
| ☐ | Super Diesel Additive | 250ml | [/admin/products/64](http://localhost:3000/admin/products/64) |
| ☐ | Valve Clean | 150ml | [/admin/products/65](http://localhost:3000/admin/products/65) |

### Avista (7) — all assumed to be the 1 L bottle

| ☐ | Product | Shown as | Edit |
| --- | --- | --- | --- |
| ☐ | pace EVO 0W-30 C2 *(photo is also low resolution)* | 1L | [/admin/products/19](http://localhost:3000/admin/products/19) |
| ☐ | peer EVO 75W-90 GL5 | 1L | [/admin/products/23](http://localhost:3000/admin/products/23) |
| ☐ | peer EVO PRIME 75W-80 GL4 PC | 1L | [/admin/products/24](http://localhost:3000/admin/products/24) |
| ☐ | peer EVO PRIME 75W-90 GL4 PC | 1L | [/admin/products/25](http://localhost:3000/admin/products/25) |
| ☐ | pulse 20W-50 4 Stroke | 1L | [/admin/products/26](http://localhost:3000/admin/products/26) |
| ☐ | pulse EVO 10W-40 4 Stroke | 1L | [/admin/products/27](http://localhost:3000/admin/products/27) |
| ☐ | pulse EVO 2 Stroke | 1L | [/admin/products/28](http://localhost:3000/admin/products/28) |

### Mannol (7)

| ☐ | Product | Shown as | Note | Edit |
| --- | --- | --- | --- | --- |
| ☐ | 3002 DOT-4 Brake Fluid | 500ml | Volume not visible; also sold as 1 L. | [/admin/products/73](http://localhost:3000/admin/products/73) |
| ☐ | 4013 AG13 Antifreeze | 5L | Matched to the other Mannol 5 L jugs. | [/admin/products/74](http://localhost:3000/admin/products/74) |
| ☐ | 4213 G13 Coolant | 1L | Matched to the other Mannol 1 L bottles. | [/admin/products/77](http://localhost:3000/admin/products/77) |
| ☐ | 4214 G13+ Coolant | 5L | Matched to the other Mannol 5 L jugs. | [/admin/products/78](http://localhost:3000/admin/products/78) |
| ☐ | 8218 ATF Multivehicle JWS 3309 | 1L | Volume not visible in the photo. | [/admin/products/83](http://localhost:3000/admin/products/83) |
| ☐ | 9956 Diesel Jet Cleaner | 250ml | Volume not visible in the photo. | [/admin/products/88](http://localhost:3000/admin/products/88) |
| ☐ | 9978 Air-Con Fresh | 200ml | The photo shows the box; no volume on it. | [/admin/products/91](http://localhost:3000/admin/products/91) |

### MAG 1 (2) — volume printed but garbled

The other five MAG 1 products read clearly (354 ml / 428 ml). These two bottles have the same shape as the
354 ml ones, so that is what I used.

| ☐ | Product | Shown as | Edit |
| --- | --- | --- | --- |
| ☐ | Lead Substitute | 354ml | [/admin/products/67](http://localhost:3000/admin/products/67) |
| ☐ | Super Concentrated Fuel Injector Cleaner | 354ml | [/admin/products/72](http://localhost:3000/admin/products/72) |

### Petronas Tutela (2) and Motul (1)

| ☐ | Brand | Product | Shown as | Note | Edit |
| --- | --- | --- | --- | --- | --- |
| ☐ | Petronas Tutela | Transmission Gearforce 75W | 1L | Size inferred from the bottle. The GL-4 / GL-5 class could not be read either — add it. | [/admin/products/153](http://localhost:3000/admin/products/153) |
| ☐ | Petronas Tutela | Transmission Technyx 75W-85 | 1L | Same as above. | [/admin/products/155](http://localhost:3000/admin/products/155) |
| ☐ | Motul | 8100 ECO-lite 0W-20 | 1L / 5L | The 5 L is confirmed; the small bottle is assumed to be 1 L. | [/admin/products/107](http://localhost:3000/admin/products/107) |

## E. Specifications incomplete (1)

| ☐ | Brand | Product | Shown as | What to check | Edit |
| --- | --- | --- | --- | --- | --- |
| ☐ | accelerate | **0W-20 GF** (Hybrid) | 1L | I recorded only what was clearly legible: *API SP* and *ILSAC GF-6A*. The rest of the "Spezifikation" line (it appears to list dexos1 Gen 3, Ford and Chrysler approvals) was not readable enough to trust. Copy the full line from the bottle. | [/admin/products/1](http://localhost:3000/admin/products/1) |

---

## Not on this list, but still Ilias's job

- **All 215 prices are placeholders.** That is tracked separately: Admin → **Τιμές & απόθεμα** (yellow rows), or export
  the CSV, fill it in Excel and import it back.
- **Approvals are incomplete on many products, on purpose.** Wherever the small print was scrambled I left the
  specification list short or empty rather than fill it from memory — a wrong OEM approval puts the wrong oil in a
  customer's engine. These products are *not* flagged (there is nothing wrong in them, only something missing).
  Completing them from the manufacturers' data sheets is worthwhile: people search for codes like "VW 504 00".
  The thinnest ones are Castrol (front labels carry almost no approvals), Valvoline, Shell, Selenia and Tutela.
