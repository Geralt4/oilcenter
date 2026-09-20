/*
 * Barcode (EAN / GTIN) helpers. Pure — safe to import from client components.
 *
 * Skroutz matches a shop's products to its own catalogue mainly on the barcode, so a typo is worse than a blank:
 * the last digit of every EAN is a checksum of the others, which lets us catch nearly every mistyped code.
 */

/** Scanners and people add spaces or dashes ("5 201234 567890"). */
export function normalizeGtin(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/** EAN-8, UPC-A (12 digits) or EAN-13 with a correct check digit. Skroutz accepts at most 13 digits. */
export function isValidGtin(raw: string): boolean {
  const code = normalizeGtin(raw);
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // counting from the digit next to the check digit, weights alternate 3, 1, 3, 1…
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
