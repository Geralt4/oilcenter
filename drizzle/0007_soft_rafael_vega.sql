ALTER TABLE `admin_users` ADD `token_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `token_version` integer DEFAULT 0 NOT NULL;