CREATE TABLE `system_settings` (
	`settingKey` varchar(128) NOT NULL,
	`settingValue` text NOT NULL,
	`description` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `system_settings_settingKey` PRIMARY KEY(`settingKey`)
);
--> statement-breakpoint
ALTER TABLE `campaign_assets` MODIFY COLUMN `assetType` enum('image','video_script','carousel','ad_copy','caption','caption_adaptation','caption_pack','hashtag_set','cta_variant','email_copy','whatsapp_copy','video_concept','reel_script','carousel_ad','whatsapp_promo','lead_gen_ad','launch_pack') NOT NULL;