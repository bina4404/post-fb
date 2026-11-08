CREATE INDEX `post_targets_post_idx` ON `post_targets` (`post_id`,`status`);--> statement-breakpoint
CREATE INDEX `post_targets_account_idx` ON `post_targets` (`account_id`,`status`,`updated_at`);