/*
 * Order-logic regression test. Runs against a throwaway COPY of the local database:
 *   npm run test:orders
 * Covers the things that cost real money when they go wrong: overselling, double cancel,
 * payment amount mismatch, duplicate gateway callbacks, coupon maths and shipping tiers.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
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
  const { cancelOrder, createOrder, recordPayment } = await import('../src/lib/orders');
  const { deliverPendingMail } = await import('../src/lib/payments/mail-delivery');
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

  console.log('Checkout field limits');
  {
    const { CheckoutSchema } = await import('../src/lib/orders');
    const valid = { lines: [{ variantId: 1, quantity: 1 }], email: 'a@example.gr', phone: '6912345678', firstName: 'Ελένη', lastName: 'Δοκιμή', shippingMethod: 'pickup', paymentMethod: 'pay_in_store', docType: 'receipt', acceptTerms: true };
    check('(a valid payload passes)', CheckoutSchema.safeParse(valid).success);
    // every field that has a length limit, with the limit
    const limits: Array<[string, number]> = [['couponCode', 40], ['email', 160], ['phone', 30], ['firstName', 80], ['lastName', 80], ['street', 160], ['city', 80], ['postalCode', 10], ['region', 80], ['notes', 1000], ['companyName', 160], ['vatNumber', 20], ['taxOffice', 80], ['companyActivity', 160], ['companyAddress', 200]];
    const wrong: Array<[string, string[]]> = [];
    for (const [field, max] of limits) {
      const value = field === 'phone' ? '6'.repeat(max + 1) : field === 'email' ? `${'a'.repeat(max)}@example.gr` : 'σ'.repeat(max + 1);
      const result = CheckoutSchema.safeParse({ ...valid, [field]: value });
      const messages = result.success ? [] : result.error.issues.filter((i) => i.path[0] === field).map((i) => i.message);
      if (!messages.includes(`Έως ${max} χαρακτήρες. Συντομεύστε το κείμενο.`)) wrong.push([field, messages]);
    }
    check(`all ${limits.length} limited fields answer an over-long value in Greek, naming the limit`, wrong.length === 0, wrong);
    const english = limits.flatMap(([field, max]) => {
      const result = CheckoutSchema.safeParse({ ...valid, [field]: field === 'phone' ? '6'.repeat(max + 1) : 'σ'.repeat(max + 1) });
      return result.success ? [] : result.error.issues.map((i) => i.message).filter((m) => !/[Α-ωά-ώ]/.test(m));
    });
    check('…and none of the messages for them is in English', english.length === 0, english);
  }

  console.log('Footer service line');
  {
    const { shopServices } = await import('../src/lib/shop-services');
    const all = structuredClone(DEFAULT_SETTINGS);
    all.shipping.courierEnabled = true; all.shipping.pickupEnabled = true;
    all.payments.cod = true; all.payments.card = true; all.payments.bankTransfer = true;
    check('everything on, card provider configured → all five', shopServices(all, true).join() === 'courier,pickup,cod,card,bank_transfer', shopServices(all, true));
    check('…without a configured card provider, card is not promised even when the setting is on', !shopServices(all, false).includes('card') && shopServices(all, false).length === 4);
    const noCourier = structuredClone(all); noCourier.shipping.courierEnabled = false;
    check('courier off → no delivery and no cash on delivery (cod only goes with courier)', shopServices(noCourier, true).join() === 'pickup,card,bank_transfer', shopServices(noCourier, true));
    const bare = structuredClone(all); bare.shipping.pickupEnabled = false; bare.payments.cod = false; bare.payments.card = false; bare.payments.bankTransfer = false;
    check('only what is switched on is listed (courier alone)', shopServices(bare, true).join() === 'courier', shopServices(bare, true));
    const none = structuredClone(bare); none.shipping.courierEnabled = false;
    check('nothing on → an empty line (the footer then shows no row)', shopServices(none, true).length === 0);
    const noBank = structuredClone(all); noBank.payments.bankTransfer = false;
    check('bank transfer off → no «Κατάθεση»', !shopServices(noBank, true).includes('bank_transfer'));
  }

  console.log('Payment settlement');
  const mismatchOutcome = await recordPayment(first.order.id, { provider: 'test', ref: 'x', amountCents: 100 });
  check('wrong amount is rejected', mismatchOutcome === 'amount_mismatch', mismatchOutcome);
  const afterMismatch = (await db.select().from(orders).where(eq(orders.id, first.order.id)))[0];
  check('…and the order stays unpaid', afterMismatch.paymentStatus === 'pending', afterMismatch.paymentStatus);
  const warned = (await db.select().from(orderEvents).where(eq(orderEvents.orderId, first.order.id))).some((e) => e.message.includes('ΠΡΟΣΟΧΗ'));
  check('…and the mismatch is written to the order timeline', warned);
  const settleOutcome = await recordPayment(first.order.id, { provider: 'test', ref: 'tx1', amountCents: 2590 });
  check('correct amount settles the order', settleOutcome === 'paid', settleOutcome);
  const repeatOutcome = await recordPayment(first.order.id, { provider: 'test', ref: 'tx1', amountCents: 2590 });
  check('duplicate callback is a no-op (idempotent)', repeatOutcome === 'already_paid', repeatOutcome);
  const paid = (await db.select().from(orders).where(eq(orders.id, first.order.id)))[0];
  check('paid order moves pending → confirmed', paid.paymentStatus === 'paid' && paid.status === 'confirmed', [paid.paymentStatus, paid.status]);

  console.log('Cancellation');
  check('cancel restocks', (await cancelOrder(first.order.id, 'test')) === true && (await stock()) === 2, await stock());
  check('second cancel does nothing (no double restock)', (await cancelOrder(first.order.id, 'test')) === false && (await stock()) === 2, await stock());

  console.log('Stock counting switched after an order');
  await db.update(variants).set({ trackStock: false, stock: 0 }).where(eq(variants.id, variant.id));
  const untrackedOrder = await createOrder({ ...base, lines: [{ variantId: variant.id, quantity: 2 }] }, settings, opts);
  if (!untrackedOrder.ok) throw new Error(`order while untracked not created: ${untrackedOrder.message}`);
  await db.update(variants).set({ trackStock: true, stock: 5 }).where(eq(variants.id, variant.id));
  await cancelOrder(untrackedOrder.order.id, 'test');
  check('an order placed while stock was not counted returns nothing when counting was switched on since', (await stock()) === 5, await stock());
  const trackedOrder = await createOrder({ ...base, lines: [{ variantId: variant.id, quantity: 2 }] }, settings, opts);
  if (!trackedOrder.ok) throw new Error(`order while tracked not created: ${trackedOrder.message}`);
  check('(the counted order reserved its 2 units)', (await stock()) === 3, await stock());
  await db.update(variants).set({ trackStock: false }).where(eq(variants.id, variant.id));
  await cancelOrder(trackedOrder.order.id, 'test');
  check('an order that reserved stock gives it back even when counting was switched off since', (await stock()) === 5, await stock());
  await db.update(variants).set({ trackStock: true, stock: 2 }).where(eq(variants.id, variant.id));

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
  if (withCoupon.ok) await cancelOrder(withCoupon.order.id, 'test');
  const couponUses = (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0].usedCount;
  check('cancelling the order gives the coupon use back', couponUses === 0, couponUses);
  check('…and a cancelled order cannot give it back twice', (await cancelOrder(withCoupon.ok ? withCoupon.order.id : 0, 'test')) === false && (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0].usedCount === 0);
  await db.update(variants).set({ stock: 5 }).where(eq(variants.id, variant.id));

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
  const decimalBase = { ...s, baseWeightKg: 1.2 };
  check('a decimal base weight does not add a phantom kilo (2,2 kg over 1,2 kg = 1 extra kg)', courierRateCents(2200, decimalBase) === s.baseCents + s.perExtraKgCents, courierRateCents(2200, decimalBase));
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
  check('a size with an unconfirmed price shows no price on the product page, sale or not', shownUnverified !== undefined && shownUnverified.priceVerified === false && shownUnverified.priceCents === 0 && shownUnverified.compareAtCents === null, shownUnverified);
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
  check('the minimum is measured on the eligible lines only', minQ.subtotalCents >= minCents && minQ.coupon === null && !!minQ.error && minQ.error.includes('στα προϊόντα στα οποία αναφέρεται το κουπόνι'), minQ.error);

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
    // the mail service is observable here: the owner alert must be there, and nothing may go to the buyer
    check('…the owner alert is written to the outbox', newFiles.length === 1, newFiles);
    check('…and no file was addressed to the buyer', !newFiles.some((f) => f.includes(base.email)), newFiles);

    console.log('  recordPayment outcomes');
    const o5a = await newCardOrder();
    const first5 = await recordPayment(o5a.id, { provider: 'viva', ref: 'w-1', amountCents: o5a.totalCents });
    check('the first correct payment → paid', first5 === 'paid', first5);
    const again5 = await recordPayment(o5a.id, { provider: 'viva', ref: 'w-1', amountCents: o5a.totalCents });
    check('…the same payment again → already_paid', again5 === 'already_paid', again5);
    const other5 = await recordPayment(o5a.id, { provider: 'viva', ref: 'w-2', amountCents: o5a.totalCents });
    check('…another reference without a checkout reference on a paid order → already_paid (duplicate_payment needs an attemptRef, see below)', other5 === 'already_paid', other5);
    const o5b = await newCardOrder();
    const mis5 = await recordPayment(o5b.id, { provider: 'viva', ref: 'w-3', amountCents: o5b.totalCents + 5 });
    check('…an amount mismatch → amount_mismatch', mis5 === 'amount_mismatch', mis5);
    const o5c = await newCardOrder();
    await cancelOrder(o5c.id, 'test');
    const late5 = await recordPayment(o5c.id, { provider: 'viva', ref: 'w-4', amountCents: o5c.totalCents });
    check('…a late (cancelled) payment → late_cancelled', late5 === 'late_cancelled', late5);

    console.log('  The buyer\'s confirmation mail, as the order page reads it');
    {
      const { confirmationMailState } = await import('../src/lib/payments/mail-delivery');
      const { mailOutbox } = await import('../src/lib/db/schema');
      check('an order with no confirmation mail queued → none (the page makes no claim)', (await confirmationMailState(o5b.id)) === 'none');
      check('a paid card order whose mail is queued → pending', (await confirmationMailState(o5a.id)) === 'pending');
      await deliverPendingMail({ orderId: o5a.id });
      check('…after delivery → sent', (await confirmationMailState(o5a.id)) === 'sent');
      await db.update(mailOutbox).set({ sentAt: null, givenUpAt: new Date() }).where(eq(mailOutbox.orderId, o5a.id));
      check('…a mail given up → failed', (await confirmationMailState(o5a.id)) === 'failed');
      await db.update(mailOutbox).set({ givenUpAt: null }).where(eq(mailOutbox.orderId, o5a.id));
    }

    console.log('  Confirmation of a placed order');
    {
      const { sendPlacedOrderConfirmation } = await import('../src/lib/order-mail');
      const { getOrderByNumber } = await import('../src/lib/orders');
      const placed = await newCardOrder();
      const full = await getOrderByNumber(placed.number);
      const eventsOfOrder = async () => (await db.select().from(orderEvents).where(eq(orderEvents.orderId, placed.id))).map((e) => e.message);
      const filesBefore = outboxFiles().length;
      const none = await sendPlacedOrderConfirmation(placed, null, DEFAULT_SETTINGS);
      check('an order that cannot be read back: not sent (false), no mail written, nothing on the timeline', none === false && outboxFiles().length === filesBefore && !(await eventsOfOrder()).some((m) => m.includes('e-mail επιβεβαίωσης')), [none, await eventsOfOrder()]);
      const went = await sendPlacedOrderConfirmation(placed, full, DEFAULT_SETTINGS);
      check('an order that can: sent (true), one mail written, «Στάλθηκε» on the timeline', went === true && outboxFiles().length === filesBefore + 1 && (await eventsOfOrder()).some((m) => m.startsWith('Στάλθηκε e-mail επιβεβαίωσης')), [went, await eventsOfOrder()]);
    }

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
    // the release selects first and cancels afterwards: what changes in between must still stop the cancel
    const oC = await newCardOrder();
    await db.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, oC.id));
    check('a release cancel does not touch an order flagged after it was selected', (await cancelOrder(oC.id, 'system', undefined, { requireUnpaid: true })) === false && (await row(oC.id)).status === 'pending');
    const oD = await newCardOrder();
    await recordPaymentAttempt(oD.id, { provider: 'viva', ref: 'rel-D' });
    check('…nor one whose buyer opened a new checkout in the meantime', (await cancelOrder(oD.id, 'system', undefined, { requireUnpaid: true, noAttemptSince: new Date(Date.now() - 60_000) })) === false && (await row(oD.id)).status === 'pending');

    console.log('  Card payment that cannot start');
    const { releaseUnstartedCardOrder } = await import('../src/lib/orders');
    const couponUsed = async () => (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0].usedCount;
    await db.update(coupons).set({ isActive: true, type: 'percent', value: 5, minSubtotalCents: 0, maxUses: 5, usedCount: 0 }).where(eq(coupons.code, 'WELCOME5'));
    const stockBeforeU = await stock();
    const uOrder = await createOrder({ ...base, paymentMethod: 'card', couponCode: 'WELCOME5', lines: [{ variantId: variant.id, quantity: 2 }] }, settings, cardOpts);
    if (!uOrder.ok) throw new Error(`order with coupon not created: ${uOrder.message}`);
    const u = uOrder.order;
    check('the card order with a coupon reserved 2 units and used the coupon', (await stock()) === stockBeforeU - 2 && (await couponUsed()) === 1, [await stock(), stockBeforeU, await couponUsed()]);
    check('releasing an order whose payment could not start cancels it', (await releaseUnstartedCardOrder(u.id)) === true && (await row(u.id)).status === 'cancelled');
    check('…the stock it reserved is back, exactly', (await stock()) === stockBeforeU, [await stock(), stockBeforeU]);
    check('…the coupon use is back', (await couponUsed()) === 0, await couponUsed());
    check('…the timeline names the reason', (await eventsOf(u.id)).some((e) => e.message.startsWith('Η παραγγελία ακυρώθηκε: η πληρωμή με κάρτα δεν μπόρεσε να ξεκινήσει')), (await eventsOf(u.id)).map((e) => e.message));
    check('…and the payment stays unpaid, nothing is marked refunded', (await row(u.id)).paymentStatus === 'pending', (await row(u.id)).paymentStatus);
    check('a second release changes nothing (false) and does not restock twice', (await releaseUnstartedCardOrder(u.id)) === false && (await stock()) === stockBeforeU, await stock());
    {
      // the owner's notice is saved WITH the cancellation, once, and is sent afterwards (the checkout action does that; the sweep retries)
      const { mailOutbox } = await import('../src/lib/db/schema');
      const noticesOf = (orderId: number) => db.select().from(mailOutbox).where(and(eq(mailOutbox.orderId, orderId), eq(mailOutbox.kind, 'order_cancelled_notice')));
      const queued = await noticesOf(u.id);
      check('the cancellation queued exactly one owner notice, not yet sent', queued.length === 1 && queued[0]!.sentAt === null && queued[0]!.givenUpAt === null, queued);
      check('…the second (refused) release queued no second one', (await noticesOf(u.id)).length === 1);
      const uFiles = new Set(outboxFiles());
      const uSent = await deliverPendingMail({ orderId: u.id });
      const uNew = outboxFiles().filter((f) => !uFiles.has(f));
      const uSubject = uNew.length === 1 ? (readFileSync(path.join(outbox, uNew[0]!), 'utf8').match(/subject: (.*?) -->/s)?.[1] ?? '') : '';
      check('sending it writes one mail to the shop, not to the buyer', uSent === 1 && uNew.length === 1 && !uNew[0]!.includes(base.email), [uSent, uNew]);
      check('…its subject says the order was cancelled because the payment did not start', uSubject.startsWith(`Ακυρώθηκε: ${u.number}`) && uSubject.includes('η πληρωμή δεν ξεκίνησε'), uSubject);
      const uBody = uNew.length === 1 ? readFileSync(path.join(outbox, uNew[0]!), 'utf8') : '';
      check('…and says nothing was charged and the stock is back', uBody.includes('Δεν έγινε καμία χρέωση') && uBody.includes('το απόθεμα επανήλθε'));
      check('…the notice is marked sent and sending again writes nothing more', (await noticesOf(u.id))[0]!.sentAt !== null && (await deliverPendingMail({ orderId: u.id })) === 0 && outboxFiles().length === uFiles.size + 1);
    }
    const uPaid = await newCardOrder();
    await recordPaymentAttempt(uPaid.id, { provider: 'viva', ref: 'unstarted-paid' });
    await recordPayment(uPaid.id, { provider: 'viva', ref: 'T-unstarted-paid', amountCents: uPaid.totalCents, attemptRef: 'unstarted-paid' });
    const stockPaid = await stock();
    check('a paid order is never released', (await releaseUnstartedCardOrder(uPaid.id)) === false && (await row(uPaid.id)).status !== 'cancelled' && (await stock()) === stockPaid);
    const { mailOutbox: outboxTable } = await import('../src/lib/db/schema');
    const noticeCount = async (orderId: number) => (await db.select().from(outboxTable).where(and(eq(outboxTable.orderId, orderId), eq(outboxTable.kind, 'order_cancelled_notice')))).length;
    check('…and no cancellation notice is queued for it', (await noticeCount(uPaid.id)) === 0);
    const uFlag = await newCardOrder();
    await db.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, uFlag.id));
    check('…nor one flagged for the owner (and no notice)', (await releaseUnstartedCardOrder(uFlag.id)) === false && (await row(uFlag.id)).status === 'pending' && (await noticeCount(uFlag.id)) === 0);
    const uProc = await newCardOrder();
    await recordPaymentAttempt(uProc.id, { provider: 'viva', ref: 'unstarted-proc' });
    await setAttemptStatus('viva', 'unstarted-proc', 'processing', null);
    check('…nor one with a delayed payment on its way (and no notice)', (await releaseUnstartedCardOrder(uProc.id)) === false && (await row(uProc.id)).status === 'pending' && (await noticeCount(uProc.id)) === 0);
    await db.update(variants).set({ trackStock: false }).where(eq(variants.id, variant.id));
    const uUntracked = await newCardOrder();
    await db.update(variants).set({ trackStock: true, stock: stockBeforeU }).where(eq(variants.id, variant.id));
    check('a size that was not counted when the order was placed gets nothing added', (await releaseUnstartedCardOrder(uUntracked.id)) === true && (await stock()) === stockBeforeU, await stock());
    await db.update(coupons).set({ isActive: false }).where(eq(coupons.code, 'WELCOME5'));

    console.log('  Bank-transfer expiry and the age flag');
    {
      const { releaseExpiredBankTransferOrders, staleOpenOrders, staleOpenOrderCount, getOrderByNumber } = await import('../src/lib/orders');
      const { mailOutbox } = await import('../src/lib/db/schema');
      const { BANK_TRANSFER_EXPIRY_DAYS, OPEN_ORDER_FLAG_DAYS, DAY_MS, bankTransferExpiryNotice, BANK_TRANSFER_EXPIRY_GENERAL } = await import('../src/lib/order-ageing');
      const { orderConfirmationMail } = await import('../src/lib/email');
      const { formatDate } = await import('../src/lib/utils');
      check('the parameters are 5 days for a transfer and 7 days for the age flag', BANK_TRANSFER_EXPIRY_DAYS === 5 && OPEN_ORDER_FLAG_DAYS === 7);
      const make = async (method: 'bank_transfer' | 'cod' | 'pay_in_store' | 'card', extra: Record<string, unknown> = {}, quantity = 1) => {
        const shipping = method === 'pay_in_store' ? { shippingMethod: 'pickup' as const } : {};
        const r = await createOrder({ ...base, ...shipping, ...extra, paymentMethod: method, lines: [{ variantId: variant.id, quantity }] } as Parameters<typeof createOrder>[0], settings, method === 'card' ? cardOpts : opts);
        if (!r.ok) throw new Error(`order not created: ${r.message}`);
        await db.update(orders).set({ isTest: false }).where(eq(orders.id, r.order.id)); // the age flag is about real orders
        return r.order;
      };
      const age = (id: number, ms: number) => db.update(orders).set({ createdAt: new Date(Date.now() - ms) }).where(eq(orders.id, id));
      const notices = (orderId: number) => db.select().from(mailOutbox).where(and(eq(mailOutbox.orderId, orderId), eq(mailOutbox.kind, 'order_expired_notice')));
      const H = 3600 * 1000;
      await db.update(variants).set({ trackStock: true, stock: 40 }).where(eq(variants.id, variant.id));
      await releaseExpiredBankTransferOrders(); // (setup) orders of the copied database that are already old
      const staleBefore = await staleOpenOrderCount();

      // ── bank transfer expiry ──
      await db.update(coupons).set({ isActive: true, type: 'percent', value: 5, minSubtotalCents: 0, maxUses: 20, usedCount: 0 }).where(eq(coupons.code, 'WELCOME5'));
      const young = await make('bank_transfer');
      await age(young.id, 4 * DAY_MS + 23 * H);
      const late = await make('bank_transfer', { couponCode: 'WELCOME5' }, 2);
      await age(late.id, 5 * DAY_MS + 1 * H);
      const paid = await make('bank_transfer');
      await db.update(orders).set({ paymentStatus: 'paid' }).where(eq(orders.id, paid.id));
      await age(paid.id, 6 * DAY_MS);
      const confirmed = await make('bank_transfer');
      await db.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, confirmed.id));
      await age(confirmed.id, 6 * DAY_MS);
      const flagged = await make('bank_transfer');
      await db.update(orders).set({ paymentFlag: 'review' }).where(eq(orders.id, flagged.id));
      await age(flagged.id, 6 * DAY_MS);
      const cod = await make('cod');
      await age(cod.id, 10 * DAY_MS);
      const card = await make('card');
      await age(card.id, 10 * DAY_MS);
      const stockBefore = await stock();
      const couponBefore = (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0]!.usedCount;

      const released = await releaseExpiredBankTransferOrders();
      check('exactly the transfer order older than 5 days is cancelled', released === 1 && (await row(late.id)).status === 'cancelled', released);
      check('…one that is 4 days 23 hours old is not', (await row(young.id)).status === 'pending');
      check('…nor one that was paid, confirmed or flagged for the owner', (await row(paid.id)).status === 'pending' && (await row(confirmed.id)).status === 'confirmed' && (await row(flagged.id)).status === 'pending' && (await row(flagged.id)).paymentFlag === 'review');
      check('…nor cash on delivery or card orders (they have their own rules)', (await row(cod.id)).status === 'pending' && (await row(card.id)).status === 'pending');
      check('the stock it reserved is back, exactly', (await stock()) === stockBefore + 2, [await stock(), stockBefore]);
      check('…and so is the coupon use', (await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5')))[0]!.usedCount === couponBefore - 1);
      check('…the order stays unpaid (nothing marked refunded) and the timeline names the reason', (await row(late.id)).paymentStatus === 'pending' && (await eventsOf(late.id)).some((e) => e.message.startsWith('Η παραγγελία ακυρώθηκε: η κατάθεση δεν εισπράχθηκε μέσα σε 5 ημέρες')), (await eventsOf(late.id)).map((e) => e.message));
      const queued = await notices(late.id);
      check('one notice for the customer was queued with the cancellation, none for any other order', queued.length === 1 && queued[0]!.sentAt === null && (await notices(young.id)).length + (await notices(paid.id)).length + (await notices(confirmed.id)).length + (await notices(flagged.id)).length + (await notices(cod.id)).length + (await notices(card.id)).length === 0);
      check('running the sweep again changes nothing (no second restock, no second notice)', (await releaseExpiredBankTransferOrders()) === 0 && (await stock()) === stockBefore + 2 && (await notices(late.id)).length === 1);

      const filesBefore = new Set(outboxFiles());
      const sent = await deliverPendingMail({ orderId: late.id });
      const newFiles = outboxFiles().filter((f) => !filesBefore.has(f));
      const mailText = newFiles.length === 1 ? readFileSync(path.join(outbox, newFiles[0]!), 'utf8') : '';
      check('the notice goes to the CUSTOMER (not the shop) with the order number in the subject', sent === 1 && newFiles.length === 1 && newFiles[0]!.includes(base.email) && /subject: Η παραγγελία OC-\d+ ακυρώθηκε/.test(mailText), [sent, newFiles]);
      check('…it says the transfer did not arrive in 5 days, that the stock is back, and what to do if they did pay', mailText.includes('5 ημέρες') && mailText.includes('επέστρεψαν στο απόθεμα') && mailText.includes('Αν έχετε ήδη κάνει την κατάθεση'));
      check('…and the timeline records that it was sent', (await eventsOf(late.id)).some((e) => e.message.startsWith('Στάλθηκε e-mail ακύρωσης')) && (await notices(late.id))[0]!.sentAt !== null);

      // customers are told up front
      const full = (await getOrderByNumber(young.number))!;
      const confirmation = orderConfirmationMail({ ...full, paymentMethod: 'bank_transfer' }, settings).html;
      const promise = bankTransferExpiryNotice(full.createdAt, formatDate); // the date counts from the order's stored time (this one was aged above)
      check('the confirmation e-mail says when an unpaid transfer order is cancelled, with the date', confirmation.includes('5 ημέρες') && confirmation.includes(formatDate(new Date(full.createdAt.getTime() + 5 * DAY_MS))) && confirmation.includes(promise), promise);
      check('…counted from when the order was placed, not from today', promise !== bankTransferExpiryNotice(new Date(), formatDate), promise);
      check('the sentence for pages without an order names the same 5 days', BANK_TRANSFER_EXPIRY_GENERAL.includes('5 ημέρες'));

      // ── the age flag for cash on delivery and pay in store ──
      const codYoung = await make('cod');
      await age(codYoung.id, 6 * DAY_MS + 23 * H);
      const codOld = await make('cod');
      await age(codOld.id, 7 * DAY_MS + 1 * H);
      const shopOld = await make('pay_in_store');
      await age(shopOld.id, 9 * DAY_MS);
      const codConfirmed = await make('cod');
      await db.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, codConfirmed.id));
      await age(codConfirmed.id, 12 * DAY_MS);
      const codCancelled = await make('cod');
      await cancelOrder(codCancelled.id, 'test');
      await age(codCancelled.id, 12 * DAY_MS);
      const codTest = await make('cod');
      await db.update(orders).set({ isTest: true }).where(eq(orders.id, codTest.id));
      await age(codTest.id, 12 * DAY_MS);
      const flagged7 = await staleOpenOrders(7, 50);
      const mine = flagged7.filter((o) => [codYoung.id, codOld.id, shopOld.id, codConfirmed.id, codCancelled.id, codTest.id, cod.id].includes(o.id)).map((o) => o.id);
      check('the flag lists a cash-on-delivery order from 7 days 1 hour and a pay-in-store one, not one from 6 days 23 hours', mine.includes(codOld.id) && mine.includes(shopOld.id) && !mine.includes(codYoung.id), mine);
      check('…not a confirmed one, a cancelled one, or a test order', !mine.includes(codConfirmed.id) && !mine.includes(codCancelled.id) && !mine.includes(codTest.id));
      check('…and the 10-day-old cash-on-delivery order from the sweep section above is in it', mine.includes(cod.id));
      check('…the oldest first, with the whole days they have waited', flagged7.findIndex((o) => o.id === cod.id) < flagged7.findIndex((o) => o.id === shopOld.id) && flagged7.find((o) => o.id === codOld.id)?.ageDays === 7 && flagged7.find((o) => o.id === shopOld.id)?.ageDays === 9);
      check('the count agrees with the list (and a transfer order is never in it)', (await staleOpenOrderCount()) === staleBefore + 3 && !flagged7.some((o) => o.id === young.id), [await staleOpenOrderCount(), staleBefore]);
      check('the flag never cancels anything: all of them are still pending', (await row(codOld.id)).status === 'pending' && (await row(shopOld.id)).status === 'pending' && (await row(cod.id)).status === 'pending');
      await db.update(coupons).set({ isActive: false }).where(eq(coupons.code, 'WELCOME5'));
    }

    console.log('  Card minimum');
    const { CARD_MIN_CENTS } = await import('../src/lib/pricing');
    await db.update(coupons).set({ isActive: true, type: 'fixed', value: 100000, minSubtotalCents: 0, maxUses: null }).where(eq(coupons.code, 'WELCOME5'));
    const free = await createOrder({ ...base, shippingMethod: 'pickup', paymentMethod: 'card', couponCode: 'WELCOME5', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, cardOpts);
    check(`a card order below ${CARD_MIN_CENTS} cents (a coupon covers it all) is refused before stock is reserved`, !free.ok && free.reason === 'invalid_method', free);
    await db.update(coupons).set({ isActive: false }).where(eq(coupons.code, 'WELCOME5'));

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
    await deliverPendingMail({ orderId: o10.id }); // recordPayment only queues the mails: send them, so the next step sees only its own
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
    await deliverPendingMail({ orderId: rf.id });
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
    await recordPaymentAttempt(mp.id, { provider: 'viva', ref: 'R-MAN-1' });
    await db.update(orders).set({ paymentStatus: 'paid', paidAt: new Date() }).where(eq(orders.id, mp.id));
    const mpInfo = { provider: 'viva', ref: 'T-MAN-1', amountCents: mp.totalCents, attemptRef: 'R-MAN-1' };
    const manualEvents = async () => (await eventsOf(mp.id)).filter((e) => e.message.includes('αντιστοιχίστηκε'));
    check('a card payment on an order marked paid by hand → paid_after_manual', (await recordPayment(mp.id, mpInfo)) === 'paid_after_manual');
    const mpRow = await row(mp.id);
    check('…flagged for review', mpRow.paymentFlag === 'review', mpRow.paymentFlag);
    check('…the gateway transaction id is stored on the order', mpRow.paymentTransactionId === 'T-MAN-1' && mpRow.paymentProvider === 'viva', [mpRow.paymentTransactionId, mpRow.paymentProvider]);
    check("…the attempt becomes 'paid'", (await attemptByRef('R-MAN-1'))?.status === 'paid', await attemptByRef('R-MAN-1'));
    const manual = await manualEvents();
    check('…the timeline says it was marked by hand and matched (one event)', manual.length === 1 && manual[0].message.includes('χειροκίνητα'), manual.map((e) => e.message));
    check('…and that event does not call it a second payment', manual.length === 1 && !manual[0].message.includes('δεύτερη'), manual.map((e) => e.message));
    check('a repeat of the same payment → already_paid', (await recordPayment(mp.id, mpInfo)) === 'already_paid');
    check('…and writes no new event', (await manualEvents()).length === 1, (await manualEvents()).length);

    console.log('  Refunded by hand, then paid');
    const mr = await newCard();
    await recordPaymentAttempt(mr.id, { provider: 'viva', ref: 'R-MR-1' });
    await db.update(orders).set({ paymentStatus: 'refunded', paidAt: new Date() }).where(eq(orders.id, mr.id));
    const mrInfo = { provider: 'viva', ref: 'T-MR-1', amountCents: mr.totalCents, attemptRef: 'R-MR-1' };
    check('a refunded order with no stored reference and a gateway payment → paid_after_refund', (await recordPayment(mr.id, mrInfo)) === 'paid_after_refund');
    const mrRow = await row(mr.id);
    check('…the gateway reference and provider are stored on the order', mrRow.paymentTransactionId === 'T-MR-1' && mrRow.paymentProvider === 'viva', [mrRow.paymentTransactionId, mrRow.paymentProvider]);
    check("…the order stays 'refunded'", mrRow.paymentStatus === 'refunded', mrRow.paymentStatus);
    check('…flagged for review', mrRow.paymentFlag === 'review', mrRow.paymentFlag);
    check("…the attempt becomes 'paid'", (await attemptByRef('R-MR-1'))?.status === 'paid', await attemptByRef('R-MR-1'));
    const refundEvents = (await eventsOf(mr.id)).filter((e) => e.message.includes('επιστραφείσα'));
    check('…the timeline says it was refunded by hand, with ΠΡΟΣΟΧΗ and «Το χειρίστηκα» (one event)', refundEvents.length === 1 && refundEvents[0].message.includes('ΠΡΟΣΟΧΗ') && refundEvents[0].message.includes('«Το χειρίστηκα»'), refundEvents.map((e) => e.message));
    check('…and that event does not call it a second payment', refundEvents.every((e) => !e.message.includes('δεύτερη')), refundEvents.map((e) => e.message));
    const mrEventsBefore = (await eventsOf(mr.id)).length;
    check('a repeat of the same payment → already_paid', (await recordPayment(mr.id, mrInfo)) === 'already_paid');
    check('…and writes no new event', (await eventsOf(mr.id)).length === mrEventsBefore, [mrEventsBefore, (await eventsOf(mr.id)).length]);

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
    check('a targeted coupon keeps the offer wording', !!targetMinQ.error && targetMinQ.error.endsWith('στα προϊόντα στα οποία αναφέρεται το κουπόνι.'), targetMinQ.error);
    await addCoupon({ code: 'TEST-MSG-PLAIN', excludeSaleItems: false, minSubtotalCents: 10000000 });
    const plainMinQ = await quote('TEST-MSG-PLAIN', cart(P1.id, P2.id));
    check('an untargeted coupon without exclusion keeps the plain message', plainMinQ.error === `Το κουπόνι ισχύει για αγορές από ${(10000000 / 100).toFixed(2).replace('.', ',')} € και πάνω.`, plainMinQ.error);
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

  console.log('Round 3 fixes');
  {
    const { getOrderByNumber, recordPayment, releaseAbandonedCardOrders } = await import('../src/lib/orders');
    const { recordPaymentAttempt } = await import('../src/lib/payments/attempts');
    const { settleCardPayment } = await import('../src/lib/payments/settle');
    const { newOrderNotificationMail } = await import('../src/lib/email');
    const { getSettings } = await import('../src/lib/settings.server');
    const outbox = path.join(dir, 'data', 'outbox');
    const outboxFiles = () => {
      try {
        return readdirSync(outbox);
      } catch {
        return [] as string[];
      }
    };
    // the subject is in the comment at the top of each outbox file: «<!-- to: … | subject: … -->»
    const subjectOf = (file: string) => readFileSync(path.join(outbox, file), 'utf8').match(/subject: (.*?) -->/s)?.[1] ?? '';
    const row = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
    const eventsOf = (orderId: number) => db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    const cardOpts = { customerId: null, cardProviderConfigured: true };
    const newCardOrder = async () => {
      const r = await createOrder({ ...base, paymentMethod: 'card', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, cardOpts);
      if (!r.ok) throw new Error(`card order not created: ${r.message}`);
      return r.order;
    };
    const backdate3h = (id: number) => db.update(orders).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(orders.id, id));
    await db.update(variants).set({ trackStock: true, stock: 200 }).where(eq(variants.id, variant.id));

    console.log('  Manual payment alert');
    const ma = await newCardOrder();
    await recordPaymentAttempt(ma.id, { provider: 'viva', ref: 'R3-MA-1' });
    await db.update(orders).set({ paymentStatus: 'paid', paidAt: new Date() }).where(eq(orders.id, ma.id));
    const beforeMa = new Set(outboxFiles());
    const rMa = await settleCardPayment({ id: ma.id, number: ma.number }, { provider: 'viva', ref: 'R3-MA-TX', amountCents: ma.totalCents, attemptRef: 'R3-MA-1' });
    check('settleCardPayment on an order marked paid by hand → paid_after_manual', rMa === 'paid_after_manual', rMa);
    const newMa = outboxFiles().filter((f) => !beforeMa.has(f));
    const maSubjects = newMa.map(subjectOf);
    check('…writes exactly two new files: one owner alert and one buyer confirmation', newMa.length === 2, maSubjects);
    check('…the owner alert subject starts «Χρειάζεται έλεγχος: πληρωμή»', maSubjects.filter((s) => s.startsWith('Χρειάζεται έλεγχος: πληρωμή')).length === 1, maSubjects);
    check('…the buyer confirmation subject starts «Η παραγγελία σας»', maSubjects.filter((s) => s.startsWith('Η παραγγελία σας')).length === 1, maSubjects);

    console.log('  Refund alert');
    const mrA = await newCardOrder();
    await recordPaymentAttempt(mrA.id, { provider: 'viva', ref: 'R3-MRA-1' });
    await db.update(orders).set({ paymentStatus: 'refunded', paidAt: new Date() }).where(eq(orders.id, mrA.id));
    const beforeMrA = new Set(outboxFiles());
    const rMrA = await settleCardPayment({ id: mrA.id, number: mrA.number }, { provider: 'viva', ref: 'R3-MRA-TX', amountCents: mrA.totalCents, attemptRef: 'R3-MRA-1' });
    check('settleCardPayment on an order refunded by hand → paid_after_refund', rMrA === 'paid_after_refund', rMrA);
    const newMrA = outboxFiles().filter((f) => !beforeMrA.has(f));
    const mrASubjects = newMrA.map(subjectOf);
    check('…writes exactly one new file: the owner alert', newMrA.length === 1 && !!mrASubjects[0]?.startsWith('Χρειάζεται έλεγχος: πληρωμή'), mrASubjects);
    check('…and no confirmation goes to the buyer', !mrASubjects.some((s) => s.startsWith('Η παραγγελία σας')), mrASubjects);

    console.log('  Abandoned orders that must stay');
    const cod = await createOrder({ ...base, paymentMethod: 'cod', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
    const bank = await createOrder({ ...base, paymentMethod: 'bank_transfer', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, opts);
    if (!cod.ok || !bank.ok) throw new Error('cod or bank order not created');
    const confirmedCard = await newCardOrder();
    await db.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, confirmedCard.id));
    const oldCard = await newCardOrder();
    for (const id of [cod.order.id, bank.order.id, confirmedCard.id, oldCard.id]) await backdate3h(id);
    await releaseAbandonedCardOrders();
    check('an old pending cash-on-delivery order is not cancelled', (await row(cod.order.id)).status === 'pending', (await row(cod.order.id)).status);
    check('an old pending bank-transfer order is not cancelled', (await row(bank.order.id)).status === 'pending', (await row(bank.order.id)).status);
    check('an old confirmed card order that is still unpaid is not cancelled', (await row(confirmedCard.id)).status === 'confirmed' && (await row(confirmedCard.id)).paymentStatus === 'pending', [(await row(confirmedCard.id)).status, (await row(confirmedCard.id)).paymentStatus]);
    check('an old pending unpaid card order IS cancelled', (await row(oldCard.id)).status === 'cancelled', (await row(oldCard.id)).status);

    console.log('  History wording');
    const hw = await newCardOrder();
    await recordPayment(hw.id, { provider: 'viva', ref: 'HW-T2', amountCents: hw.totalCents });
    const dupOutcome = await recordPayment(hw.id, { provider: 'viva', ref: 'HW-T1', amountCents: hw.totalCents, attemptRef: 'HW-ATT' });
    check('a second payment on another checkout → duplicate_payment', dupOutcome === 'duplicate_payment', dupOutcome);
    const dupLine = (await eventsOf(hw.id)).find((e) => e.message.includes('δεύτερη'))?.message ?? '';
    check('the duplicate line uses the Greek comma amount', /\d+,\d{2}/.test(dupLine), dupLine);
    check('…and names «Το χειρίστηκα»', dupLine.includes('«Το χειρίστηκα»'), dupLine);
    const hl = await newCardOrder();
    await cancelOrder(hl.id, 'test');
    const lateOutcome = await recordPayment(hl.id, { provider: 'viva', ref: 'HL-T1', amountCents: hl.totalCents });
    check('a payment on a cancelled order → late_cancelled', lateOutcome === 'late_cancelled', lateOutcome);
    const lateLine = (await eventsOf(hl.id)).find((e) => e.message.includes('ήρθε αφού'))?.message ?? '';
    check('the late line uses the Greek comma amount', /\d+,\d{2}/.test(lateLine), lateLine);
    check('…and names «Επιστροφή χρημάτων»', lateLine.includes('«Επιστροφή χρημάτων»'), lateLine);

    console.log('  Payment mails');
    const pm = await newCardOrder();
    await recordPaymentAttempt(pm.id, { provider: 'viva', ref: 'PM-1' });
    const beforePm = new Set(outboxFiles());
    const rPm = await settleCardPayment({ id: pm.id, number: pm.number }, { provider: 'viva', ref: 'PM-TX', amountCents: pm.totalCents, attemptRef: 'PM-1' });
    check('a payment on an unpaid card order → paid', rPm === 'paid', rPm);
    const newPm = outboxFiles().filter((f) => !beforePm.has(f));
    const pmSubjects = newPm.map(subjectOf);
    check('…writes two files: the buyer confirmation and the owner alert', newPm.length === 2, pmSubjects);
    check('…one confirmation whose subject starts «Η παραγγελία σας»', pmSubjects.filter((s) => s.startsWith('Η παραγγελία σας')).length === 1, pmSubjects);
    check('…and one owner alert whose subject starts «Πληρώθηκε με κάρτα:»', pmSubjects.filter((s) => s.startsWith('Πληρώθηκε με κάρτα:')).length === 1, pmSubjects);

    console.log('  Pending-card subject');
    const settingsNow = await getSettings();
    const pendingCardFull = await getOrderByNumber((await newCardOrder()).number);
    const codFull = await getOrderByNumber(cod.order.number);
    check('a new card order awaiting payment has the «ΑΝΑΜΕΝΕΤΑΙ ΠΛΗΡΩΜΗ ΜΕ ΚΑΡΤΑ» subject suffix', !!pendingCardFull && newOrderNotificationMail(pendingCardFull, settingsNow).subject.endsWith('ΑΝΑΜΕΝΕΤΑΙ ΠΛΗΡΩΜΗ ΜΕ ΚΑΡΤΑ'), pendingCardFull?.paymentStatus);
    check('a cash-on-delivery order has no such suffix', !!codFull && !newOrderNotificationMail(codFull, settingsNow).subject.includes('ΑΝΑΜΕΝΕΤΑΙ'), codFull?.paymentMethod);
  }

  console.log('Payment fixes (older Stripe checkouts, processing payments, renamed coupons)');
  {
    const { recordPaymentAttempt } = await import('../src/lib/payments/attempts');
    const { releaseAbandonedCardOrders } = await import('../src/lib/orders');
    const { paymentAttempts } = await import('../src/lib/db/schema');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    const { POST } = await import('../src/app/api/payments/stripe/webhook/route');
    const { stripe } = await import('../src/lib/payments/stripe');
    const row = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
    const attemptOf = async (ref: string) => (await db.select().from(paymentAttempts).where(eq(paymentAttempts.ref, ref)))[0];
    const cardOpts = { customerId: null, cardProviderConfigured: true };
    await db.update(variants).set({ trackStock: true, stock: 20 }).where(eq(variants.id, variant.id));
    const newCard = async (extra: Record<string, unknown> = {}) => {
      const r = await createOrder({ ...base, paymentMethod: 'card', lines: [{ variantId: variant.id, quantity: 1 }], ...extra }, settings, cardOpts);
      if (!r.ok) throw new Error(`card order not created: ${r.message}`);
      return r.order;
    };
    // a signed Stripe event, delivered to the real webhook route
    let eventNo = 0;
    const deliver = (type: string, session: Record<string, unknown>) => {
      const payload = JSON.stringify({ id: `evt_t${++eventNo}`, object: 'event', type, data: { object: { object: 'checkout.session', ...session } } });
      const signature = stripe().webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });
      return POST(new Request('http://localhost/api/payments/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: payload }));
    };
    const session = (id: string, order: { id: number; totalCents: number }, paid: boolean) => ({ id, payment_status: paid ? 'paid' : 'unpaid', status: 'complete', metadata: { orderId: String(order.id) }, amount_total: order.totalCents, payment_intent: `pi_${id}` });

    console.log('  Stripe: a payment on an older checkout');
    const sA = await newCard();
    await recordPaymentAttempt(sA.id, { provider: 'stripe', ref: 'cs_old_A' });
    await recordPaymentAttempt(sA.id, { provider: 'stripe', ref: 'cs_new_B' });
    const answer = await deliver('checkout.session.completed', session('cs_old_A', sA, true));
    check('the webhook answers 200 for the older checkout', answer.status === 200, answer.status);
    check('…and the order IS paid (not left unpaid behind a 200)', (await row(sA.id)).paymentStatus === 'paid', (await row(sA.id)).paymentStatus);

    console.log('  Stripe: a delayed payment is "processing", not open');
    const sP = await newCard();
    await recordPaymentAttempt(sP.id, { provider: 'stripe', ref: 'cs_proc_P' });
    await deliver('checkout.session.completed', session('cs_proc_P', sP, false));
    check('the unpaid-but-complete session is remembered as processing', (await attemptOf('cs_proc_P'))?.status === 'processing', (await attemptOf('cs_proc_P'))?.status);
    check('…the order is still unpaid', (await row(sP.id)).paymentStatus === 'pending');
    await db.update(orders).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(orders.id, sP.id));
    await db.update(paymentAttempts).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(paymentAttempts.ref, 'cs_proc_P'));
    await releaseAbandonedCardOrders();
    check('…and the 2 h release does not cancel it', (await row(sP.id)).status === 'pending', (await row(sP.id)).status);
    const { hasProcessingPayment } = await import('../src/lib/payments/attempts');
    check('…and a retry is blocked while it is processing', (await hasProcessingPayment(sP.id)) === true);
    await deliver('checkout.session.async_payment_succeeded', session('cs_proc_P', sP, true));
    const sPaid = await row(sP.id);
    check('when the money arrives the order is paid and confirmed', sPaid.paymentStatus === 'paid' && sPaid.status === 'confirmed', [sPaid.paymentStatus, sPaid.status]);
    check('…and the attempt is paid', (await attemptOf('cs_proc_P'))?.status === 'paid', (await attemptOf('cs_proc_P'))?.status);

    const sF = await newCard();
    await recordPaymentAttempt(sF.id, { provider: 'stripe', ref: 'cs_proc_F' });
    await deliver('checkout.session.completed', session('cs_proc_F', sF, false));
    await deliver('checkout.session.async_payment_failed', session('cs_proc_F', sF, false));
    check('a delayed payment that fails frees the order for a retry', (await attemptOf('cs_proc_F'))?.status === 'failed' && (await hasProcessingPayment(sF.id)) === false, (await attemptOf('cs_proc_F'))?.status);

    console.log('  Stripe: the currency is checked');
    {
      const { mailOutbox, orderEvents } = await import('../src/lib/db/schema');
      const { GET: stripeReturn } = await import('../src/app/api/payments/stripe/return/route');
      const alertsOf = async (orderId: number) => (await db.select().from(mailOutbox).where(eq(mailOutbox.orderId, orderId))).filter((m) => m.problem === 'currency_mismatch');
      const usdEvent = async (orderId: number) => (await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId))).some((e) => e.message.includes('νόμισμα USD'));

      const sU = await newCard();
      await recordPaymentAttempt(sU.id, { provider: 'stripe', ref: 'cs_usd_W' });
      const hookUsd = await deliver('checkout.session.completed', { ...session('cs_usd_W', sU, true), currency: 'usd' });
      const rU = await row(sU.id);
      check('webhook: a paid Stripe session in USD answers 200', hookUsd.status === 200, hookUsd.status);
      check('…the order is NOT paid and is flagged for review', rU.paymentStatus !== 'paid' && rU.paymentFlag === 'review', [rU.paymentStatus, rU.paymentFlag]);
      check('…the checkout is marked as a mismatch', (await attemptOf('cs_usd_W'))?.status === 'mismatch', (await attemptOf('cs_usd_W'))?.status);
      check('…the order history names USD (outcome currency_mismatch)', await usdEvent(sU.id));
      check('…and the owner alert is queued as a currency mismatch', (await alertsOf(sU.id)).length === 1, (await alertsOf(sU.id)).length);

      const sR = await newCard();
      await recordPaymentAttempt(sR.id, { provider: 'stripe', ref: 'cs_usd_R' });
      const sessions = stripe().checkout.sessions as unknown as { retrieve: (id: string) => Promise<unknown> };
      const realRetrieve = sessions.retrieve;
      sessions.retrieve = async () => ({ ...session('cs_usd_R', sR, true), client_reference_id: sR.number, currency: 'usd' });
      try {
        const back = await stripeReturn(new Request('http://localhost/api/payments/stripe/return?session_id=cs_usd_R'));
        const rR = await row(sR.id);
        check('return route: a USD payment does not get the «thank you» page', !!back.headers.get('location')?.includes(`/order/${sR.number}`) && !back.headers.get('location')?.includes('payment=success'), back.headers.get('location'));
        check('…the order is NOT paid, flagged, and the history names USD', rR.paymentStatus !== 'paid' && rR.paymentFlag === 'review' && (await usdEvent(sR.id)), [rR.paymentStatus, rR.paymentFlag]);
      } finally {
        sessions.retrieve = realRetrieve;
      }

      const sE = await newCard();
      await recordPaymentAttempt(sE.id, { provider: 'stripe', ref: 'cs_eur_lc' });
      await deliver('checkout.session.completed', { ...session('cs_eur_lc', sE, true), currency: 'eur' });
      const rE = await row(sE.id);
      check('webhook: lowercase «eur» is accepted as EUR, the order is paid and not flagged', rE.paymentStatus === 'paid' && rE.paymentFlag !== 'review' && (await alertsOf(sE.id)).length === 0, [rE.paymentStatus, rE.paymentFlag]);
    }

    console.log('  A renamed coupon');
    await db.update(coupons).set({ isActive: true, minSubtotalCents: 0, maxUses: 1, usedCount: 0 }).where(eq(coupons.code, 'WELCOME5'));
    await db.update(variants).set({ stock: 20 }).where(eq(variants.id, variant.id));
    const cp = await newCard({ couponCode: 'WELCOME5' });
    const [couponRow] = await db.select().from(coupons).where(eq(coupons.code, 'WELCOME5'));
    check('the coupon use is counted', couponRow.usedCount === 1, couponRow.usedCount);
    await db.update(coupons).set({ code: 'WELCOME5-RENAMED' }).where(eq(coupons.id, couponRow.id));
    await cancelOrder(cp.id, 'test');
    const afterCancel = (await db.select().from(coupons).where(eq(coupons.id, couponRow.id)))[0];
    check('cancelling the order after the coupon was renamed still gives the use back', afterCancel.usedCount === 0, afterCancel.usedCount);
    await db.update(coupons).set({ code: 'WELCOME5' }).where(eq(coupons.id, couponRow.id));

    console.log('  Stripe: a paid checkout that matches no order');
    {
      const { unmatchedPayments } = await import('../src/lib/db/schema');
      const outboxDir = path.join(dir, 'data', 'outbox');
      const filesNow = () => {
        try {
          return readdirSync(outboxDir);
        } catch {
          return [] as string[];
        }
      };
      const orphan = { id: 'cs_orphan_1', payment_status: 'paid', status: 'complete', client_reference_id: 'OC-NOPE-1', metadata: { orderId: '999991', orderNumber: 'OC-NOPE-1' }, amount_total: 1999, currency: 'eur', payment_intent: 'pi_orphan_1' };
      const before = new Set(filesNow());
      const a1 = await deliver('checkout.session.completed', orphan);
      check('the webhook answers 200 for a paid checkout with no order', a1.status === 200, a1.status);
      const rows = await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'));
      check('…and the payment is kept in unmatched_payments', rows.length === 1 && rows[0].transactionId === 'pi_orphan_1' && rows[0].amountCents === 1999 && rows[0].currency === 'EUR' && rows[0].merchantTrns === 'OC-NOPE-1', rows);
      const mails = filesNow().filter((f) => !before.has(f));
      check('…and the owner is mailed once', mails.length === 1, mails);
      await deliver('checkout.session.completed', orphan);
      check('a repeated delivery adds no second row and no second mail', (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).length === 1 && filesNow().filter((f) => !before.has(f)).length === 1);
      await deliver('checkout.session.completed', { ...orphan, id: 'cs_orphan_2', payment_status: 'unpaid', payment_intent: 'pi_orphan_2' });
      await deliver('checkout.session.async_payment_failed', { ...orphan, id: 'cs_orphan_3', payment_status: 'unpaid', payment_intent: 'pi_orphan_3' });
      check('an unpaid or failed session with no order records nothing', (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).length === 1);

      await db.delete(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe')); // the rows above are done with
      // the buyer's browser coming back from Stripe: same helper, and the buyer is sent to the «needs the shop» page
      const { GET: stripeReturn } = await import('../src/app/api/payments/stripe/return/route');
      const sessions = stripe().checkout.sessions as unknown as { retrieve: (id: string) => Promise<unknown> };
      const realRetrieve = sessions.retrieve;
      const answers: Record<string, Record<string, unknown>> = {
        cs_orphan_ret: { id: 'cs_orphan_ret', payment_status: 'paid', status: 'complete', client_reference_id: 'OC-NOPE-2', metadata: { orderId: '999992', orderNumber: 'OC-NOPE-2' }, amount_total: 2550, currency: 'eur', payment_intent: 'pi_orphan_ret' },
        cs_orphan_unpaid: { id: 'cs_orphan_unpaid', payment_status: 'unpaid', status: 'open', client_reference_id: 'OC-NOPE-3', metadata: { orderId: '999993', orderNumber: 'OC-NOPE-3' }, amount_total: 2550, currency: 'eur', payment_intent: null },
      };
      sessions.retrieve = async (id: string) => answers[id];
      try {
        const beforeRet = new Set(filesNow());
        const ret = await stripeReturn(new Request('http://localhost/api/payments/stripe/return?session_id=cs_orphan_ret'));
        check('the RETURN of a paid checkout with no order goes to the order-status page, not home', ret.headers.get('location')?.endsWith('/order-status?payment=review') === true, ret.headers.get('location'));
        const retRows = await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'));
        check('…the payment is kept in unmatched_payments (EUR, the order reference, the amount)', retRows.length === 1 && retRows[0].transactionId === 'pi_orphan_ret' && retRows[0].amountCents === 2550 && retRows[0].currency === 'EUR' && retRows[0].merchantTrns === 'OC-NOPE-2', retRows);
        const retMails = filesNow().filter((f) => !beforeRet.has(f));
        check('…and the owner is mailed once', retMails.length === 1 && retMails[0].includes('oilcenterthess@gmail.com'), retMails);
        await stripeReturn(new Request('http://localhost/api/payments/stripe/return?session_id=cs_orphan_ret'));
        check('…coming back again adds no second row and no second mail', (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).length === 1 && filesNow().filter((f) => !beforeRet.has(f)).length === 1);
        const retUnpaid = await stripeReturn(new Request('http://localhost/api/payments/stripe/return?session_id=cs_orphan_unpaid'));
        check('an UNPAID checkout with no order goes home and records nothing', retUnpaid.headers.get('location')?.endsWith('/') === true && !retUnpaid.headers.get('location')?.includes('order-status') && (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).length === 1, retUnpaid.headers.get('location'));
        // the webhook for the same payment finds the row the return made: still one row, one mail
        await deliver('checkout.session.completed', { ...answers.cs_orphan_ret });
        check('the webhook for the same payment adds nothing either', (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).length === 1 && filesNow().filter((f) => !beforeRet.has(f)).length === 1);

        // a paid session this shop did not create (a Payment Link, another site on the same Stripe account): not ours, so not reported
        const rowsBefore = (await db.select().from(unmatchedPayments)).length;
        const mailsBefore = filesNow().length;
        const foreign: Record<string, Record<string, unknown>> = {
          cs_foreign_bare: { id: 'cs_foreign_bare', payment_status: 'paid', status: 'complete', amount_total: 4200, currency: 'eur', payment_intent: 'pi_foreign_bare' },
          cs_foreign_noref: { id: 'cs_foreign_noref', payment_status: 'paid', status: 'complete', metadata: { orderId: '999994' }, amount_total: 4200, currency: 'eur', payment_intent: 'pi_foreign_noref' },
          cs_foreign_nometa: { id: 'cs_foreign_nometa', payment_status: 'paid', status: 'complete', client_reference_id: 'SOMEONE-ELSE', amount_total: 4200, currency: 'eur', payment_intent: 'pi_foreign_nometa' },
          cs_foreign_badmeta: { id: 'cs_foreign_badmeta', payment_status: 'paid', status: 'complete', client_reference_id: 'OC-X', metadata: { orderId: 'abc' }, amount_total: 4200, currency: 'eur', payment_intent: 'pi_foreign_badmeta' },
        };
        Object.assign(answers, foreign);
        for (const [id, sess] of Object.entries(foreign)) {
          const hook = await deliver('checkout.session.completed', sess);
          const back = await stripeReturn(new Request(`http://localhost/api/payments/stripe/return?session_id=${id}`));
          check(`${id}: the webhook answers 200 and the return goes home`, hook.status === 200 && back.headers.get('location')?.includes('order-status') === false, [hook.status, back.headers.get('location')]);
        }
        check('paid sessions without our markers record nothing', (await db.select().from(unmatchedPayments)).length === rowsBefore, (await db.select().from(unmatchedPayments)).length - rowsBefore);
        check('…and mail no one', filesNow().length === mailsBefore, filesNow().length - mailsBefore);
        check('…while our own marked session is still reported (the filter is not a blanket ignore)', (await db.select().from(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'))).some((r) => r.transactionId === 'pi_orphan_ret'));
      } finally {
        sessions.retrieve = realRetrieve;
      }
      await db.delete(unmatchedPayments).where(eq(unmatchedPayments.provider, 'stripe'));
    }

    console.log('  Payment mails survive a crash (mail queue)');
    {
      const { mailOutbox, orderEvents } = await import('../src/lib/db/schema');
      const { countGivenUpMails, retryDelayMs } = await import('../src/lib/payments/mail-delivery');
      const { settleCardPayment } = await import('../src/lib/payments/settle');
      const { recordPayment } = await import('../src/lib/orders');
      const eventsOf = (orderId: number) => db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
      const outboxDir = path.join(dir, 'data', 'outbox');
      const filesNow = () => {
        try {
          return readdirSync(outboxDir);
        } catch {
          return [] as string[];
        }
      };
      const queued = (orderId: number) => db.select().from(mailOutbox).where(eq(mailOutbox.orderId, orderId));

      // (a) the process dies between the payment commit and the send
      const q1 = await newCard();
      await recordPaymentAttempt(q1.id, { provider: 'viva', ref: 'R-Q1' });
      const info1 = { provider: 'viva', ref: 'T-Q1', amountCents: q1.totalCents, attemptRef: 'R-Q1' };
      const before1 = new Set(filesNow());
      check('a payment is recorded', (await recordPayment(q1.id, info1)) === 'paid');
      const rows1 = await queued(q1.id);
      check('…the confirmation and the shop notice are queued in the same transaction', rows1.length === 2 && rows1.every((r) => r.sentAt === null), rows1.map((r) => r.kind));
      check('…and nothing has been sent yet (the crash)', filesNow().filter((f) => !before1.has(f)).length === 0);
      check("the gateway's retry finds the payment already recorded", (await settleCardPayment({ id: q1.id, number: q1.number }, info1)) === 'already_paid');
      check('…and the queued mails go out now: one to the buyer, one to the shop', filesNow().filter((f) => !before1.has(f)).length === 2, filesNow().filter((f) => !before1.has(f)));
      check('…and the queue is marked sent', (await queued(q1.id)).every((r) => r.sentAt !== null));
      check('…and the timeline records the confirmation', (await eventsOf(q1.id)).some((e) => e.message.startsWith('Στάλθηκε e-mail επιβεβαίωσης')));
      await settleCardPayment({ id: q1.id, number: q1.number }, info1);
      check('a further retry sends nothing more', filesNow().filter((f) => !before1.has(f)).length === 2);

      // (b) the mail service is down, then comes back
      const q2 = await newCard();
      await recordPaymentAttempt(q2.id, { provider: 'viva', ref: 'R-Q2' });
      const realFetch = globalThis.fetch;
      const savedKey = process.env.RESEND_API_KEY;
      process.env.RESEND_API_KEY = 're_test_dummy';
      globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;
      try {
        await settleCardPayment({ id: q2.id, number: q2.number }, { provider: 'viva', ref: 'T-Q2', amountCents: q2.totalCents, attemptRef: 'R-Q2' });
        const down = await queued(q2.id);
        check('with the mail service down both mails stay queued, one failed attempt each', down.length === 2 && down.every((r) => r.sentAt === null && r.attempts === 1 && r.givenUpAt === null), down);
        const failures = (await eventsOf(q2.id)).filter((e) => e.message.startsWith('ΑΠΟΤΥΧΙΑ αποστολής'));
        check('…and the timeline says so once per mail, with "will retry"', failures.length === 2 && failures.every((e) => e.message.includes('Θα ξαναδοκιμαστεί')), failures.map((e) => e.message));
        // back-off: the first retry is due in about a minute, and asking again before that spends no attempt
        const waits = down.map((r) => (r.nextAttemptAt ? r.nextAttemptAt.getTime() - Date.now() : -1));
        check('…the first retry is due in about a minute', waits.every((w) => w > 50_000 && w <= 61_000), waits);
        await deliverPendingMail({ orderId: q2.id });
        await deliverPendingMail();
        check('…asking again at once (a gateway retry, the sweep) spends no attempt', (await queued(q2.id)).every((r) => r.attempts === 1), (await queued(q2.id)).map((r) => r.attempts));
      } finally {
        globalThis.fetch = realFetch;
        if (savedKey === undefined) delete process.env.RESEND_API_KEY;
        else process.env.RESEND_API_KEY = savedKey;
      }
      await db.update(mailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(mailOutbox.orderId, q2.id)); // a minute later
      check('the sweep (all pending mail) sends them once the service is back and the wait is over', (await deliverPendingMail()) >= 2);
      const sent2 = await queued(q2.id);
      check('…and both are marked sent, after the one failed attempt', sent2.length === 2 && sent2.every((r) => r.sentAt !== null && r.attempts === 1), sent2);

      // (c) two senders at once: each queued mail goes out once
      const q3 = await newCard();
      await recordPaymentAttempt(q3.id, { provider: 'viva', ref: 'R-Q3' });
      await recordPayment(q3.id, { provider: 'viva', ref: 'T-Q3', amountCents: q3.totalCents, attemptRef: 'R-Q3' });
      const before3 = new Set(filesNow());
      await Promise.all([deliverPendingMail({ orderId: q3.id }), deliverPendingMail({ orderId: q3.id })]);
      check('two concurrent senders write each mail once', filesNow().filter((f) => !before3.has(f)).length === 2, filesNow().filter((f) => !before3.has(f)));

      // (d) a mail that can never be sent: back-off 1, 5, 15, 60 minutes then hourly, given up at the 27th failure (about a day)
      const q4 = await newCard();
      await recordPaymentAttempt(q4.id, { provider: 'viva', ref: 'R-Q4' });
      await recordPayment(q4.id, { provider: 'viva', ref: 'T-Q4', amountCents: q4.totalCents + 1, attemptRef: 'R-Q4' });
      process.env.RESEND_API_KEY = 're_test_dummy';
      globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;
      const delaysMin: number[] = [];
      let waitedMs = 0;
      try {
        for (let i = 0; i < 40; i++) {
          // time passes: make the row due, then let the sweep try it
          await db.update(mailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(mailOutbox.orderId, q4.id));
          await deliverPendingMail({ orderId: q4.id });
          const [r] = await queued(q4.id);
          if (r.givenUpAt) break;
          const wait = r.nextAttemptAt ? r.nextAttemptAt.getTime() - Date.now() : -1;
          delaysMin.push(Math.round(wait / 60_000));
          waitedMs += wait;
        }
      } finally {
        globalThis.fetch = realFetch;
        if (savedKey === undefined) delete process.env.RESEND_API_KEY;
        else process.env.RESEND_API_KEY = savedKey;
      }
      const gone = await queued(q4.id);
      check('a mail that can never be sent is given up at the 27th failure, not retried forever', gone.length === 1 && gone[0].attempts === 27 && gone[0].givenUpAt !== null, gone);
      check('…the waits between attempts are 1, 5, 15, 60 minutes and then hourly', delaysMin.length === 26 && [1, 5, 15, 60].every((m, i) => delaysMin[i] === m) && delaysMin.slice(3).every((m) => m === 60), delaysMin);
      check('…which covers about a day (23 hours of waiting)', waitedMs / 3_600_000 > 23 && waitedMs / 3_600_000 < 23.5 && retryDelayMs(1) === 60_000 && retryDelayMs(4) === 3_600_000 && retryDelayMs(99) === 3_600_000, waitedMs / 3_600_000);
      check('…and the timeline says it will not be retried', (await eventsOf(q4.id)).some((e) => e.message.includes('Δεν θα ξαναδοκιμαστεί')));
      check('the given-up mail is counted for the dashboard', (await countGivenUpMails()) >= 1);
      const before = await countGivenUpMails();
      await db.update(mailOutbox).set({ givenUpAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }).where(eq(mailOutbox.orderId, q4.id));
      check('…and one given up more than 30 days ago is not', (await countGivenUpMails()) === before - 1, [before, await countGivenUpMails()]);
    }

    console.log('  A deleted and recreated coupon');
    await db.update(coupons).set({ usedCount: 0, maxUses: 1 }).where(eq(coupons.id, couponRow.id));
    const oldOrder = await newCard({ couponCode: 'WELCOME5' });
    const [oldCoupon] = await db.select().from(coupons).where(eq(coupons.id, couponRow.id));
    await db.delete(coupons).where(eq(coupons.id, couponRow.id));
    const [replacement] = await db.insert(coupons).values({ code: 'WELCOME5', type: oldCoupon.type, value: oldCoupon.value, minSubtotalCents: 0, maxUses: 1, usedCount: 0, isActive: true }).returning();
    const replacementOrder = await newCard({ couponCode: 'WELCOME5' });
    check('the replacement coupon is used once', (await db.select().from(coupons).where(eq(coupons.id, replacement.id)))[0].usedCount === 1);
    await cancelOrder(oldOrder.id, 'test');
    const replacementAfter = (await db.select().from(coupons).where(eq(coupons.id, replacement.id)))[0];
    check('cancelling an order of the DELETED coupon leaves the replacement\'s count alone', replacementAfter.usedCount === 1, replacementAfter.usedCount);
    const refused = await createOrder({ ...base, paymentMethod: 'card', couponCode: 'WELCOME5', lines: [{ variantId: variant.id, quantity: 1 }] }, settings, cardOpts);
    check('…so a one-use replacement is still used up', !refused.ok && refused.reason === 'coupon', refused.ok ? 'accepted' : refused);
    await cancelOrder(replacementOrder.id, 'test');
    check('cancelling the replacement\'s own order gives its use back', (await db.select().from(coupons).where(eq(coupons.id, replacement.id)))[0].usedCount === 0);
    await db.update(coupons).set({ maxUses: oldCoupon.maxUses, usedCount: 0 }).where(eq(coupons.id, replacement.id));
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
