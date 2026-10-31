CREATE TABLE `mail_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`order_id` integer,
	`unmatched_id` integer,
	`problem` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`sent_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`given_up_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unmatched_id`) REFERENCES `unmatched_payments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_outbox_pending_idx` ON `mail_outbox` (`sent_at`,`given_up_at`);--> statement-breakpoint
CREATE INDEX `mail_outbox_order_idx` ON `mail_outbox` (`order_id`);