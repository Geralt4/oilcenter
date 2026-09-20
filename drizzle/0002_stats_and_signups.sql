CREATE TABLE `launch_signups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`notified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launch_signups_email_uq` ON `launch_signups` (`email`);--> statement-breakpoint
CREATE TABLE `stat_counters` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `stat_counters_kind_idx` ON `stat_counters` (`kind`,`day`);--> statement-breakpoint
CREATE TABLE `stat_visitors` (
	`day` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`day`, `hash`)
);
