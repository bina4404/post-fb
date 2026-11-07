CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_platform_external_id_unique` ON `accounts` (`platform`,`external_id`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_account_id_external_id_unique` ON `boards` (`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`platform` text NOT NULL,
	`account_id` integer NOT NULL,
	`board_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`locked_at` integer,
	`external_post_id` text,
	`last_error` text,
	`needs_attention` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_targets_idempotency_key_unique` ON `post_targets` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `post_targets_due_idx` ON `post_targets` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`caption` text NOT NULL,
	`link` text,
	`image_key` text,
	`image_url` text,
	`scheduled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`weekday` integer NOT NULL,
	`minute_of_day` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_slots_weekday_minute_of_day_unique` ON `schedule_slots` (`weekday`,`minute_of_day`);