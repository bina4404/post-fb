ALTER TABLE `accounts` ADD `reel_folder_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `reel_folder_name` text;--> statement-breakpoint
ALTER TABLE `images` ADD `kind` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `images` ADD `folder_id` text;--> statement-breakpoint
ALTER TABLE `page_times` ADD `kind` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `kind` text DEFAULT 'image' NOT NULL;