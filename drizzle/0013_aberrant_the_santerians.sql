CREATE INDEX `pending_uploads_expiry_idx` ON `pending_uploads` (`expires_at`);--> statement-breakpoint
CREATE INDEX `rate_limits_window_idx` ON `rate_limits` (`window_start`);