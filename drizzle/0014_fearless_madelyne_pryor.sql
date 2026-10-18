CREATE TABLE `sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`value` integer NOT NULL,
	`product_ids` text DEFAULT '[]' NOT NULL,
	`brand_ids` text DEFAULT '[]' NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `coupons` ADD `exclude_sale_items` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `coupons` ADD `product_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coupons` ADD `brand_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coupons` ADD `category_ids` text DEFAULT '[]' NOT NULL;