/*
 * Order-logic regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:orders
 * Covers the things that cost real money when they go wrong: overselling, double cancel,
 * payment amount mismatch, duplicate gateway callbacks, coupon maths and shipping tiers.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'oc-test-'));
copyFileSync(path.resolve('data/shop.db'), path.join(dir, 'shop.db'));
process.env.DATABASE_URL = `file:${path.join(dir, 'shop.db')}`;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main() {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  const { coupons, orderEvents, orders, variants } = await import('../src/lib/db/schema');
  const { cancelOrder, createOrder, markOrderPaid } = await import('../src/lib/orders');
  const { computeTotals, courierRateCents } = await import('../src/lib/pricing');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');

  const settings = structuredClone(DEFAULT_SETTINGS);
  const [variant] = await db.select().from(variants).limit(1);
  await db.update(variants).set({ trackStock: true, stock: 2, priceCents: 1000, weightGrams: 1000 }).where(eq(variants.id, variant.id));
  const stock = async () => (await db.select({ s: variants.stock }).from(variants).where(eq(variants.id, variant.id)))[0].s;

  const base = {
    email: 'buyer@example.com', phone: '6900000000', firstName: 'Τεστ', lastName: 'Αγοραστής', shippingMethod: 'courier' as const, paymentMethod: 'cod' as const,
    street: 'Οδός 1', city: 'Θεσσαλονίκη', postalCode: '54624', docType: 'receipt' as const, acceptTerms: true as const,
  };
  const opts = { customerId: null, cardProviderConfigured: false };

  console.log('Stock reservation');
  const first = await createOrder({ ...base, lines: [{ variantId: variant.id, quantity: 2 }] }, settings, opts);
  check('order for the last 2 units is accepted', first.ok, first);
  check('stock is decremented to 0', (await stock()) === 0, await stock());
  const second = await createOrder({ ...base, lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
  check('a further order is refused (no overselling)', !second.ok && second.reason === 'cart_changed', second);
  check('stock never goes negative', (await stock()) === 0, await stock());

  if (!first.ok) throw new Error('cannot continue');
  console.log('Totals');
  // 2 × 10,00 = 20,00 · 2 kg → base rate 3,90 · COD 2,00
  check('subtotal 20,00', first.order.subtotalCents === 2000, first.order.subtotalCents);
  check('shipping 3,90 for 2 kg', first.order.shippingCents === 390, first.order.shippingCents);
  check('COD fee 2,00', first.order.codFeeCents === 200, first.order.codFeeCents);
  check('total 25,90', first.order.totalCents === 2590, first.order.totalCents);
  check('flagged as test order while demo mode is on', first.order.isTest === true);
  check('order number format', /^OC-\d{5,}$/.test(first.order.number), first.order.number);

  console.log('Payment settlement');
  check('wrong amount is rejected', (await markOrderPaid(first.order.id, { provider: 'test', ref: 'x', amountCents: 100 })) === false);
  const afterMismatch = (await db.select().from(orders).where(eq(orders.id, first.order.id)))[0];
  check('…and the order stays unpaid', afterMismatch.paymentStatus === 'pending', afterMismatch.paymentStatus);
  const warned = (await db.select().from(orderEvents).where(eq(orderEvents.orderId, first.order.id))).some((e) => e.message.includes('ΠΡΟΣΟΧΗ'));
  check('…and the mismatch is written to the order timeline', warned);
  check('correct amount settles the order', (await markOrderPaid(first.order.id, { provider: 'test', ref: 'tx1', amountCents: 2590 })) === true);
  check('duplicate callback is a no-op (idempotent)', (await markOrderPaid(first.order.id, { provider: 'test', ref: 'tx1', amountCents: 2590 })) === false);
  const paid = (await db.select().from(orders).where(eq(orders.id, first.order.id)))[0];
  check('paid order moves pending → confirmed', paid.paymentStatus === 'paid' && paid.status === 'confirmed', [paid.paymentStatus, paid.status]);

  console.log('Cancellation');
  check('cancel restocks', (await cancelOrder(first.order.id, 'test')) === true && (await stock()) === 2, await stock());
  check('second cancel does nothing (no double restock)', (await cancelOrder(first.order.id, 'test')) === false && (await stock()) === 2, await stock());

  console.log('Coupons');
  await db.update(coupons).set({ isActive: true, minSubtotalCents: 1000, maxUses: 1, usedCount: 0 }).where(eq(coupons.code, 'WELCOME5'));
  const withCoupon = await createOrder({ ...base, paymentMethod: 'bank_transfer', couponCode: 'welcome5', lines: [{ variantId: variant.id, quantity: 2 }] }, settings, opts);
  check('5% coupon applied (case-insensitive)', withCoupon.ok && withCoupon.order.discountCents === 100 && withCoupon.order.totalCents === 2000 - 100 + 390, withCoupon.ok ? [withCoupon.order.discountCents, withCoupon.order.totalCents] : withCoupon);
  const used = (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0].usedCount;
  check('usage counter incremented', used === 1, used);
  await db.update(variants).set({ stock: 5 }).where(eq(variants.id, variant.id));
  const exhausted = await createOrder({ ...base, couponCode: 'WELCOME5', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
  check('exhausted coupon is refused', !exhausted.ok && exhausted.reason === 'coupon', exhausted);
  check('…without consuming stock', (await stock()) === 5, await stock());

  console.log('Method guards');
  const codPickup = await createOrder({ ...base, shippingMethod: 'pickup', paymentMethod: 'cod', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
  check('cash-on-delivery + store pickup is refused', !codPickup.ok && codPickup.reason === 'invalid_method', codPickup);
  const card = await createOrder({ ...base, paymentMethod: 'card', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
  check('card is refused while no gateway is configured', !card.ok && card.reason === 'invalid_method', card);

  console.log('Shipping tiers');
  const s = settings.shipping;
  check('≤ 2 kg → 3,90', courierRateCents(2000, s) === 390);
  check('2,1 kg → 4,80 (rounds up to the next kg)', courierRateCents(2100, s) === 480, courierRateCents(2100, s));
  check('20 kg drum → 20,10', courierRateCents(20000, s) === 390 + 18 * 90, courierRateCents(20000, s));
  const heavy = computeTotals({ subtotalCents: 10000, weightGrams: 19000, shippingMethod: 'courier', paymentMethod: null, shipping: s, vatRate: 24 });
  check('free shipping is NOT granted above the weight cap', !heavy.freeShipping && heavy.shippingCents > 0, heavy);
  const light = computeTotals({ subtotalCents: 6000, weightGrams: 5000, shippingMethod: 'courier', paymentMethod: null, shipping: s, vatRate: 24 });
  check('free shipping at the 60 € threshold', light.freeShipping && light.shippingCents === 0, light);
  const pickup = computeTotals({ subtotalCents: 1000, weightGrams: 5000, shippingMethod: 'pickup', paymentMethod: 'cod', shipping: s, vatRate: 24 });
  check('pickup never pays shipping or COD', pickup.shippingCents === 0 && pickup.codFeeCents === 0, pickup);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  });
