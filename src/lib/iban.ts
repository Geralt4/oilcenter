/*
 * IBAN helpers (ISO 13616). Pure — safe to import from client components.
 *
 * The IBANs in Admin → Ρυθμίσεις are shown to customers who pay by bank transfer, so a typo is worse than a blank:
 * the two check digits after the country code let us catch nearly every mistyped number.
 */

/**
 * Length of an IBAN per country. Deliberately the SEPA / EEA / UK / Swiss countries only: this is a shop's own account,
 * which sits in the euro payment area (Greece, 27 characters, in practice; neobanks such as Revolut or Wise issue
 * Lithuanian or Belgian ones). A prefix outside this list is far more likely a typo than a real account, and the whole
 * registry would only widen what a typo can slip through as. Add a country here if the shop ever banks elsewhere.
 */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27,
  HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** People paste IBANs with spaces, dashes and lowercase letters ("gr16 0110-1250 …"). Stored without any of them. */
export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** A known country, the length that country uses, and the mod-97 check. An empty string is not an IBAN. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (IBAN_LENGTH[iban.slice(0, 2)] !== iban.length) return false;
  // move the first four characters to the end and read letters as numbers (A = 10 … Z = 35); the whole number mod 97 must be 1.
  // Computed 7 digits at a time so that it never leaves the range of exact integers.
  let rest = 0;
  for (const digits of (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55)).match(/.{1,7}/g)!) {
    rest = Number(`${rest}${digits}`) % 97;
  }
  return rest === 1;
}

/** For display: groups of four, as banks print them. Works on anything stored, valid or not. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})(?=.)/g, '$1 ');
}
