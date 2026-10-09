/*
 * Availability of a pack size, as the owner sets it. Pure — safe to import from client components.
 *
 * The shop does not count stock (nearly every size is "sold freely"), so until now the only way to say "I have run out
 * of the 4 L" was to switch the size off, which hides it. These four states are chosen by hand per size, in
 * Admin → Τιμές or on the product's own page:
 *
 *   in_stock     on the shelf: leaves the shop today or tomorrow                        (the default)
 *   days_1_3     not on the shelf, comes from the supplier in 1–3 working days
 *   on_order     ordered specially for the customer; ask for the lead time
 *   unavailable  shown with its price, cannot be bought
 *
 * Counted stock still wins: a size whose stock is counted and has reached 0 is unavailable whatever this says.
 */

export const AVAILABILITY = ['in_stock', 'days_1_3', 'on_order', 'unavailable'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export function isAvailability(value: unknown): value is Availability {
  return (AVAILABILITY as readonly unknown[]).includes(value);
}

/** What the customer reads next to the price. */
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: 'Άμεσα διαθέσιμο',
  days_1_3: 'Διαθέσιμο σε 1–3 ημέρες',
  on_order: 'Κατόπιν παραγγελίας',
  unavailable: 'Προσωρινά μη διαθέσιμο',
};

/** One line of explanation under the label. Nothing for "in stock": the delivery rows below it say the rest. */
export const AVAILABILITY_HINTS: Record<Availability, string> = {
  in_stock: '',
  days_1_3: 'Το φέρνουμε από τον προμηθευτή μας σε 1–3 εργάσιμες ημέρες· μετά αποστέλλεται ή παραλαμβάνεται κανονικά.',
  on_order: 'Παραγγέλνεται ειδικά για εσάς. Καλέστε μας για τον χρόνο παράδοσης.',
  unavailable: 'Καλέστε μας για ενημέρωση.',
};

/** The same lines while the site takes no online orders (catalogue mode): nothing is shipped, so nothing says so. */
export const AVAILABILITY_HINTS_IN_STORE: Record<Availability, string> = {
  ...AVAILABILITY_HINTS,
  days_1_3: 'Το φέρνουμε από τον προμηθευτή μας σε 1–3 εργάσιμες ημέρες.',
};

/** Where there is room for two words: product cards, cart lines, and the choices in the admin. */
export const AVAILABILITY_SHORT: Record<Availability, string> = {
  in_stock: 'Άμεσα διαθέσιμο',
  days_1_3: 'Σε 1–3 ημέρες',
  on_order: 'Κατόπιν παραγγελίας',
  unavailable: 'Μη διαθέσιμο',
};

/** Text + dot colours, shared by the product page, the cards and the cart. */
export const AVAILABILITY_TONE: Record<Availability, { text: string; dot: string }> = {
  in_stock: { text: 'text-emerald-700', dot: 'bg-emerald-500' },
  days_1_3: { text: 'text-petrol-500', dot: 'bg-petrol-500' },
  on_order: { text: 'text-amber-700', dot: 'bg-amber-500' },
  unavailable: { text: 'text-red-600', dot: 'bg-red-500' },
};

/** The state that actually applies: counted stock at 0 overrides whatever was chosen by hand. */
export function effectiveAvailability(v: { availability: Availability; trackStock: boolean; stock: number }): Availability {
  return v.trackStock && v.stock <= 0 ? 'unavailable' : v.availability;
}

/** Best state among a product's sizes (a product is "in stock" if any size is), for cards and structured data. */
export function bestAvailability(states: Availability[]): Availability {
  return AVAILABILITY.find((a) => states.includes(a)) ?? 'unavailable';
}
