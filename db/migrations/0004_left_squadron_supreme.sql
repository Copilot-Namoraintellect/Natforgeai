CREATE TABLE `two_factor_challenges` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`challengeToken` varchar(255) NOT NULL,
	`otpHash` varchar(255) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 5,
	`consumedAt` timestamp,
	`sentToEmail` varchar(320) NOT NULL,
	`ipAddress` varchar(45),
	`userAgent` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `two_factor_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `two_factor_challenges_challengeToken_unique` UNIQUE(`challengeToken`)
);
--> statement-breakpoint
CREATE TABLE `video_render_jobs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`contentPostId` bigint unsigned,
	`provider` varchar(50) NOT NULL DEFAULT 'placeholder',
	`renderJobId` varchar(255),
	`renderStatus` enum('queued','rendering','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`videoUrl` text,
	`thumbnailUrl` text,
	`errorMessage` text,
	`creditCost` int NOT NULL DEFAULT 0,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`createdBy` bigint unsigned NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `video_render_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `campaign_assets` MODIFY COLUMN `assetType` enum('image','video_script','carousel','ad_copy','caption','caption_adaptation','hashtag_set','cta_variant','email_copy','whatsapp_copy','video_concept','reel_script','carousel_ad','whatsapp_promo','lead_gen_ad','launch_pack') NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `primaryOutcome` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `targetBuyer` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `mainPainPoint` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `productOrService` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `offerDetails` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `preferredCta` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `excludedOffers` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `referenceStyle` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `contentStyle` varchar(50);