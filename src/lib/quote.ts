/* «Για συνεργεία & επαγγελματίες» — the choices of the quote form. Pure module, shared by the client form and the server action. */

export const BUSINESS_TYPES = {
  garage: 'Συνεργείο',
  fleet: 'Στόλος οχημάτων / εταιρεία',
  reseller: 'Κατάστημα / μεταπωλητής',
  agri: 'Αγροτική εκμετάλλευση',
  other: 'Άλλο',
} as const;

export type BusinessType = keyof typeof BUSINESS_TYPES;

/** Greek VAT numbers are 9 digits with a mod-11 check digit. '' is fine (the field is optional); a typo is not. */
export function isValidAfm(value: string): boolean {
  const afm = value.replace(/^EL/i, '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(afm) || afm === '000000000') return false;
  const sum = [...afm.slice(0, 8)].reduce((acc, d, i) => acc + Number(d) * 2 ** (8 - i), 0);
  return (sum % 11) % 10 === Number(afm[8]);
}
