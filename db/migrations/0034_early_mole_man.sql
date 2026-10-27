CREATE TABLE `conversion_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`conversionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`externalConversionId` varchar(191) NOT NULL,
	`sourceSystem` varchar(32) NOT NULL,
	`sourceTrustClass` varchar(24) NOT NULL,
	`conversionType` varchar(32) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`amount` bigint,
	`currency` varchar(3),
	`outcomeStatus` varchar(16) NOT NULL,
	`reversesConversionId` varchar(69),
	`sourceOpportunityId` varchar(69),
	`sourceEngagementReceiptId` varchar(64),
	`sourceSignalId` varchar(64),
	`sourceCampaignId` bigint unsigned,
	`sourcePublicationId` bigint unsigned,
	`evidenceReference` varchar(255),
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversion_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ce_conversion_id_uidx` UNIQUE(`conversionId`),
	CONSTRAINT `ce_natural_key_uidx` UNIQUE(`userId`,`sourceSystem`,`externalConversionId`)
);
--> statement-breakpoint
CREATE TABLE `conversion_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`conversionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`amount` bigint,
	`currency` varchar(3),
	`externalLifecycleId` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversion_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `cle_event_id_uidx` UNIQUE(`lifecycleEventId`),
	CONSTRAINT `cle_external_uidx` UNIQUE(`conversionId`,`externalLifecycleId`)
);
--> statement-breakpoint
CREATE INDEX `ce_user_business_idx` ON `conversion_events` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `ce_user_lead_idx` ON `conversion_events` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `ce_user_occurred_idx` ON `conversion_events` (`userId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `ce_user_reverses_idx` ON `conversion_events` (`userId`,`reversesConversionId`);--> statement-breakpoint
CREATE INDEX `cle_user_conversion_idx` ON `conversion_lifecycle_events` (`userId`,`conversionId`);