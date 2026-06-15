ALTER TABLE `businesses` ADD `brandColors` json;--> statement-breakpoint
ALTER TABLE `businesses` ADD `visualStyle` varchar(50);--> statement-breakpoint
ALTER TABLE `businesses` ADD `brandVoiceNotes` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `avoidWords` text;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `contentPostId` bigint unsigned;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `provider` varchar(50) DEFAULT 'openai';--> statement-breakpoint
ALTER TABLE `generated_images` ADD `providerJobId` varchar(255);--> statement-breakpoint
ALTER TABLE `generated_images` ADD `creditsCharged` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `providerCostUsd` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `generated_images` ADD `metadata` json;--> statement-breakpoint
ALTER TABLE `video_render_jobs` ADD `providerLinkId` varchar(255);--> statement-breakpoint
ALTER TABLE `video_render_jobs` ADD `creditsCharged` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `video_render_jobs` ADD `providerCostUsd` int DEFAULT 0;