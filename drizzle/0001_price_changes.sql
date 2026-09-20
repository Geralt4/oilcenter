CREATE TABLE `price_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`old_cents` integer NOT NULL,
	`new_cents` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_changes_variant_idx` ON `price_changes` (`variant_id`);--> statement-breakpoint
CREATE INDEX `price_changes_created_idx` ON `price_changes` (`created_at`);