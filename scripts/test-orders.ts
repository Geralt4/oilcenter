/*
 * Order-logic regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:orders
 * Covers the things that cost real money when they go wrong: overselling, double cancel,
 * payment amount mismatch, duplicate gateway callbacks, coupon maths and shipping tiers.
 */
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cloneDatabase } from './test-db';

let dir = '';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function main() {
  dir = await cloneDatabase('oc-test-');
  const { eq, ne } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db');
  // the local database can be behind the code: bring the throwaway copy up to date before anything reads `sales`
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  await migrate(db, { migrationsFolder: './drizzle' });
  const { coupons, orderEvents, orders, variants } = await import('../src/lib/db/schema');
  const { cancelOrder, createOrder, markOrderPaid } = await import('../src/lib/orders');
  const { computeTotals, courierRateCents } = await import('../src/lib/pricing');
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings');

  const settings = structuredClone(DEFAULT_SETTINGS);
  const [variant] = await db.select().from(variants).limit(1);
  await db.update(variants).set({ trackStock: true, stock: 2, priceCents: 1000, weightGrams: 1000, priceVerified: true }).where(eq(variants.id, variant.id));
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

  console.log('Unconfirmed prices');
  const [other] = await db.select().from(variants).where(ne(variants.id, variant.id)).limit(1);
  await db.update(variants).set({ trackStock: false, priceCents: 1234, priceVerified: false }).where(eq(variants.id, other.id));
  const placeholder = await createOrder({ ...base, lines: [{ variantId: other.id, quantity: 1 }] }, settings, opts);
  check('a size whose price is not confirmed cannot be ordered', !placeholder.ok && placeholder.reason === 'cart_changed', placeholder);
  await db.update(variants).set({ priceVerified: true }).where(eq(variants.id, other.id));
  const confirmed = await createOrder({ ...base, lines: [{ variantId: other.id, quantity: 1 }] }, settings, opts);
  check('…and can be once the owner confirms it', confirmed.ok && confirmed.order.subtotalCents === 1234, confirmed);

  console.log('Availability set by hand');
  const { resolveCartLines } = await import('../src/lib/catalog');
  const { orderItems } = await import('../src/lib/db/schema');
  const { bestAvailability, effectiveAvailability } = await import('../src/lib/availability');
  // `other` is sold freely (stock not counted) and has a confirmed price from the block above
  await db.update(variants).set({ availability: 'unavailable' }).where(eq(variants.id, other.id));
  const gone = await createOrder({ ...base, lines: [{ variantId: other.id, quantity: 1 }] }, settings, opts);
  check('a size marked «Μη διαθέσιμο» cannot be ordered', !gone.ok && gone.reason === 'cart_changed', gone);
  const [goneLine] = await resolveCartLines([{ variantId: other.id, quantity: 3 }]);
  check('…and the cart drops it like a sold-out size', goneLine.quantity === 0 && goneLine.issue === 'out_of_stock', goneLine);
  await db.update(variants).set({ availability: 'on_order' }).where(eq(variants.id, other.id));
  const special = await createOrder({ ...base, lines: [{ variantId: other.id, quantity: 2 }] }, settings, opts);
  check('a size «Κατόπιν παραγγελίας» can be ordered', special.ok, special);
  const specialItems = special.ok ? await db.select().from(orderItems).where(eq(orderItems.orderId, special.order.id)) : [];
  check('…and the order remembers what the buyer was told', specialItems.length === 1 && specialItems[0].availability === 'on_order', specialItems[0]?.availability);
  check('counted stock at 0 beats the label', effectiveAvailability({ availability: 'in_stock', trackStock: true, stock: 0 }) === 'unavailable');
  check('uncounted stock follows the label', effectiveAvailability({ availability: 'days_1_3', trackStock: false, stock: 0 }) === 'days_1_3');
  check('a product is as available as its best size', bestAvailability(['unavailable', 'on_order', 'days_1_3']) === 'days_1_3' && bestAvailability([]) === 'unavailable');
  await db.update(variants).set({ availability: 'in_stock' }).where(eq(variants.id, other.id));

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

  console.log('Targeted coupons and sales');
  const { and, inArray, isNotNull } = await import('drizzle-orm');
  const { salePriceCents, bestSale, matchesTargets } = await import('../src/lib/discounts');
  const { getProductBySlug } = await import('../src/lib/catalog');
  const { buildSkroutzFeed } = await import('../src/lib/skroutz-feed');
  const { findCoupon } = await import('../src/lib/orders');
  const { categories, products, sales } = await import('../src/lib/db/schema');

  const flat = { productIds: [], brandIds: [], categoryIds: [] };
  check('a 20% sale on 10,00 is 8,00', salePriceCents(1000, { type: 'percent', value: 20 }) === 800);
  check('a fixed 3,00 sale on 10,00 is 7,00', salePriceCents(1000, { type: 'fixed', value: 300 }) === 700);
  check('a fixed sale that is not below the price does not apply', salePriceCents(1000, { type: 'fixed', value: 1000 }) === null && salePriceCents(1000, { type: 'fixed', value: 1200 }) === null);
  check('a percent sale leaving less than one cent does not apply', salePriceCents(1, { type: 'percent', value: 90 }) === null);
  const item = { productId: 7, brandId: 3, categoryPath: [11, 10] };
  const overlapping = [
    { id: 1, type: 'percent' as const, value: 10, ...flat, brandIds: [3] },
    { id: 2, type: 'fixed' as const, value: 300, ...flat, productIds: [7] },
  ];
  const best = bestSale(1000, item, overlapping);
  check('of two overlapping sales the lower price wins', best?.priceCents === 700 && best?.saleId === 2, best);
  check('empty targets match every product', matchesTargets(flat, item));
  check('a product id matches', matchesTargets({ ...flat, productIds: [7] }, item) && !matchesTargets({ ...flat, productIds: [8] }, item));
  check('a brand matches', matchesTargets({ ...flat, brandIds: [3] }, item) && !matchesTargets({ ...flat, brandIds: [4] }, item));
  check('a parent category matches a child item', matchesTargets({ ...flat, categoryIds: [10] }, item) && !matchesTargets({ ...flat, categoryIds: [12] }, item));
  check('a sale with empty targets never applies in bestSale', bestSale(1000, item, [{ id: 5, type: 'percent', value: 50, ...flat }]) === null);

  // two verified, active products from different brands, both with a category and no "was" price
  const ready = await db
    .select({ v: variants, p: products })
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .where(and(eq(variants.priceVerified, true), eq(variants.isActive, true), eq(products.isActive, true), isNotNull(products.brandId), isNotNull(products.categoryId)));
  const readyA = ready[0];
  const readyB = ready.find((r) => r.p.brandId !== readyA.p.brandId)!;
  check('two products from different brands exist', !!readyA && !!readyB);
  for (const r of [readyA, readyB]) {
    await db.update(variants).set({ trackStock: false, compareAtCents: null, availability: 'in_stock' }).where(eq(variants.id, r.v.id));
  }
  const P1 = readyA.v;
  const P2 = readyB.v;
  const b1 = readyA.p.brandId!;
  const b2 = readyB.p.brandId!;

  // a parent/child category pair, and a product in the child category (of the readyB brand)
  const [parentCat] = await db.insert(categories).values({ slug: 'test-parent-category', name: 'Τεστ γονική κατηγορία' }).returning();
  const [childCat] = await db.insert(categories).values({ slug: 'test-child-category', name: 'Τεστ θυγατρική κατηγορία', parentId: parentCat.id }).returning();
  const [p3] = await db.insert(products).values({ slug: 'test-category-product', name: 'Τεστ προϊόν κατηγορίας', brandId: b2, categoryId: childCat.id }).returning();
  const [v3] = await db
    .insert(variants)
    .values({ productId: p3.id, sku: 'TEST-CATEGORY-1', label: '1 L', priceCents: 1500, compareAtCents: 1800, trackStock: false, weightGrams: 1000, priceVerified: true })
    .returning();
  const [unverified] = await db
    .insert(variants)
    .values({ productId: P1.productId, sku: 'TEST-UNVERIFIED-1', label: 'Τεστ 2 L', priceCents: 1500, trackStock: false, weightGrams: 2000, priceVerified: false })
    .returning();

  const unitPrice = async (variantId: number) => (await resolveCartLines([{ variantId, quantity: 1 }]))[0].unitPriceCents;
  const sale = async (over: Partial<typeof sales.$inferInsert>) => (await db.insert(sales).values({ name: 'Τεστ έκπτωση', type: 'percent', value: 20, brandIds: [b1], ...over }).returning())[0];

  console.log('Sales');
  const offSale = await sale({ isActive: false });
  check('an inactive sale has no effect', (await unitPrice(P1.id)) === P1.priceCents);
  await db.delete(sales).where(eq(sales.id, offSale.id));
  const futureSale = await sale({ isActive: true, startsAt: new Date(Date.now() + 7 * 86400000) });
  check('a sale that starts in the future has no effect', (await unitPrice(P1.id)) === P1.priceCents);
  await db.delete(sales).where(eq(sales.id, futureSale.id));
  const pastSale = await sale({ isActive: true, endsAt: new Date(Date.now() - 86400000) });
  check('a sale that ended in the past has no effect', (await unitPrice(P1.id)) === P1.priceCents);
  await db.delete(sales).where(eq(sales.id, pastSale.id));

  const running = await sale({ isActive: true });
  const [s1] = await resolveCartLines([{ variantId: P1.id, quantity: 1 }]);
  check('a running sale sets the price of the targeted brand', s1.unitPriceCents === Math.round(P1.priceCents * 0.8), s1.unitPriceCents);
  check('…and the regular price is shown as «was»', s1.compareAtCents === P1.priceCents, s1.compareAtCents);
  const [s2] = await resolveCartLines([{ variantId: P2.id, quantity: 1 }]);
  check('a variant of another brand is unchanged', s2.unitPriceCents === P2.priceCents && s2.compareAtCents === null, s2);
  const detail = await getProductBySlug(readyA.p.slug);
  const shownUnverified = detail?.variants.find((v) => v.id === unverified.id);
  check('a size with an unconfirmed price is untouched on the product page', shownUnverified !== undefined && shownUnverified.priceCents === 1500 && shownUnverified.compareAtCents === null, shownUnverified);
  const shownP1 = detail?.variants.find((v) => v.id === P1.id);
  check('the product page shows the sale price', shownP1?.priceCents === Math.round(P1.priceCents * 0.8) && shownP1?.compareAtCents === P1.priceCents, shownP1);
  const feed = await buildSkroutzFeed(settings);
  const feedP1 = feed.items.find((i) => i.variantId === P1.id);
  check('the Skroutz feed carries the sale price', feedP1?.priceCents === Math.round(P1.priceCents * 0.8), feedP1 ?? feed.leftOut.find((l) => l.variantId === P1.id));

  console.log('Targeted coupons');
  const addCoupon = (over: Partial<typeof coupons.$inferInsert> & { code: string }) => db.insert(coupons).values({ type: 'percent', value: 10, isActive: true, ...over });
  const quote = async (code: string, items: Array<{ variantId: number; quantity: number }>) => {
    const lines = await resolveCartLines(items);
    const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
    const weightGrams = lines.reduce((s, l) => s + l.weightGrams, 0);
    const { coupon, error } = await findCoupon(code, lines);
    const totals = coupon
      ? computeTotals({ subtotalCents, weightGrams, shippingMethod: 'courier', paymentMethod: 'bank_transfer', coupon, lines, shipping: settings.shipping, vatRate: settings.tax.vatRate })
      : null;
    return { lines, coupon, error, totals, subtotalCents };
  };
  const lineOf = (lines: Array<{ variantId: number; lineTotalCents: number }>, variantId: number) => lines.find((l) => l.variantId === variantId)!.lineTotalCents;
  const cart = (...ids: number[]) => ids.map((variantId) => ({ variantId, quantity: 1 }));
  const CODES = ['TEST-PRODUCT', 'TEST-CAP', 'TEST-MIN', 'TEST-BRAND', 'TEST-CATEGORY', 'TEST-NOSALE', 'TEST-STACK', 'TEST-STACK-P1'];

  await addCoupon({ code: 'TEST-PRODUCT', productIds: [P1.productId] });
  const productQ = await quote('TEST-PRODUCT', cart(P1.id, P2.id));
  check('a product coupon discounts only the targeted line', productQ.totals?.discountCents === Math.round(lineOf(productQ.lines, P1.id) * 0.1) && productQ.coupon?.variantIds?.join() === String(P1.id), productQ);

  await addCoupon({ code: 'TEST-CAP', type: 'fixed', value: 1000000, productIds: [P1.productId] });
  const capQ = await quote('TEST-CAP', cart(P1.id, P2.id));
  check('a fixed coupon larger than the eligible lines is capped at them', capQ.totals?.discountCents === lineOf(capQ.lines, P1.id), capQ.totals);

  const minLines = await resolveCartLines(cart(P1.id, P2.id));
  const minCents = lineOf(minLines, P1.id) + 1;
  await addCoupon({ code: 'TEST-MIN', productIds: [P1.productId], minSubtotalCents: minCents });
  const minQ = await quote('TEST-MIN', cart(P1.id, P2.id));
  check('the minimum is measured on the eligible lines only', minQ.subtotalCents >= minCents && minQ.coupon === null && !!minQ.error && minQ.error.includes('στα προϊόντα της προσφοράς'), minQ.error);

  const wrongQ = await quote('TEST-PRODUCT', cart(P2.id));
  check('a cart without any targeted product is refused', wrongQ.coupon === null && wrongQ.error === 'Το κουπόνι δεν ισχύει για τα προϊόντα του καλαθιού σας.', wrongQ.error);

  await addCoupon({ code: 'TEST-BRAND', brandIds: [b2] });
  const brandQ = await quote('TEST-BRAND', cart(P1.id, P2.id, v3.id));
  check('a brand coupon covers that brand only', brandQ.coupon?.variantIds?.sort().join() === [P2.id, v3.id].sort().join() && brandQ.totals?.discountCents === Math.round((lineOf(brandQ.lines, P2.id) + lineOf(brandQ.lines, v3.id)) * 0.1), brandQ.coupon);

  await addCoupon({ code: 'TEST-CATEGORY', categoryIds: [parentCat.id] });
  const categoryQ = await quote('TEST-CATEGORY', cart(v3.id, P2.id));
  check('a parent-category coupon covers a product in the child category', categoryQ.coupon?.variantIds?.join() === String(v3.id) && categoryQ.totals?.discountCents === Math.round(lineOf(categoryQ.lines, v3.id) * 0.1), categoryQ.coupon);

  await addCoupon({ code: 'TEST-NOSALE', excludeSaleItems: true });
  const noSaleQ = await quote('TEST-NOSALE', cart(P1.id, P2.id, v3.id));
  check('excludeSaleItems skips a line on a sale and a line with a hand-set "was" price', noSaleQ.coupon?.variantIds?.join() === String(P2.id) && noSaleQ.totals?.discountCents === Math.round(lineOf(noSaleQ.lines, P2.id) * 0.1), noSaleQ.coupon);

  await addCoupon({ code: 'TEST-STACK', excludeSaleItems: false });
  const stackQ = await quote('TEST-STACK', cart(P1.id, P2.id, v3.id));
  check('an untargeted coupon without exclusion covers the whole cart as before', stackQ.coupon?.variantIds === null && stackQ.totals?.discountCents === Math.round(stackQ.subtotalCents * 0.1), stackQ.coupon);

  await addCoupon({ code: 'TEST-STACK-P1', productIds: [P1.productId], excludeSaleItems: false });
  const stackP1Q = await quote('TEST-STACK-P1', cart(P1.id));
  check('without exclusion a coupon stacks on a running sale', stackP1Q.totals?.discountCents === Math.round(lineOf(stackP1Q.lines, P1.id) * 0.1), stackP1Q.error);

  console.log('Targeted coupons at checkout');
  const checkout = await createOrder({ ...base, paymentMethod: 'bank_transfer', couponCode: 'TEST-PRODUCT', lines: cart(P1.id, P2.id) }, settings, opts);
  check('an order with a targeted coupon is accepted', checkout.ok, checkout);
  if (checkout.ok) {
    check('the stored discount equals the checkout computation', checkout.order.discountCents === productQ.totals?.discountCents, [checkout.order.discountCents, productQ.totals?.discountCents]);
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, checkout.order.id));
    const p1Item = items.find((i) => i.variantId === P1.id);
    check('the order line keeps the sale price', p1Item?.unitPriceCents === Math.round(P1.priceCents * 0.8), p1Item);
  }

  console.log('Payment outcomes');
  {
    // keep the mail path offline: no Resend / SMTP, and the outbox goes into the throwaway directory (as in test-viva.ts)
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    process.env.DATA_DIR = path.join(dir, 'data');
    const outbox = path.join(dir, 'data', 'outbox');
    const outboxFiles = () => {
      try {
        return readdirSync(outbox);
      } catch {
        return [] as string[];
      }
    };
    const { recordPayment, releaseAbandonedCardOrders } = await import('../src/lib/orders');
    const { recordPaymentAttempt, findOrderByPayment, setAttemptStatus } = await import('../src/lib/payments/attempts');
    const { settleCardPayment } = await import('../src/lib/payments/settle');
    const { paymentAttempts } = await import('../src/lib/db/schema');

    const row = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
    const eventsOf = (orderId: number) => db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    const warningsOf = async (orderId: number) => (await eventsOf(orderId)).filter((e) => e.message.includes('ΠΡΟΣΟΧΗ')).length;
    const attemptByRef = async (ref: string) => (await db.select().from(paymentAttempts).where(eq(paymentAttempts.ref, ref)))[0];
    const cardOpts = { customerId: null, cardProviderConfigured: true };
    const newCardOrder = async (quantity = 1) => {
      const r = await createOrder({ ...base, paymentMethod: 'card', lines: [{ variantId: variant.id, quantity }] }, settings, cardOpts);
      if (!r.ok) throw new Error(`card order not created: ${r.message}`);
      return r.order;
    };
    // enough units for every order in this section; trackStock on so reservations and restocks are visible
    await db.update(variants).set({ trackStock: true, stock: 20 }).where(eq(variants.id, variant.id));

    console.log('  Correct payment');
    const o1 = await newCardOrder();
    check('a correct payment → paid', (await recordPayment(o1.id, { provider: 'viva', ref: 'pay-1', amountCents: o1.totalCents, currency: 'EUR' })) === 'paid');
    const o1Paid = await row(o1.id);
    check('the order is paid, keeps the gateway ref and is confirmed', o1Paid.paymentStatus === 'paid' && o1Paid.paymentTransactionId === 'pay-1' && o1Paid.status === 'confirmed', [o1Paid.paymentStatus, o1Paid.paymentTransactionId, o1Paid.status]);
    check('a second payment → already_paid', (await recordPayment(o1.id, { provider: 'viva', ref: 'pay-2', amountCents: o1.totalCents })) === 'already_paid');
    const o1Again = await row(o1.id);
    check('…and nothing changes (ref, paidAt)', o1Again.paymentTransactionId === 'pay-1' && o1Again.paidAt?.getTime() === o1Paid.paidAt?.getTime(), [o1Again.paymentTransactionId, o1Again.paidAt]);
    check('an unknown order id → unknown_order', (await recordPayment(999999999, { provider: 'viva', ref: 'pay-x', amountCents: 100 })) === 'unknown_order');

    console.log('  Amount mismatch');
    const o2 = await newCardOrder();
    await recordPaymentAttempt(o2.id, { provider: 'viva', ref: 'att-mm-1' });
    const r2 = await recordPayment(o2.id, { provider: 'viva', ref: 'tx-mm-1', amountCents: o2.totalCents + 1, attemptRef: 'att-mm-1' });
    check('a wrong amount → amount_mismatch', r2 === 'amount_mismatch', r2);
    const o2Row = await row(o2.id);
    check('…the order stays unpaid and pending', o2Row.paymentStatus === 'pending' && o2Row.status === 'pending', [o2Row.paymentStatus, o2Row.status]);
    check('…and the timeline has one ΠΡΟΣΟΧΗ entry', (await warningsOf(o2.id)) === 1, await warningsOf(o2.id));
    const att2 = (await db.select().from(paymentAttempts).where(eq(paymentAttempts.ref, 'att-mm-1')))[0];
    check("…the attempt is marked 'mismatch' with the gateway ref", att2?.status === 'mismatch' && att2?.transactionId === 'tx-mm-1', att2);
    check('a later correct payment still settles it', (await recordPayment(o2.id, { provider: 'viva', ref: 'tx-mm-2', amountCents: o2.totalCents, attemptRef: 'att-mm-1' })) === 'paid');
    const att2Paid = (await db.select().from(paymentAttempts).where(eq(paymentAttempts.ref, 'att-mm-1')))[0];
    check("…and the attempt becomes 'paid'", att2Paid?.status === 'paid', att2Paid?.status);

    console.log('  Currency');
    const o3a = await newCardOrder();
    check('a USD payment → currency_mismatch', (await recordPayment(o3a.id, { provider: 'viva', ref: 'usd-1', amountCents: o3a.totalCents, currency: 'USD' })) === 'currency_mismatch');
    const o3aRow = await row(o3a.id);
    check('…the order stays unpaid and pending', o3aRow.paymentStatus === 'pending' && o3aRow.status === 'pending', [o3aRow.paymentStatus, o3aRow.status]);
    check('…and the timeline has an ΠΡΟΣΟΧΗ entry', (await warningsOf(o3a.id)) === 1, await warningsOf(o3a.id));
    check('lowercase eur is accepted', (await recordPayment(o3a.id, { provider: 'viva', ref: 'eur-1', amountCents: o3a.totalCents, currency: 'eur' })) === 'paid');
    const o3b = await newCardOrder();
    check('a null currency is accepted', (await recordPayment(o3b.id, { provider: 'viva', ref: 'nul-1', amountCents: o3b.totalCents, currency: null })) === 'paid');
    const o3c = await newCardOrder();
    check('an undefined currency is accepted', (await recordPayment(o3c.id, { provider: 'viva', ref: 'und-1', amountCents: o3c.totalCents })) === 'paid');

    console.log('  Late payment');
    const stockBeforeLate = await stock();
    const o4 = await newCardOrder();
    await cancelOrder(o4.id, 'test');
    check('the cancelled order restocks', (await stock()) === stockBeforeLate, [await stock(), stockBeforeLate]);
    check('a correct payment on a cancelled order → late_cancelled', (await recordPayment(o4.id, { provider: 'viva', ref: 'late-1', amountCents: o4.totalCents })) === 'late_cancelled');
    const o4Row = await row(o4.id);
    check('…it is recorded as paid with paidAt, but the order stays cancelled', o4Row.paymentStatus === 'paid' && o4Row.paidAt !== null && o4Row.status === 'cancelled', [o4Row.paymentStatus, o4Row.paidAt, o4Row.status]);
    check('…stock is not decremented again', (await stock()) === stockBeforeLate, [await stock(), stockBeforeLate]);
    check('…and the timeline has an ΠΡΟΣΟΧΗ entry', (await warningsOf(o4.id)) === 1, await warningsOf(o4.id));

    const o4b = await newCardOrder();
    await cancelOrder(o4b.id, 'test');
    const outboxBefore = new Set(outboxFiles());
    const r4b = await settleCardPayment({ id: o4b.id, number: o4b.number }, { provider: 'viva', ref: 'late-2', amountCents: o4b.totalCents });
    check('settleCardPayment on a late payment → late_cancelled', r4b === 'late_cancelled', r4b);
    const o4bEvents = await eventsOf(o4b.id);
    check('…no customer confirmation is recorded', !o4bEvents.some((e) => e.message.startsWith('Στάλθηκε e-mail επιβεβαίωσης')), o4bEvents.map((e) => e.message));
    const newFiles = outboxFiles().filter((f) => !outboxBefore.has(f));
    if (newFiles.length > 0) {
      // the mail service is observable here: the owner alert was written to the outbox, and nothing went to the buyer
      check('…the owner alert is written to the outbox', newFiles.length === 1, newFiles);
      check('…and no file was addressed to the buyer', !newFiles.some((f) => f.includes(base.email)), newFiles);
    } else {
      // no recipient / no mail service: the failed alert is recorded on the timeline instead
      check('…the owner alert failure is recorded on the timeline', o4bEvents.some((e) => e.message.startsWith('ΑΠΟΤΥΧΙΑ αποστολής e-mail ειδοποίησης')), o4bEvents.map((e) => e.message));
    }

    console.log('  markOrderPaid wrapper');
    const o5a = await newCardOrder();
    check('markOrderPaid is true on the first correct payment', (await markOrderPaid(o5a.id, { provider: 'viva', ref: 'w-1', amountCents: o5a.totalCents })) === true);
    check('…false on a repeat', (await markOrderPaid(o5a.id, { provider: 'viva', ref: 'w-2', amountCents: o5a.totalCents })) === false);
    const o5b = await newCardOrder();
    check('…false on an amount mismatch', (await markOrderPaid(o5b.id, { provider: 'viva', ref: 'w-3', amountCents: o5b.totalCents + 5 })) === false);
    const o5c = await newCardOrder();
    await cancelOrder(o5c.id, 'test');
    check('…false on a late (cancelled) payment', (await markOrderPaid(o5c.id, { provider: 'viva', ref: 'w-4', amountCents: o5c.totalCents })) === false);

    console.log('  Payment attempts');
    const o6 = await newCardOrder();
    await recordPaymentAttempt(o6.id, { provider: 'viva', ref: 'att-old-6' });
    await recordPaymentAttempt(o6.id, { provider: 'viva', ref: 'att-new-6' });
    const rows6 = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, o6.id));
    check('two checkouts for one order make two attempt rows', rows6.length === 2, rows6.length);
    check('orders.paymentRef is the latest checkout', (await row(o6.id)).paymentRef === 'att-new-6', (await row(o6.id)).paymentRef);
    check('a payment on the older checkout still finds the order', (await findOrderByPayment('viva', 'att-old-6'))?.id === o6.id);
    check('an unknown ref finds nothing', (await findOrderByPayment('viva', 'no-such-ref-6')) === null);
    check('viva falls back to merchantTrns for a card order', (await findOrderByPayment('viva', '999', o6.number))?.id === o6.id);
    check('the merchantTrns fallback does not apply to stripe', (await findOrderByPayment('stripe', '999', o6.number)) === null);
    const dupError = await recordPaymentAttempt(o6.id, { provider: 'viva', ref: 'att-old-6' }).then(() => null, (e: unknown) => e);
    check('a duplicate (provider, ref) attempt does not throw', dupError === null, dupError);
    const rows6Again = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, o6.id));
    check('…and does not add a row', rows6Again.length === 2, rows6Again.length);
    check('…and the status helper reports no change for an unknown ref', (await setAttemptStatus('viva', 'no-such-ref-6', 'failed', null)) === false);

    console.log('  Abandoned card orders');
    const oA = await newCardOrder();
    const oB = await newCardOrder();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(orders).set({ createdAt: threeHoursAgo }).where(eq(orders.id, oA.id));
    await db.update(orders).set({ createdAt: threeHoursAgo }).where(eq(orders.id, oB.id));
    await recordPaymentAttempt(oA.id, { provider: 'viva', ref: 'rel-A' });
    const stockBeforeRelease = await stock();
    const released = await releaseAbandonedCardOrders();
    check('an order with a checkout opened just now is not released', (await row(oA.id)).status === 'pending', (await row(oA.id)).status);
    check('an old card order with no checkout is cancelled', (await row(oB.id)).status === 'cancelled', (await row(oB.id)).status);
    check('…its stock is restored', (await stock()) === stockBeforeRelease + 1, [await stock(), stockBeforeRelease]);
    check('the release reports at least that order', released >= 1, released);

    console.log('  Double payment');
    const o7 = await newCardOrder();
    await recordPaymentAttempt(o7.id, { provider: 'viva', ref: 'R1-7' });
    await recordPaymentAttempt(o7.id, { provider: 'viva', ref: 'R2-7' });
    check('a payment on the newer checkout → paid', (await recordPayment(o7.id, { provider: 'viva', ref: 'T2-7', amountCents: o7.totalCents, attemptRef: 'R2-7' })) === 'paid');
    const dupEvents7 = async () => (await eventsOf(o7.id)).filter((e) => e.message.includes('δεύτερη πληρωμή')).length;
    check('a payment on the older checkout while paid → duplicate_payment', (await recordPayment(o7.id, { provider: 'viva', ref: 'T1-7', amountCents: o7.totalCents, attemptRef: 'R1-7' })) === 'duplicate_payment');
    check('…and the timeline has one «δεύτερη πληρωμή» entry', (await dupEvents7()) === 1, await dupEvents7());
    const att7 = await attemptByRef('R1-7');
    check("…the older attempt is marked 'paid' with the second transaction id", att7?.status === 'paid' && att7?.transactionId === 'T1-7', att7);
    const row7 = await row(o7.id);
    check('…the order stays paid with its ORIGINAL transaction id', row7.paymentStatus === 'paid' && row7.paymentTransactionId === 'T2-7', [row7.paymentStatus, row7.paymentTransactionId]);
    check('a repeat of the same second payment → already_flagged', (await recordPayment(o7.id, { provider: 'viva', ref: 'T1-7', amountCents: o7.totalCents, attemptRef: 'R1-7' })) === 'already_flagged');
    check('…and writes no second event', (await dupEvents7()) === 1, await dupEvents7());
    check('the first payment again (same ref) → already_paid', (await recordPayment(o7.id, { provider: 'viva', ref: 'T2-7', amountCents: o7.totalCents, attemptRef: 'R2-7' })) === 'already_paid');

    console.log('  Double payment without a known attempt');
    const o8 = await newCardOrder();
    check('the first payment (no attemptRef) → paid', (await recordPayment(o8.id, { provider: 'viva', ref: 'T2-8', amountCents: o8.totalCents })) === 'paid');
    check('a second payment with an unrecorded attemptRef → duplicate_payment', (await recordPayment(o8.id, { provider: 'viva', ref: 'T1-8', amountCents: o8.totalCents, attemptRef: 'R-NOROW-8' })) === 'duplicate_payment');
    const att8 = await attemptByRef('R-NOROW-8');
    check('…and the attempt row is created as paid', att8?.status === 'paid' && att8?.transactionId === 'T1-8' && att8?.orderId === o8.id, att8);
    check('…the order keeps its original transaction id', (await row(o8.id)).paymentTransactionId === 'T2-8', (await row(o8.id)).paymentTransactionId);
    check('a paid order with no attemptRef and a different ref → already_paid', (await recordPayment(o8.id, { provider: 'viva', ref: 'T3-8', amountCents: o8.totalCents })) === 'already_paid');

    console.log('  Repeated mismatch');
    const o9 = await newCardOrder();
    await recordPaymentAttempt(o9.id, { provider: 'viva', ref: 'R-MM-9' });
    check('a wrong amount with attemptRef → amount_mismatch', (await recordPayment(o9.id, { provider: 'viva', ref: 'TM-9', amountCents: o9.totalCents + 1, attemptRef: 'R-MM-9' })) === 'amount_mismatch');
    check('…a repeat of the identical report → already_flagged', (await recordPayment(o9.id, { provider: 'viva', ref: 'TM-9', amountCents: o9.totalCents + 1, attemptRef: 'R-MM-9' })) === 'already_flagged');
    check('…and only one ΠΡΟΣΟΧΗ event is written', (await warningsOf(o9.id)) === 1, await warningsOf(o9.id));
    check("…the attempt is 'mismatch'", (await attemptByRef('R-MM-9'))?.status === 'mismatch', await attemptByRef('R-MM-9'));
    check('a correct payment afterwards still → paid', (await recordPayment(o9.id, { provider: 'viva', ref: 'TM-9b', amountCents: o9.totalCents, attemptRef: 'R-MM-9' })) === 'paid');

    console.log('  Duplicate owner alert');
    const o10 = await newCardOrder();
    await recordPaymentAttempt(o10.id, { provider: 'viva', ref: 'R1-10' });
    await recordPaymentAttempt(o10.id, { provider: 'viva', ref: 'R2-10' });
    await recordPayment(o10.id, { provider: 'viva', ref: 'T2-10', amountCents: o10.totalCents, attemptRef: 'R2-10' });
    const outbox10 = new Set(outboxFiles());
    const r10 = await settleCardPayment({ id: o10.id, number: o10.number }, { provider: 'viva', ref: 'T1-10', amountCents: o10.totalCents, attemptRef: 'R1-10' });
    check('settleCardPayment on a second payment → duplicate_payment', r10 === 'duplicate_payment', r10);
    const new10 = outboxFiles().filter((f) => !outbox10.has(f));
    check('…one owner alert is written to the outbox', new10.length === 1, new10);
    check('…and no file is addressed to the buyer', !new10.some((f) => f.includes(base.email)), new10);
    const outbox10b = new Set(outboxFiles());
    const r10b = await settleCardPayment({ id: o10.id, number: o10.number }, { provider: 'viva', ref: 'T1-10', amountCents: o10.totalCents, attemptRef: 'R1-10' });
    check('a repeat → already_flagged', r10b === 'already_flagged', r10b);
    check('…and sends no new mail', outboxFiles().filter((f) => !outbox10b.has(f)).length === 0, outboxFiles().filter((f) => !outbox10b.has(f)));
  }

  console.log('Payment flag for the owner');
  {
    const { recordPayment } = await import('../src/lib/orders');
    const { recordUnmatchedPayment } = await import('../src/lib/payments/attempts');
    const { unmatchedPayments } = await import('../src/lib/db/schema');
    const madeOrderIds: number[] = [];
    let madeCount = 0;
    // a fresh card order straight into the table: the minimum the payment code reads
    const freshCardOrder = async (over: Partial<typeof orders.$inferInsert> = {}) => {
      madeCount++;
      const [row] = await db
        .insert(orders)
        .values({
          number: `OC-FLAG-T${madeCount}`,
          accessToken: `at-flag-t${madeCount}`,
          paymentMethod: 'card',
          shippingMethod: 'courier',
          email: 'buyer@example.com',
          phone: '6900000000',
          firstName: 'Τεστ',
          lastName: 'Αγοραστής',
          subtotalCents: 1999,
          totalCents: 1999,
          paymentProvider: 'viva',
          ...over,
        })
        .returning();
      madeOrderIds.push(row.id);
      return row;
    };
    const flagNow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0].paymentFlag;

    const amountMismatch = await freshCardOrder();
    check('amount_mismatch → review flag', (await recordPayment(amountMismatch.id, { provider: 'viva', ref: 'FLAG-AM-1', amountCents: amountMismatch.totalCents + 1 })) === 'amount_mismatch' && (await flagNow(amountMismatch.id)) === 'review');

    const currencyMismatch = await freshCardOrder();
    check('currency_mismatch → review flag', (await recordPayment(currencyMismatch.id, { provider: 'viva', ref: 'FLAG-CM-1', amountCents: currencyMismatch.totalCents, currency: 'USD' })) === 'currency_mismatch' && (await flagNow(currencyMismatch.id)) === 'review');

    const lateCancelled = await freshCardOrder({ status: 'cancelled' });
    check('late_cancelled → review flag', (await recordPayment(lateCancelled.id, { provider: 'viva', ref: 'FLAG-LC-1', amountCents: lateCancelled.totalCents })) === 'late_cancelled' && (await flagNow(lateCancelled.id)) === 'review');

    const duplicate = await freshCardOrder();
    check('the first payment (no attemptRef) → paid', (await recordPayment(duplicate.id, { provider: 'viva', ref: 'FLAG-DP-1', amountCents: duplicate.totalCents })) === 'paid');
    check('a second payment on another checkout → duplicate_payment', (await recordPayment(duplicate.id, { provider: 'viva', ref: 'FLAG-DP-2', amountCents: duplicate.totalCents, attemptRef: 'FLAG-DP-ATT' })) === 'duplicate_payment');
    check('duplicate_payment → review flag', (await flagNow(duplicate.id)) === 'review');

    const plain = await freshCardOrder();
    check('a normal paid payment → paid, no flag', (await recordPayment(plain.id, { provider: 'viva', ref: 'FLAG-OK-1', amountCents: plain.totalCents })) === 'paid' && (await flagNow(plain.id)) === null);

    const again = await freshCardOrder();
    await recordPayment(again.id, { provider: 'viva', ref: 'FLAG-AP-1', amountCents: again.totalCents });
    check('a repeat payment → already_paid, no flag', (await recordPayment(again.id, { provider: 'viva', ref: 'FLAG-AP-2', amountCents: again.totalCents })) === 'already_paid' && (await flagNow(again.id)) === null);

    const repeated = await freshCardOrder();
    check('a wrong amount on a checkout → amount_mismatch (flagged)', (await recordPayment(repeated.id, { provider: 'viva', ref: 'FLAG-AF-1', amountCents: repeated.totalCents + 1, attemptRef: 'FLAG-AF-ATT' })) === 'amount_mismatch');
    await db.update(orders).set({ paymentFlag: null }).where(eq(orders.id, repeated.id));
    check('the same report again → already_flagged', (await recordPayment(repeated.id, { provider: 'viva', ref: 'FLAG-AF-1', amountCents: repeated.totalCents + 1, attemptRef: 'FLAG-AF-ATT' })) === 'already_flagged');
    check('…and already_flagged does not set the flag again', (await flagNow(repeated.id)) === null);

    console.log('Unmatched payments are kept once');
    const unmatched = (transactionId: string) => ({ provider: 'viva', orderCode: '9515982136480001', transactionId, merchantTrns: null, amountCents: 1999, currency: 'EUR' });
    check('the first time a paid transaction is recorded → true', (await recordUnmatchedPayment(unmatched('FLAG-UM-TX-1'))) === true);
    check('the same transaction again → false', (await recordUnmatchedPayment(unmatched('FLAG-UM-TX-1'))) === false);
    check('a different transaction → true', (await recordUnmatchedPayment(unmatched('FLAG-UM-TX-2'))) === true);

    for (const id of madeOrderIds) await db.delete(orders).where(eq(orders.id, id));
    await db.delete(unmatchedPayments).where(eq(unmatchedPayments.orderCode, '9515982136480001'));
    check('the rows of this section are gone', (await db.select().from(orders).where(eq(orders.id, madeOrderIds[0]))).length === 0);
  }

  console.log('Fixes from the bug hunt');
  {
    const { recordPayment, releaseAbandonedCardOrders } = await import('../src/lib/orders');
    const { recordPaymentAttempt } = await import('../src/lib/payments/attempts');
    const { settleCardPayment } = await import('../src/lib/payments/settle');
    const { paymentAttempts } = await import('../src/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    const outbox = path.join(dir, 'data', 'outbox');
    const outboxFiles = () => {
      try {
        return readdirSync(outbox);
      } catch {
        return [] as string[];
      }
    };
    const row = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
    const eventsOf = (orderId: number) => db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    const attemptByRef = async (ref: string) => (await db.select().from(paymentAttempts).where(eq(paymentAttempts.ref, ref)))[0];
    const cardOpts = { customerId: null, cardProviderConfigured: true };
    const newCard = async () => {
      const r = await createOrder({ ...base, paymentMethod: 'card', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, cardOpts);
      if (!r.ok) throw new Error(`card order not created: ${r.message}`);
      return r.order;
    };
    const backdate = (id: number) => db.update(orders).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(orders.id, id));
    // enough units for the orders of this section
    await db.update(variants).set({ stock: 50 }).where(eq(variants.id, variant.id));

    console.log('  Refund replay');
    const rf = await newCard();
    await recordPaymentAttempt(rf.id, { provider: 'viva', ref: 'R1-RF' });
    const rfInfo = { provider: 'viva', ref: 'T1-RF', amountCents: rf.totalCents, attemptRef: 'R1-RF' };
    check('a payment → paid', (await recordPayment(rf.id, rfInfo)) === 'paid');
    await db.update(orders).set({ paymentStatus: 'refunded' }).where(eq(orders.id, rf.id));
    const rfEvents = (await eventsOf(rf.id)).length;
    check('the same payment replayed after a refund → already_paid', (await recordPayment(rf.id, rfInfo)) === 'already_paid');
    const rfAfter = await row(rf.id);
    check('…the order stays refunded with its reference', rfAfter.paymentStatus === 'refunded' && rfAfter.paymentTransactionId === 'T1-RF', [rfAfter.paymentStatus, rfAfter.paymentTransactionId]);
    check('…and writes no event', (await eventsOf(rf.id)).length === rfEvents, [rfEvents, (await eventsOf(rf.id)).length]);
    const outboxRf = new Set(outboxFiles());
    check('settleCardPayment on the replay → already_paid', (await settleCardPayment({ id: rf.id, number: rf.number }, rfInfo)) === 'already_paid');
    const newRfFiles = outboxFiles().filter((f) => !outboxRf.has(f));
    check('…and the outbox gets no new file', newRfFiles.length === 0, newRfFiles);
    await recordPaymentAttempt(rf.id, { provider: 'viva', ref: 'R2-RF' });
    check('a different payment on the refunded order → duplicate_payment', (await recordPayment(rf.id, { provider: 'viva', ref: 'T2-RF', amountCents: rf.totalCents, attemptRef: 'R2-RF' })) === 'duplicate_payment');
    check('…and it is flagged for review', (await row(rf.id)).paymentFlag === 'review', (await row(rf.id)).paymentFlag);

    console.log('  Paid by hand');
    const mp = await newCard();
    await db.update(orders).set({ paymentStatus: 'paid', paidAt: new Date() }).where(eq(orders.id, mp.id));
    const mpInfo = { provider: 'viva', ref: 'T-MAN-1', amountCents: mp.totalCents, attemptRef: 'R-MAN-1' };
    check('a card payment on an order marked paid by hand → duplicate_payment', (await recordPayment(mp.id, mpInfo)) === 'duplicate_payment');
    const mpRow = await row(mp.id);
    check('…flagged for review', mpRow.paymentFlag === 'review', mpRow.paymentFlag);
    check("…the timeline says it was marked by hand", (await eventsOf(mp.id)).some((e) => e.message.includes('σημειωμένη χειροκίνητα')));
    check('…the transaction id stays empty', mpRow.paymentTransactionId === null, mpRow.paymentTransactionId);
    check('a repeat → already_flagged', (await recordPayment(mp.id, mpInfo)) === 'already_flagged');

    console.log('  Cancel only unpaid');
    const s0 = await stock();
    const cp = await newCard();
    await recordPayment(cp.id, { provider: 'viva', ref: 'RU-PAID', amountCents: cp.totalCents });
    const cpStatus = (await row(cp.id)).status;
    check('cancelOrder with requireUnpaid on a paid order → false', (await cancelOrder(cp.id, 'test', undefined, { requireUnpaid: true })) === false);
    check('…and the status is unchanged', (await row(cp.id)).status === cpStatus, [(await row(cp.id)).status, cpStatus]);
    const cu = await newCard();
    check('cancelOrder with requireUnpaid on an unpaid order → true', (await cancelOrder(cu.id, 'test', undefined, { requireUnpaid: true })) === true);
    check('…and its stock is restored', (await stock()) === s0 - 1, [await stock(), s0 - 1]);

    console.log('  Abandoned orders with a payment flag');
    const ab1 = await newCard();
    await backdate(ab1.id);
    await db.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, ab1.id));
    const ab2 = await newCard();
    await backdate(ab2.id);
    await releaseAbandonedCardOrders();
    check('an old unpaid card order with a review flag is skipped', (await row(ab1.id)).status === 'pending', (await row(ab1.id)).status);
    check('an old unflagged card order is still cancelled', (await row(ab2.id)).status === 'cancelled', (await row(ab2.id)).status);

    console.log('  Rollback');
    const rb = await newCard();
    await recordPaymentAttempt(rb.id, { provider: 'viva', ref: 'RB-ATT' });
    const rbInfo = { provider: 'viva', ref: 'RB-TX', amountCents: rb.totalCents, attemptRef: 'RB-ATT' };
    await db.run(sql`ALTER TABLE order_events RENAME TO order_events_x`);
    let threw = false;
    try {
      await recordPayment(rb.id, rbInfo);
    } catch {
      threw = true;
    } finally {
      await db.run(sql`ALTER TABLE order_events_x RENAME TO order_events`);
    }
    check('a failing write inside the payment throws', threw);
    const rbRow = await row(rb.id);
    check('…the order stays pending and unpaid (rolled back)', rbRow.paymentStatus === 'pending' && rbRow.status === 'pending', [rbRow.paymentStatus, rbRow.status]);
    check("…the attempt row is unchanged ('created')", (await attemptByRef('RB-ATT'))?.status === 'created', await attemptByRef('RB-ATT'));
    check('the same payment once the table is back → paid', (await recordPayment(rb.id, rbInfo)) === 'paid');

    console.log('  Money format');
    const mf = await newCard();
    await recordPayment(mf.id, { provider: 'viva', ref: 'MF-1', amountCents: mf.totalCents + 1 });
    const mfMsg = (await eventsOf(mf.id)).find((e) => e.message.includes('ΠΡΟΣΟΧΗ'))?.message ?? '';
    check('the ΠΡΟΣΟΧΗ amounts use a Greek comma', /\d+,\d{2}/.test(mfMsg), mfMsg);
    check('…and no raw dot amount', !/\d\.\d{1,2}\s?€/.test(mfMsg), mfMsg);

    console.log('  Coupon messages');
    await addCoupon({ code: 'TEST-MSG-NOSALE', excludeSaleItems: true, minSubtotalCents: lineOf(minLines, P2.id) + 1 });
    const noSaleMinQ = await quote('TEST-MSG-NOSALE', cart(P1.id, P2.id));
    check('no targets + skips sale items: the minimum message names the non-sale products', !!noSaleMinQ.error && noSaleMinQ.error.endsWith('σε προϊόντα που δεν είναι σε προσφορά.'), noSaleMinQ.error);
    await addCoupon({ code: 'TEST-MSG-TARGET', productIds: [P1.productId], minSubtotalCents: lineOf(minLines, P1.id) + 1 });
    const targetMinQ = await quote('TEST-MSG-TARGET', cart(P1.id));
    check('a targeted coupon keeps the offer wording', !!targetMinQ.error && targetMinQ.error.endsWith('στα προϊόντα της προσφοράς.'), targetMinQ.error);
    await addCoupon({ code: 'TEST-MSG-PLAIN', excludeSaleItems: false, minSubtotalCents: 10000000 });
    const plainMinQ = await quote('TEST-MSG-PLAIN', cart(P1.id, P2.id));
    check('an untargeted coupon without exclusion keeps the plain message', plainMinQ.error === `Το κουπόνι ισχύει για αγορές άνω των ${(10000000 / 100).toFixed(2).replace('.', ',')} €.`, plainMinQ.error);
    await db.delete(coupons).where(inArray(coupons.code, ['TEST-MSG-NOSALE', 'TEST-MSG-TARGET', 'TEST-MSG-PLAIN']));

    console.log('  Sales with an unreadable target list');
    const { getSaleContext } = await import('../src/lib/sales');
    const [goodSale] = await db.insert(sales).values({ name: 'Τεστ έγκυρη έκπτωση', type: 'percent', value: 10, isActive: true }).returning();
    const [badSale] = await db.insert(sales).values({ name: 'Τεστ κατεστραμμένη έκπτωση', type: 'percent', value: 10, isActive: true }).returning();
    await db.run(sql`UPDATE sales SET product_ids = 'not json' WHERE id = ${badSale.id}`);
    let ctxSales: Array<{ id: number }> = [];
    let ctxError: unknown = null;
    try {
      ctxSales = (await getSaleContext()).sales;
    } catch (err) {
      ctxError = err;
    }
    check('the sale context loads despite one unreadable row', ctxError === null, ctxError);
    check('…it contains the valid sale', ctxSales.some((s) => s.id === goodSale.id));
    check('…and not the unreadable one', !ctxSales.some((s) => s.id === badSale.id));
    await db.delete(sales).where(inArray(sales.id, [goodSale.id, badSale.id]));
  }

  console.log('Cleanup');
  await db.delete(sales).where(eq(sales.id, running.id));
  await db.delete(coupons).where(inArray(coupons.code, CODES));
  await db.delete(variants).where(inArray(variants.id, [v3.id, unverified.id]));
  await db.delete(products).where(eq(products.id, p3.id));
  await db.delete(categories).where(eq(categories.id, childCat.id));
  await db.delete(categories).where(eq(categories.id, parentCat.id));
  check('the test rows are gone', (await db.select().from(sales)).length === 0 && (await db.select().from(coupons).where(inArray(coupons.code, CODES))).length === 0);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  });
