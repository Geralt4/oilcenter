CREATE TABLE `pending_uploads` (
	`token` text PRIMARY KEY NOT NULL,
	`admin_id` integer NOT NULL,
	`kind` text NOT NULL,
	`original_name` text,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer
);
