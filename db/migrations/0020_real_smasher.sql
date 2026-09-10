ALTER TABLE `image_render_claims` ADD `generatedImageId` bigint unsigned;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultImageUrl` text;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultProvider` varchar(50);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultProviderJobId` varchar(255);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultCreditsCharged` int;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultQualityTier` varchar(50);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultQualityLabel` text;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `resultIsDraft` boolean;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `completedAt` timestamp;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD CONSTRAINT `irc_generated_image_idx` UNIQUE(`generatedImageId`);