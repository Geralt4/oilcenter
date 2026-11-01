/* «Για συνεργεία & επαγγελματίες» — the choices of the quote form. Pure module, shared by the client form and the server action. */

export const BUSINESS_TYPES = {
  garage: 'Συνεργείο',
  fleet: 'Στόλος οχημάτων / εταιρεία',
  reseller: 'Κατάστημα / μεταπωλητής',
  agri: 'Αγροτική εκμετάλλευση',
  other: 'Άλλο',
} as const;

export type BusinessType = keyof typeof BUSINESS_TYPES;
