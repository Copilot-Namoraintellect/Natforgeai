CREATE TABLE `agent_runs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`agentType` enum('strategy','creative','audience','distribution','engagement','sales','optimisation') NOT NULL,
	`status` enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
	`input` json,
	`output` json,
	`error` text,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk') NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`aiRecommendation` text,
	`riskLevel` enum('low','medium','high') NOT NULL,
	`status` enum('pending','approved','rejected','edited') NOT NULL DEFAULT 'pending',
	`approvedAt` timestamp,
	`rejectedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `approval_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaign_assets` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`assetType` enum('image','video_script','carousel','ad_copy','caption','hashtag_set','cta_variant','email_copy','whatsapp_copy') NOT NULL,
	`title` varchar(255) NOT NULL,
	`url` text,
	`prompt` text,
	`status` enum('generating','ready','approved','rejected') NOT NULL DEFAULT 'generating',
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `campaign_assets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`threadId` bigint unsigned NOT NULL,
	`senderType` enum('lead','ai','user') NOT NULL,
	`messageText` text NOT NULL,
	`aiGenerated` boolean NOT NULL DEFAULT false,
	`sentiment` enum('positive','neutral','negative','urgent'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversation_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_threads` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`leadId` bigint unsigned,
	`platform` varchar(50) NOT NULL,
	`externalThreadId` varchar(255) NOT NULL,
	`status` enum('open','ai_handled','escalated','closed') NOT NULL DEFAULT 'open',
	`aiHandled` boolean NOT NULL DEFAULT false,
	`escalationRequired` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversation_threads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `optimisation_logs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`summary` text NOT NULL,
	`recommendedActions` json,
	`appliedActions` json,
	`performanceSnapshot` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `optimisation_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publishing_queue` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`contentPostId` bigint unsigned,
	`platform` varchar(50) NOT NULL,
	`scheduledAt` timestamp,
	`status` enum('draft','pending_approval','approved','published','failed') NOT NULL DEFAULT 'draft',
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`publishedAt` timestamp,
	`externalPostId` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publishing_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `social_integrations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`platform` enum('facebook','instagram','linkedin','tiktok','twitter','whatsapp','email') NOT NULL,
	`accountName` varchar(255),
	`accessTokenEncrypted` text,
	`refreshTokenEncrypted` text,
	`permissions` json,
	`status` enum('connected','expired','disconnected') NOT NULL DEFAULT 'disconnected',
	`lastSyncAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_integrations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `businesses` MODIFY COLUMN `website` varchar(500);--> statement-breakpoint
ALTER TABLE `businesses` ADD `productOrService` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `targetCustomer` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `monthlyBudget` int;--> statement-breakpoint
ALTER TABLE `businesses` ADD `brandTone` varchar(50);--> statement-breakpoint
ALTER TABLE `businesses` ADD `mainGoal` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `socialLinks` json;--> statement-breakpoint
ALTER TABLE `businesses` ADD `whatsappNumber` varchar(50);--> statement-breakpoint
ALTER TABLE `businesses` ADD `preferredPlatforms` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `onboardingComplete` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `workflowState` enum('business_onboarding','strategy_pending','strategy_generated','strategy_approved','creatives_generating','creatives_ready','audience_generating','audience_ready','schedule_generated','launch_approval_required','campaign_live','engagement_active','leads_converting','optimisation_active','completed') DEFAULT 'business_onboarding' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `workflowContext` json;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `strategyDocument` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `autoPublish` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `approvalMode` enum('assisted','autonomous') DEFAULT 'assisted' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `strategyAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `creativeAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `audienceAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `distributionAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `engagementAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `salesAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `optimisationAgent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `approvalCentre` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_tiers` ADD `autonomousMode` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `onboardingComplete` boolean DEFAULT false NOT NULL;