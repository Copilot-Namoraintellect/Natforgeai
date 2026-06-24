CREATE TABLE `campaign_interest_signals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned NOT NULL,
	`socialProfileId` bigint unsigned,
	`externalIdentifier` varchar(255) NOT NULL,
	`signalType` enum('engagement','follow','message','click') NOT NULL DEFAULT 'engagement',
	`strength` int NOT NULL DEFAULT 0,
	`sourceEventIds` json,
	`contextSnippet` text,
	`detectedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `campaign_interest_signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lead_scores` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`socialProfileId` bigint unsigned,
	`externalIdentifier` varchar(255) NOT NULL,
	`platform` varchar(50) NOT NULL,
	`handle` varchar(255),
	`displayName` varchar(255),
	`score` int NOT NULL DEFAULT 0,
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`signalsSummary` json,
	`explanation` text,
	`recommendedAction` enum('reach_out','nurture','ignore') NOT NULL DEFAULT 'nurture',
	`scoredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_scores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outreach_recommendations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned NOT NULL,
	`leadScoreId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`channel` enum('email','instagram_dm','facebook_dm','linkedin_dm','whatsapp','sms') NOT NULL,
	`angle` text,
	`personalisedHook` text,
	`cta` text,
	`expectedOutcome` text,
	`priority` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`acceptedAt` timestamp,
	`dismissedAt` timestamp,
	CONSTRAINT `outreach_recommendations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `social_engagement_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned,
	`platform` enum('facebook','instagram','linkedin','tiktok','twitter') NOT NULL,
	`socialProfileId` bigint unsigned,
	`externalProfileId` varchar(255) NOT NULL,
	`externalContentId` varchar(255),
	`dedupHash` varchar(64) NOT NULL,
	`eventType` enum('follow','like','comment','share','message','click','save','post_interaction') NOT NULL,
	`actorHandle` varchar(255),
	`actorDisplayName` varchar(255),
	`actorExternalId` varchar(255),
	`messageText` text,
	`eventTimestamp` timestamp NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_engagement_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `see_dedup_hash_idx` UNIQUE(`dedupHash`)
);
--> statement-breakpoint
CREATE TABLE `social_profiles` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned,
	`platform` enum('facebook_page','instagram_account','linkedin_page','tiktok_account','twitter_account') NOT NULL,
	`externalId` varchar(255) NOT NULL,
	`handle` varchar(255),
	`displayName` varchar(255),
	`url` text,
	`followerCount` int DEFAULT 0,
	`category` varchar(255),
	`location` varchar(255),
	`profilePictureUrl` text,
	`lastSyncedAt` timestamp,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `cis_campaign_identifier_idx` ON `campaign_interest_signals` (`campaignId`,`externalIdentifier`);--> statement-breakpoint
CREATE INDEX `cis_user_campaign_idx` ON `campaign_interest_signals` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `ls_campaign_score_idx` ON `lead_scores` (`campaignId`,`score`);--> statement-breakpoint
CREATE INDEX `ls_user_campaign_idx` ON `lead_scores` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `ls_external_idx` ON `lead_scores` (`userId`,`campaignId`,`externalIdentifier`);--> statement-breakpoint
CREATE INDEX `or_lead_score_idx` ON `outreach_recommendations` (`leadScoreId`);--> statement-breakpoint
CREATE INDEX `or_user_campaign_idx` ON `outreach_recommendations` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `see_profile_event_idx` ON `social_engagement_events` (`socialProfileId`,`eventTimestamp`);--> statement-breakpoint
CREATE INDEX `see_user_campaign_idx` ON `social_engagement_events` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `user_platform_external_idx` ON `social_profiles` (`userId`,`platform`,`externalId`);--> statement-breakpoint
CREATE INDEX `sp_user_campaign_idx` ON `social_profiles` (`userId`,`campaignId`);