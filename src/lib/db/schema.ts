import { relations } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Availability } from '@/lib/availability';
import type { HazardInfo } from '@/lib/ghs';

/*
 * Conventions
 *  - money is stored as integer cents, VAT included (Greek B2C pricing)
 *  - timestamps are unix milliseconds (Date in JS)
 *  - weights are grams, volumes are millilitres
 */

const id = () => integer('id').primaryKey({ autoIncrement: true });
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// ─── Settings (key → JSON) ───────────────────────────────────────────────────
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

// ─── Catalog ─────────────────────────────────────────────────────────────────
export const brands = sqliteTable(
  'brands',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    logoUrl: text('logo_url'),
    country: text('country'),
    isFeatured: integer('is_featured', { mode: 'boolean' }).notNull().default(false),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('brands_slug_uq').on(t.slug)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    parentId: integer('parent_id'),
    description: text('description'),
    /** key into the icon map in components/category-icon.tsx */
    icon: text('icon'),
    imageUrl: text('image_url'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('categories_slug_uq').on(t.slug), index('categories_parent_idx').on(t.parentId)],
);

export type BaseType = 'synthetic' | 'synthetic-technology' | 'semi-synthetic' | 'mineral';

export const products = sqliteTable(
  'products',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    brandId: integer('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    shortDescription: text('short_description'),
    description: text('description'),
    /** SAE grade, e.g. "5W-30". Kept as a column because it is the #1 filter. */
    viscosity: text('viscosity'),
    baseType: text('base_type').$type<BaseType>(),
    /** ACEA / API / OEM approvals exactly as printed on the label. */
    specs: text('specs', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Free-form extra attributes shown in the spec table: { "Χρώμα": "Κόκκινο" } */
    attributes: text('attributes', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    /** the pack's hazard labelling and safety data sheet (lib/ghs.ts). null = nobody has looked yet; shown only once confirmed */
    hazard: text('hazard', { mode: 'json' }).$type<HazardInfo>(),
    /** lower-cased, accent-stripped haystack. SQLite LIKE is not case-insensitive for Greek. */
    searchText: text('search_text').notNull().default(''),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    isFeatured: integer('is_featured', { mode: 'boolean' }).notNull().default(false),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    /** never shown to customers; the seed uses it to flag data the owner should double-check */
    internalNotes: text('internal_notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_slug_uq').on(t.slug),
    index('products_brand_idx').on(t.brandId),
    index('products_category_idx').on(t.categoryId),
    index('products_viscosity_idx').on(t.viscosity),
    index('products_active_idx').on(t.isActive),
  ],
);

export const productImages = sqliteTable(
  'product_images',
  {
    id: id(),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    alt: text('alt'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [index('product_images_product_idx').on(t.productId)],
);

/** A purchasable pack size of a product (1L, 4L, 20L, 300ml…). Every product has at least one. */
export const variants = sqliteTable(
  'variants',
  {
    id: id(),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    label: text('label').notNull(),
    volumeMl: integer('volume_ml'),
    priceCents: integer('price_cents').notNull(),
    /** "was" price; shown struck through when higher than priceCents */
    compareAtCents: integer('compare_at_cents'),
    stock: integer('stock').notNull().default(0),
    trackStock: integer('track_stock', { mode: 'boolean' }).notNull().default(true),
    /** set by hand (lib/availability.ts); counted stock at 0 overrides it */
    availability: text('availability').$type<Availability>().notNull().default('in_stock'),
    weightGrams: integer('weight_grams').notNull().default(0),
    /** EAN / GTIN printed under the barcode on the pack. Each pack size has its own. */
    barcode: text('barcode'),
    /** the manufacturer's own article number for this pack (Liqui Moly "3320", Motul "109471"). Skroutz matches products on it. */
    mpn: text('mpn'),
    imageUrl: text('image_url'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** false until the shop owner has confirmed the price (seed data ships with placeholders) */
    priceVerified: integer('price_verified', { mode: 'boolean' }).notNull().default(false),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('variants_sku_uq').on(t.sku), index('variants_product_idx').on(t.productId)],
);

export type PriceChangeSource = 'editor' | 'product' | 'csv' | 'skroutz';

/** Audit trail of price edits. Prices move every few days: the owner needs to see what changed, when, and what it was before. */
export const priceChanges = sqliteTable(
  'price_changes',
  {
    id: id(),
    variantId: integer('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    oldCents: integer('old_cents').notNull(),
    newCents: integer('new_cents').notNull(),
    source: text('source').$type<PriceChangeSource>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('price_changes_variant_idx').on(t.variantId), index('price_changes_created_idx').on(t.createdAt)],
);

// ─── Customers ───────────────────────────────────────────────────────────────
export const customers = sqliteTable(
  'customers',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull().default(''),
    phone: text('phone'),
    street: text('street'),
    city: text('city'),
    postalCode: text('postal_code'),
    region: text('region'),
    marketingOptIn: integer('marketing_opt_in', { mode: 'boolean' }).notNull().default(false),
    resetTokenHash: text('reset_token_hash'),
    resetTokenExpires: integer('reset_token_expires', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('customers_email_uq').on(t.email)],
);

export const adminUsers = sqliteTable(
  'admin_users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull().default(''),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_users_email_uq').on(t.email)],
);

// ─── Orders ──────────────────────────────────────────────────────────────────
export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'ready_for_pickup' | 'completed' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export type PaymentMethod = 'cod' | 'bank_transfer' | 'card' | 'pay_in_store';
export type ShippingMethod = 'courier' | 'pickup';
export type DocType = 'receipt' | 'invoice';

export const orders = sqliteTable(
  'orders',
  {
    id: id(),
    /** human friendly, e.g. OC-10042 */
    number: text('number').notNull(),
    /** unguessable token that lets the buyer open their order page without logging in */
    accessToken: text('access_token').notNull(),
    status: text('status').$type<OrderStatus>().notNull().default('pending'),
    paymentStatus: text('payment_status').$type<PaymentStatus>().notNull().default('pending'),
    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    shippingMethod: text('shipping_method').$type<ShippingMethod>().notNull(),

    customerId: integer('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),

    street: text('street'),
    city: text('city'),
    postalCode: text('postal_code'),
    region: text('region'),
    country: text('country').notNull().default('GR'),
    notes: text('notes'),

    docType: text('doc_type').$type<DocType>().notNull().default('receipt'),
    companyName: text('company_name'),
    vatNumber: text('vat_number'),
    taxOffice: text('tax_office'),
    companyActivity: text('company_activity'),
    companyAddress: text('company_address'),

    subtotalCents: integer('subtotal_cents').notNull(),
    shippingCents: integer('shipping_cents').notNull().default(0),
    codFeeCents: integer('cod_fee_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    vatRate: integer('vat_rate').notNull().default(24),
    couponCode: text('coupon_code'),
    totalWeightGrams: integer('total_weight_grams').notNull().default(0),

    trackingCarrier: text('tracking_carrier'),
    trackingNumber: text('tracking_number'),

    paymentProvider: text('payment_provider'),
    paymentRef: text('payment_ref'),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }),

    /** placed while the shop was in demo mode; excluded from revenue stats */
    isTest: integer('is_test', { mode: 'boolean' }).notNull().default(false),
    adminNotes: text('admin_notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_number_uq').on(t.number),
    index('orders_created_idx').on(t.createdAt),
    index('orders_email_idx').on(t.email),
    index('orders_status_idx').on(t.status),
    index('orders_customer_idx').on(t.customerId),
  ],
);

/** Line items are snapshots: they keep name/price even if the product later changes or is deleted. */
export const orderItems = sqliteTable(
  'order_items',
  {
    id: id(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: integer('product_id'),
    variantId: integer('variant_id'),
    name: text('name').notNull(),
    variantLabel: text('variant_label').notNull(),
    sku: text('sku').notNull(),
    imageUrl: text('image_url'),
    slug: text('slug'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalCents: integer('line_total_cents').notNull(),
    weightGrams: integer('weight_grams').notNull().default(0),
    /** what the buyer was told when ordering; null on orders from before availability labels existed */
    availability: text('availability').$type<Availability>(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export const orderEvents = sqliteTable(
  'order_events',
  {
    id: id(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    actor: text('actor').notNull().default('system'),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId)],
);

// ─── Marketing ───────────────────────────────────────────────────────────────
export type CouponType = 'percent' | 'fixed' | 'free_shipping';

export const coupons = sqliteTable(
  'coupons',
  {
    id: id(),
    code: text('code').notNull(),
    type: text('type').$type<CouponType>().notNull(),
    /** percent (1–100) for 'percent', cents for 'fixed', ignored for 'free_shipping' */
    value: integer('value').notNull().default(0),
    minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('coupons_code_uq').on(t.code)],
);

/** which form a message came from: the contact page, «Ποιο λάδι χρειάζεται το όχημά μου;», or the quote form for professionals */
export type EnquiryKind = 'contact' | 'oil-finder' | 'quote';

export const contactMessages = sqliteTable('contact_messages', {
  id: id(),
  kind: text('kind').$type<EnquiryKind>().notNull().default('contact'),
  name: text('name').notNull(),
  /** '' when the visitor left only a phone number (the vehicle form asks for the phone, the e-mail is optional) */
  email: text('email').notNull(),
  phone: text('phone'),
  subject: text('subject'),
  message: text('message').notNull(),
  /** the form's structured answers in display order: [["Μάρκα", "Toyota"], ["Μοντέλο", "Yaris"], …] */
  details: text('details', { mode: 'json' }).$type<Array<[string, string]>>(),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

/** People who asked to be told when online ordering opens (shown while it is closed). */
export const launchSignups = sqliteTable(
  'launch_signups',
  {
    id: id(),
    email: text('email').notNull(),
    createdAt: createdAt(),
    notifiedAt: integer('notified_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('launch_signups_email_uq').on(t.email)],
);

// ─── Statistics ──────────────────────────────────────────────────────────────
/**
 * Cookieless, aggregate site statistics: one counter per (day, kind, key) — "on 2026-10-03 the product page
 * motul-7100 was viewed 14 times". Nothing here describes an individual visitor.
 */
export const statCounters = sqliteTable(
  'stat_counters',
  {
    /** YYYY-MM-DD in Europe/Athens */
    day: text('day').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull().default(''),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind, t.key] }), index('stat_counters_kind_idx').on(t.kind, t.day)],
);

/**
 * Salted hashes of today's visitors (IP + browser), kept only so that one person counts once per day.
 * The salt changes daily and yesterday's rows are deleted, so a hash can never be tied back to anyone.
 */
export const statVisitors = sqliteTable(
  'stat_visitors',
  {
    day: text('day').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.hash] })],
);

// ─── Relations ───────────────────────────────────────────────────────────────
export const brandsRelations = relations(brands, ({ many }) => ({ products: many(products) }));

export const categoriesRelations = relations(categories, ({ many, one }) => ({
  products: many(products),
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: 'tree' }),
  children: many(categories, { relationName: 'tree' }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  images: many(productImages),
  variants: many(variants),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  events: many(orderEvents),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({ orders: many(orders) }));

// ─── Row types ───────────────────────────────────────────────────────────────
export type Brand = typeof brands.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type PriceChange = typeof priceChanges.$inferSelect;
export type Order =typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type AdminUser = typeof adminUsers.$inferSelect;
export type ContactMessage = typeof contactMessages.$inferSelect;
