ALTER TABLE `contact_messages` ADD `kind` text DEFAULT 'contact' NOT NULL;--> statement-breakpoint
ALTER TABLE `contact_messages` ADD `details` text;