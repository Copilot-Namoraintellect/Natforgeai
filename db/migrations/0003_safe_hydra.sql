CREATE TABLE `ai_usage` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`agentType` enum('strategy','creative','audience','distribution','engagement','sales','optimisation','safety_check','image_generation','video_generation') NOT NULL,
	`model` varchar(50) NOT NULL,
	`promptTokens` int NOT NULL DEFAULT 0,
	`completionTokens` int NOT NULL DEFAULT 0,
	`totalTokens` int NOT NULL DEFAULT 0,
	`actualCostUsd` int NOT NULL DEFAULT 0,
	`estimatedCostUsd` int NOT NULL DEFAULT 0,
	`creditsDeducted` int NOT NULL DEFAULT 0,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credit_transactions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`walletId` bigint unsigned NOT NULL,
	`type` enum('subscription_allocation','purchase','agent_deduction','publishing_deduction','image_generation','video_generation','refund','admin_adjustment','rollover') NOT NULL,
	`amount` int NOT NULL,
	`balanceAfter` int NOT NULL,
	`description` text,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credit_wallets` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`balance` int NOT NULL DEFAULT 0,
	`lifetimeEarned` int NOT NULL DEFAULT 0,
	`lifetimeSpent` int NOT NULL DEFAULT 0,
	`monthlyAllocation` int NOT NULL DEFAULT 0,
	`monthlyResetAt` timestamp,
	`spendLimit` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_wallets_id` PRIMARY KEY(`id`),
	CONSTRAINT `credit_wallets_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `system_alerts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`severity` enum('critical','warning','info') NOT NULL,
	`category` enum('publishing','queue','worker','redis','openai','billing','system') NOT NULL,
	`message` text NOT NULL,
	`details` json,
	`resolvedAt` timestamp,
	`acknowledgedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `system_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review') NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_assets` MODIFY COLUMN `assetType` enum('image','video_script','carousel','ad_copy','caption','hashtag_set','cta_variant','email_copy','whatsapp_copy','video_concept','reel_script','carousel_ad','whatsapp_promo','lead_gen_ad','launch_pack') NOT NULL;--> statement-breakpoint
ALTER TABLE `content_posts` MODIFY COLUMN `type` enum('social_post','ad_copy','email','script','blog','story','video_concept','reel_script','carousel_ad','whatsapp_promo','lead_gen_ad','launch_pack') NOT NULL;--> statement-breakpoint
ALTER TABLE `publishing_queue` MODIFY COLUMN `status` enum('draft','pending_approval','approved','published','failed','safety_blocked','retrying') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `businesses` ADD `premiumContentPreferences` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `hasProductVideos` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `content_posts` ADD `metadata` json;--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `retryCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `maxRetries` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `nextRetryAt` timestamp;--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `lastError` text;--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `safetyStatus` enum('pending','low','medium','high');--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD `safetyReasons` json;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `monthlyCredits` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `lastCreditAllocationAt` timestamp;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `nextCreditAllocationAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `twoFactorEnabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `twoFactorMethod` varchar(20);--> statement-breakpoint
ALTER TABLE `users` ADD `twoFactorVerifiedAt` timestamp;