ALTER TABLE `customers` ADD `email_verified_at` integer;--> statement-breakpoint
ALTER TABLE `customers` ADD `verify_token_hash` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `verify_token_expires` integer;--> statement-breakpoint
UPDATE `customers` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;