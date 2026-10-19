CREATE TABLE `unmatched_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`order_code` text NOT NULL,
	`transaction_id` text NOT NULL,
	`merchant_trns` text,
	`amount_cents` integer NOT NULL,
	`currency` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unmatched_payments_tx_uq` ON `unmatched_payments` (`provider`,`transaction_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_flag` text;