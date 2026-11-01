import type { DocType, PaymentMethod, ShippingMethod } from '@/lib/db/schema';

/*
 * What the customer has typed into the checkout form, kept in sessionStorage (this tab only, gone when it closes) so that
 * coming back from the card payment page without paying — the Back button — does not leave an empty form. Nothing about a
 * card is ever in the form (the card page belongs to the payment provider), and the terms checkbox is NOT kept: consent is
 * given again on each visit. The order page clears the draft when it opens (components/store/clear-cart.tsx), except for an order cancelled because the card payment could not start.
 * Every access to the storage is guarded: it can be missing, blocked or full (private windows, blocked site data).
 */

export const DRAFT_KEY = 'oilcenter-checkout';

export const DRAFT_FIELDS = ['email', 'phone', 'firstName', 'lastName', 'street', 'city', 'postalCode', 'region', 'notes', 'companyName', 'vatNumber', 'taxOffice', 'companyActivity', 'companyAddress'] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

export type CheckoutDraft = {
  form: Partial<Record<DraftField, string>>;
  shippingMethod?: ShippingMethod;
  paymentMethod?: PaymentMethod;
  docType?: DocType;
};

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;
type Remover = Pick<Storage, 'removeItem'>;

const SHIPPING: readonly string[] = ['courier', 'pickup'];
const PAYMENT: readonly string[] = ['cod', 'bank_transfer', 'card', 'pay_in_store'];
const DOC: readonly string[] = ['receipt', 'invoice'];
const MAX_FIELD = 1000; // the longest field the form takes (the order notes)

/** The session storage of this tab, or null where there is none (server rendering, blocked site data). */
export function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps only what the form can hold: known fields as strings of sane length, and known choices. Anything else is dropped. */
export function sanitizeDraft(value: unknown): CheckoutDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const form: CheckoutDraft['form'] = {};
  const rawForm = typeof raw.form === 'object' && raw.form !== null && !Array.isArray(raw.form) ? (raw.form as Record<string, unknown>) : {};
  for (const key of DRAFT_FIELDS) {
    const v = rawForm[key];
    if (typeof v === 'string') form[key] = v.slice(0, MAX_FIELD);
  }
  const draft: CheckoutDraft = { form };
  if (typeof raw.shippingMethod === 'string' && SHIPPING.includes(raw.shippingMethod)) draft.shippingMethod = raw.shippingMethod as ShippingMethod;
  if (typeof raw.paymentMethod === 'string' && PAYMENT.includes(raw.paymentMethod)) draft.paymentMethod = raw.paymentMethod as PaymentMethod;
  if (typeof raw.docType === 'string' && DOC.includes(raw.docType)) draft.docType = raw.docType as DocType;
  return draft;
}

export function readDraft(storage: Reader | null = sessionStore()): CheckoutDraft | null {
  try {
    const text = storage?.getItem(DRAFT_KEY);
    return text ? sanitizeDraft(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function writeDraft(draft: CheckoutDraft, storage: Writer | null = sessionStore()): void {
  try {
    // rebuilt from the known fields, so that nothing else (a stray property) can end up in the storage
    storage?.setItem(DRAFT_KEY, JSON.stringify(sanitizeDraft(draft) ?? { form: {} }));
  } catch {
    // storage full or blocked: the form simply is not remembered
  }
}

export function clearDraft(storage: Remover | null = sessionStore()): void {
  try {
    storage?.removeItem(DRAFT_KEY);
  } catch {
    // nothing to do
  }
}
