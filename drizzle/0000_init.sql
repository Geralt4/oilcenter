CREATE TABLE `admin_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_uq` ON `admin_users` (`email`);--> statement-breakpoint
CREATE TABLE `brands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`logo_url` text,
	`country` text,
	`is_featured` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brands_slug_uq` ON `brands` (`slug`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`description` text,
	`icon` text,
	`image_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_uq` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `contact_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`subject` text,
	`message` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`min_subtotal_cents` integer DEFAULT 0 NOT NULL,
	`max_uses` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_code_uq` ON `coupons` (`code`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`phone` text,
	`street` text,
	`city` text,
	`postal_code` text,
	`region` text,
	`marketing_opt_in` integer DEFAULT false NOT NULL,
	`reset_token_hash` text,
	`reset_token_expires` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_uq` ON `customers` (`email`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer,
	`variant_id` integer,
	`name` text NOT NULL,
	`variant_label` text NOT NULL,
	`sku` text NOT NULL,
	`image_url` text,
	`slug` text,
	`unit_price_cents` integer NOT NULL,
	`quantity` integer NOT NULL,
	`line_total_cents` integer NOT NULL,
	`weight_grams` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`access_token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payment_status` text DEFAULT 'pending' NOT NULL,
	`payment_method` text NOT NULL,
	`shipping_method` text NOT NULL,
	`customer_id` integer,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`street` text,
	`city` text,
	`postal_code` text,
	`region` text,
	`country` text DEFAULT 'GR' NOT NULL,
	`notes` text,
	`doc_type` text DEFAULT 'receipt' NOT NULL,
	`company_name` text,
	`vat_number` text,
	`tax_office` text,
	`company_activity` text,
	`company_address` text,
	`subtotal_cents` integer NOT NULL,
	`shipping_cents` integer DEFAULT 0 NOT NULL,
	`cod_fee_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`vat_rate` integer DEFAULT 24 NOT NULL,
	`coupon_code` text,
	`total_weight_grams` integer DEFAULT 0 NOT NULL,
	`tracking_carrier` text,
	`tracking_number` text,
	`payment_provider` text,
	`payment_ref` text,
	`paid_at` integer,
	`is_test` integer DEFAULT false NOT NULL,
	`admin_notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number_uq` ON `orders` (`number`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `orders_email_idx` ON `orders` (`email`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`url` text NOT NULL,
	`alt` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_images_product_idx` ON `product_images` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`brand_id` integer,
	`category_id` integer,
	`short_description` text,
	`description` text,
	`viscosity` text,
	`base_type` text,
	`specs` text DEFAULT '[]' NOT NULL,
	`attributes` text DEFAULT '{}' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_featured` integer DEFAULT false NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`internal_notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_uq` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_brand_idx` ON `products` (`brand_id`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_viscosity_idx` ON `products` (`viscosity`);--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`sku` text NOT NULL,
	`label` text NOT NULL,
	`volume_ml` integer,
	`price_cents` integer NOT NULL,
	`compare_at_cents` integer,
	`stock` integer DEFAULT 0 NOT NULL,
	`track_stock` integer DEFAULT true NOT NULL,
	`weight_grams` integer DEFAULT 0 NOT NULL,
	`barcode` text,
	`image_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`price_verified` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_uq` ON `variants` (`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`);