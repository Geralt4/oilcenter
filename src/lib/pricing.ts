/*
 * Pure order maths. No server imports: the checkout UI uses these for live totals and the
 * server re-runs exactly the same functions on fresh DB prices before an order is accepted.
 */
import type { CouponType, PaymentMethod, ShippingMethod } from '@/lib/db/schema';
import type { ShopSettings } from '@/lib/settings';

export type ShippingConfig = ShopSettings['shipping'];
export type PaymentsConfig = ShopSettings['payments'];

export type AppliedCoupon = {
  code: string;
  type: CouponType;
  value: number;
  minSubtotalCents: number;
  /** the cart lines the coupon applies to; null = the whole order */
  variantIds: number[] | null;
};

export type CouponLine = { variantId: number; lineTotalCents: number };

export type Totals = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  codFeeCents: number;
  totalCents: number;
  vatCents: number;
  freeShipping: boolean;
  /** cents still needed to unlock free shipping; null when it cannot apply (disabled / too heavy / pickup) */
  freeShippingRemainingCents: number | null;
};

/** What the coupon works on: the whole subtotal, or only the lines it is limited to. */
export function eligibleSubtotalCents(coupon: AppliedCoupon, subtotalCents: number, lines?: CouponLine[]): number {
  if (!coupon.variantIds) return subtotalCents;
  const ids = new Set(coupon.variantIds);
  return (lines ?? []).reduce((sum, l) => (ids.has(l.variantId) ? sum + l.lineTotalCents : sum), 0);
}

export function discountFor(coupon: AppliedCoupon | null | undefined, subtotalCents: number, lines?: CouponLine[]): number {
  if (!coupon) return 0;
  const eligible = eligibleSubtotalCents(coupon, subtotalCents, lines);
  if (eligible <= 0 && coupon.variantIds) return 0;
  if (eligible < coupon.minSubtotalCents) return 0;
  if (coupon.type === 'percent') return Math.min(eligible, Math.round((eligible * coupon.value) / 100));
  if (coupon.type === 'fixed') return Math.min(eligible, coupon.value);
  return 0;
}

/** Courier price by weight, before any free-shipping rule. */
export function courierRateCents(weightGrams: number, cfg: ShippingConfig): number {
  // in whole grams: «2,2 kg − 1,2 kg» in floating point is 1.0000000000000002 and would be charged as 2 extra kilos
  const extraGrams = Math.max(0, weightGrams) - Math.round(cfg.baseWeightKg * 1000);
  const extraKg = Math.max(0, Math.ceil(extraGrams / 1000));
  return cfg.baseCents + extraKg * cfg.perExtraKgCents;
}

export function computeTotals(input: {
  subtotalCents: number;
  weightGrams: number;
  shippingMethod: ShippingMethod;
  paymentMethod: PaymentMethod | null;
  coupon?: AppliedCoupon | null;
  /** needed when the coupon is limited to some products */
  lines?: CouponLine[];
  shipping: ShippingConfig;
  vatRate: number;
}): Totals {
  const { subtotalCents, weightGrams, shippingMethod, paymentMethod, coupon, lines, shipping, vatRate } = input;
  const discountCents = discountFor(coupon, subtotalCents, lines);
  const afterDiscount = subtotalCents - discountCents;

  let shippingCents = 0;
  let freeShipping = false;
  let remaining: number | null = null;

  if (shippingMethod === 'courier') {
    const withinWeightCap = shipping.freeMaxWeightKg <= 0 || weightGrams <= shipping.freeMaxWeightKg * 1000;
    const thresholdActive = shipping.freeOverCents > 0 && withinWeightCap;
    const eligible = coupon ? eligibleSubtotalCents(coupon, subtotalCents, lines) : 0;
    const couponFree = coupon?.type === 'free_shipping' && eligible >= coupon.minSubtotalCents && (!coupon.variantIds || eligible > 0);
    if (couponFree || (thresholdActive && afterDiscount >= shipping.freeOverCents)) {
      freeShipping = true;
    } else {
      shippingCents = courierRateCents(weightGrams, shipping);
      if (thresholdActive) remaining = shipping.freeOverCents - afterDiscount;
    }
  }

  const codFeeCents = shippingMethod === 'courier' && paymentMethod === 'cod' ? shipping.codFeeCents : 0;
  const totalCents = afterDiscount + shippingCents + codFeeCents;
  const vatCents = Math.round(totalCents - totalCents / (1 + vatRate / 100));

  return {
    subtotalCents,
    discountCents,
    shippingCents,
    codFeeCents,
    totalCents,
    vatCents,
    freeShipping,
    freeShippingRemainingCents: remaining,
  };
}

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cod: 'Αντικαταβολή',
  bank_transfer: 'Τραπεζική κατάθεση',
  card: 'Πιστωτική / χρεωστική κάρτα',
  pay_in_store: 'Πληρωμή στο κατάστημα',
};

export const SHIPPING_LABELS: Record<ShippingMethod, string> = {
  courier: 'Αποστολή με courier',
  pickup: 'Παραλαβή από το κατάστημα',
};

/** Smallest amount the card gateways accept (Viva 0,30 €, Stripe 0,50 €): below it a card checkout can never be paid. */
export const CARD_MIN_CENTS = 50;

/** Which payment methods make sense for a delivery method, given what the owner has switched on. */
export function availablePaymentMethods(
  shippingMethod: ShippingMethod,
  // bank account details are deliberately not shipped to the browser, so they are not required here
  payments: Omit<PaymentsConfig, 'bankAccounts'>,
  cardProviderConfigured: boolean,
  /** the order total without a COD fee (what a card would be charged); omitted = not known yet */
  cardTotalCents?: number,
): PaymentMethod[] {
  const out: PaymentMethod[] = [];
  if (shippingMethod === 'courier' && payments.cod) out.push('cod');
  if (shippingMethod === 'pickup' && payments.payInStore) out.push('pay_in_store');
  if (payments.card && cardProviderConfigured && (cardTotalCents === undefined || cardTotalCents >= CARD_MIN_CENTS)) out.push('card');
  if (payments.bankTransfer) out.push('bank_transfer');
  return out;
}
