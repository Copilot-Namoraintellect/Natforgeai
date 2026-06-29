CREATE TABLE `analytics` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`businessId` bigint unsigned,
	`metricType` enum('impressions','clicks','conversions','leads','revenue','engagement','followers','reach') NOT NULL,
	`platform` varchar(50),
	`value` int DEFAULT 0,
	`date` date NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analytics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`description` text,
	`trigger` enum('new_lead','new_message','new_purchase','form_submit','schedule','manual') NOT NULL,
	`actions` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT false,
	`runCount` int DEFAULT 0,
	`lastRun` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `automations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `banking_details` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`adminUserId` bigint unsigned NOT NULL,
	`accountName` varchar(255),
	`bankName` varchar(255),
	`accountNumber` varchar(100),
	`accountType` enum('checking','savings','business') DEFAULT 'business',
	`branchCode` varchar(50),
	`swiftCode` varchar(50),
	`iban` varchar(100),
	`routingNumber` varchar(100),
	`stripeAccountId` varchar(255),
	`paypalEmail` varchar(320),
	`cryptoWalletAddress` varchar(255),
	`cryptoNetwork` varchar(50),
	`isDefault` boolean DEFAULT false,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `banking_details_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`industry` varchar(100),
	`location` varchar(255),
	`targetAudience` text,
	`tone` varchar(50) DEFAULT 'professional',
	`logo` text,
	`website` varchar(255),
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`goal` varchar(255) NOT NULL,
	`status` enum('draft','active','paused','completed') NOT NULL DEFAULT 'draft',
	`targetAudience` text,
	`coreMessage` text,
	`platforms` text,
	`budget` int,
	`startDate` date,
	`endDate` date,
	`strategy` text,
	`personas` json,
	`contentCalendar` json,
	`adConcepts` json,
	`funnelStages` json,
	`offers` json,
	`ctaStrategy` text,
	`aiGenerated` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `content_posts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`businessId` bigint unsigned,
	`title` varchar(255) NOT NULL,
	`type` enum('social_post','ad_copy','email','script','blog','story') NOT NULL,
	`platform` varchar(50),
	`hook` text,
	`caption` text,
	`cta` text,
	`headline` text,
	`body` text,
	`hashtags` text,
	`visualPrompt` text,
	`status` enum('draft','scheduled','published','archived') NOT NULL DEFAULT 'draft',
	`scheduledFor` timestamp,
	`publishedAt` timestamp,
	`engagementScore` int,
	`aiGenerated` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `content_posts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `generated_images` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned,
	`businessId` bigint unsigned,
	`prompt` text NOT NULL,
	`url` text NOT NULL,
	`aspectRatio` varchar(10) DEFAULT '1:1',
	`style` varchar(100),
	`status` enum('pending','completed','failed') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `generated_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lead_activities` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadId` bigint unsigned NOT NULL,
	`type` enum('note','call','email','meeting','task','status_change') NOT NULL,
	`description` text NOT NULL,
	`createdBy` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_activities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`campaignId` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`email` varchar(320),
	`phone` varchar(50),
	`company` varchar(255),
	`jobTitle` varchar(100),
	`source` varchar(100),
	`status` enum('new','contacted','qualified','proposal','negotiation','won','lost') NOT NULL DEFAULT 'new',
	`score` int DEFAULT 0,
	`notes` text,
	`lastContact` timestamp,
	`nextFollowUp` timestamp,
	`customFields` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`subscriptionId` bigint unsigned,
	`amount` int NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`status` enum('pending','completed','failed','refunded','disputed') NOT NULL DEFAULT 'pending',
	`paymentMethod` enum('stripe','paypal','bank_transfer','manual','crypto'),
	`paymentReference` varchar(255),
	`description` text,
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`contentPostId` bigint unsigned,
	`campaignId` bigint unsigned,
	`businessId` bigint unsigned,
	`title` varchar(255) NOT NULL,
	`platform` varchar(50) NOT NULL,
	`scheduledDate` date NOT NULL,
	`scheduledTime` varchar(10),
	`timezone` varchar(50) DEFAULT 'UTC',
	`contentType` enum('educational','promotional','engagement','awareness','conversion') DEFAULT 'educational',
	`status` enum('draft','scheduled','posted','failed') NOT NULL DEFAULT 'draft',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscription_tiers` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`slug` varchar(50) NOT NULL,
	`description` text,
	`priceUsd` int NOT NULL,
	`billingCycle` enum('monthly','yearly') NOT NULL DEFAULT 'monthly',
	`maxCampaigns` int DEFAULT 10,
	`maxLeads` int DEFAULT 100,
	`maxContent` int DEFAULT 50,
	`maxAutomations` int DEFAULT 3,
	`aiGeneration` boolean DEFAULT false,
	`analytics` boolean DEFAULT false,
	`teamMembers` int DEFAULT 1,
	`features` json,
	`isActive` boolean NOT NULL DEFAULT true,
	`isDefault` boolean DEFAULT false,
	`displayOrder` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `subscription_tiers_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscription_tiers_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`tierId` bigint unsigned NOT NULL,
	`status` enum('active','trialing','past_due','cancelled','expired') NOT NULL DEFAULT 'trialing',
	`trialEndsAt` timestamp,
	`currentPeriodStart` timestamp NOT NULL DEFAULT (now()),
	`currentPeriodEnd` timestamp,
	`paymentMethod` enum('stripe','paypal','bank_transfer','manual'),
	`paymentReference` varchar(255),
	`cancelledAt` timestamp,
	`cancelAtPeriodEnd` boolean DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`category` enum('strategy','content','ads','design','video','targeting','scheduling','chatbot','crm','automation') NOT NULL,
	`description` text,
	`prompt` text NOT NULL,
	`variables` json,
	`isDefault` boolean NOT NULL DEFAULT false,
	`isFavorite` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`unionId` varchar(255),
	`googleId` varchar(255),
	`firebaseUid` varchar(255),
	`username` varchar(255),
	`email` varchar(320),
	`passwordHash` varchar(255),
	`authType` enum('local','google','kimi','firebase') DEFAULT 'local',
	`name` varchar(255),
	`avatar` text,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	`lastSignInAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`)
);
