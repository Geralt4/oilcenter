ALTER TABLE `order_items` ADD `availability` text;--> statement-breakpoint
ALTER TABLE `variants` ADD `availability` text DEFAULT 'in_stock' NOT NULL;