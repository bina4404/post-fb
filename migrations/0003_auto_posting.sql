CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drive_file_id` text NOT NULL,
	`name` text NOT NULL,
	`captions` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_drive_file_id_unique` ON `images` (`drive_file_id`);--> statement-breakpoint
CREATE TABLE `page_times` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`minute_of_day` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_times_account_id_minute_of_day_unique` ON `page_times` (`account_id`,`minute_of_day`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `auto_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `posts_image_idx` ON `posts` (`image_key`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `posts_scheduled_idx` ON `posts` (`scheduled_at`);