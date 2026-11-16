CREATE TABLE `topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `images` ADD `topic_id` integer REFERENCES topics(id);--> statement-breakpoint
ALTER TABLE `images` ADD `suggestions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `images` ADD `suggested_at` integer;--> statement-breakpoint
ALTER TABLE `page_times` ADD `days` integer DEFAULT 127 NOT NULL;--> statement-breakpoint
ALTER TABLE `page_times` ADD `topic_id` integer REFERENCES topics(id);--> statement-breakpoint
ALTER TABLE `post_targets` ADD `views` integer;--> statement-breakpoint
ALTER TABLE `post_targets` ADD `follows` integer;--> statement-breakpoint
ALTER TABLE `post_targets` ADD `stats_at` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `topic_id` integer REFERENCES topics(id);--> statement-breakpoint
-- 5 chủ đề từ báo cáo phân tích page (10/11/2026), xếp theo hạng. Sửa hoặc tắt ở tab Tự động.
INSERT INTO `topics` (`name`, `brief`, `created_at`) VALUES
('Bí ẩn người nổi tiếng', 'Celebrity mysteries framed as "What really happened to...?": replacement and faked-death theories (Avril Lavigne, Paul McCartney, Elvis, Tupac, Princess Diana). Nostalgia plus debate.', unixepoch() * 1000),
('Bí ẩn Trái Đất và Kinh Thánh', 'Hidden places, strange sounds and biblical mysteries on Earth (Garden of Eden, Noah''s Ark, Antarctica, the deepest hole on Earth, hollow Earth). The "what they don''t tell us" feeling.', unixepoch() * 1000),
('UFO và hồ sơ chính phủ', 'UFOs/UAPs and released government files (Pentagon UAP releases since May 2026, Bob Lazar, Apollo astronaut reports, alleged CIA recoveries). Current news in the US.', unixepoch() * 1000),
('Cổ vật sai thời đại', 'Out-of-place artifacts and lost civilizations (Antikythera mechanism, Baghdad battery, Saqqara bird, the London hammer, pre-Columbian vessels in Peruvian museums).', unixepoch() * 1000),
('Truyền thuyết, sinh vật lạ', 'Legends, cryptids and unsolved cases (the Man from Taured, Mount Shasta, werewolves). Creepy stories people watch to the end.', unixepoch() * 1000);
