import type { ShopSettings } from '@/lib/settings';

/** What the footer's service line may promise. Each one is shown only while the shop can really do it. */
export type ShopService = 'courier' | 'pickup' | 'cod' | 'card' | 'bank_transfer';

/**
 * The same rules as checkout (`availablePaymentMethods` in pricing.ts): cash on delivery belongs to courier delivery, card
 * needs a payment provider that is configured on this deployment, bank transfer is its own switch. Pure: the footer is a
 * server component, and the tests call this directly.
 */
export function shopServices(settings: Pick<ShopSettings, 'shipping' | 'payments'>, cardProviderConfigured: boolean): ShopService[] {
  const { shipping, payments } = settings;
  const out: ShopService[] = [];
  if (shipping.courierEnabled) out.push('courier');
  if (shipping.pickupEnabled) out.push('pickup');
  if (shipping.courierEnabled && payments.cod) out.push('cod');
  if (payments.card && cardProviderConfigured) out.push('card');
  if (payments.bankTransfer) out.push('bank_transfer');
  return out;
}
