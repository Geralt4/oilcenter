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
};

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

export function discountFor(coupon: AppliedCoupon | null | undefined, subtotalCents: number): number {
  if (!coupon || subtotalCents < coupon.minSubtotalCents) return 0;
  if (coupon.type === 'percent') return Math.min(subtotalCents, Math.round((subtotalCents * coupon.value) / 100));
  if (coupon.type === 'fixed') return Math.min(subtotalCents, coupon.value);
  return 0;
}

/** Courier price by weight, before any free-shipping rule. */
export function courierRateCents(weightGrams: number, cfg: ShippingConfig): number {
  const kg = Math.max(0, weightGrams) / 1000;
  const extraKg = Math.max(0, Math.ceil(kg - cfg.baseWeightKg));
  return cfg.baseCents + extraKg * cfg.perExtraKgCents;
}

export function computeTotals(input: {
  subtotalCents: number;
  weightGrams: number;
  shippingMethod: ShippingMethod;
  paymentMethod: PaymentMethod | null;
  coupon?: AppliedCoupon | null;
  shipping: ShippingConfig;
  vatRate: number;
}): Totals {
  const { subtotalCents, weightGrams, shippingMethod, paymentMethod, coupon, shipping, vatRate } = input;
  const discountCents = discountFor(coupon, subtotalCents);
  const afterDiscount = subtotalCents - discountCents;

  let shippingCents = 0;
  let freeShipping = false;
  let remaining: number | null = null;

  if (shippingMethod === 'courier') {
    const withinWeightCap = shipping.freeMaxWeightKg <= 0 || weightGrams <= shipping.freeMaxWeightKg * 1000;
    const thresholdActive = shipping.freeOverCents > 0 && withinWeightCap;
    const couponFree = coupon?.type === 'free_shipping' && subtotalCents >= coupon.minSubtotalCents;
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

/** Which payment methods make sense for a delivery method, given what the owner has switched on. */
export function availablePaymentMethods(
  shippingMethod: ShippingMethod,
  // bank account details are deliberately not shipped to the browser, so they are not required here
  payments: Omit<PaymentsConfig, 'bankAccounts'>,
  cardProviderConfigured: boolean,
): PaymentMethod[] {
  const out: PaymentMethod[] = [];
  if (shippingMethod === 'courier' && payments.cod) out.push('cod');
  if (shippingMethod === 'pickup' && payments.payInStore) out.push('pay_in_store');
  if (payments.card && cardProviderConfigured) out.push('card');
  if (payments.bankTransfer) out.push('bank_transfer');
  return out;
}
