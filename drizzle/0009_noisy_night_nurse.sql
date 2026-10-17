ALTER TABLE `admin_users` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `admin_users` ADD `totp_confirmed_at` integer;