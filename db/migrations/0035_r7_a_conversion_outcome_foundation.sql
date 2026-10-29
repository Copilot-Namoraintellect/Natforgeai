CREATE TABLE `business_outcome_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`outcomeLifecycleEventId` varchar(70) NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`amountMinor` bigint,
	`currency` varchar(3),
	`externalLifecycleId` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_outcome_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bole_event_id_uidx` UNIQUE(`outcomeLifecycleEventId`),
	CONSTRAINT `bole_external_uidx` UNIQUE(`outcomeId`,`externalLifecycleId`)
);
--> statement-breakpoint
CREATE TABLE `business_outcomes` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`conversionId` varchar(69) NOT NULL,
	`outcomeType` varchar(32) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`valueType` varchar(16) NOT NULL,
	`amountMinor` bigint,
	`currency` varchar(3),
	`quantity` int,
	`metricUnit` varchar(32),
	`evidenceSource` varchar(32) NOT NULL,
	`evidenceAuthority` varchar(24) NOT NULL,
	`evidenceIdentity` varchar(191) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`reversesOutcomeId` varchar(69),
	`renewsOutcomeId` varchar(69),
	`supersedesOutcomeId` varchar(69),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_outcomes_id` PRIMARY KEY(`id`),
	CONSTRAINT `bo_outcome_id_uidx` UNIQUE(`outcomeId`),
	CONSTRAINT `bo_natural_key_uidx` UNIQUE(`userId`,`conversionId`,`evidenceSource`,`evidenceIdentity`)
);
--> statement-breakpoint
CREATE INDEX `bole_user_outcome_idx` ON `business_outcome_lifecycle_events` (`userId`,`outcomeId`);--> statement-breakpoint
CREATE INDEX `bo_user_business_idx` ON `business_outcomes` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bo_user_conversion_idx` ON `business_outcomes` (`userId`,`conversionId`);--> statement-breakpoint
CREATE INDEX `bo_user_lead_idx` ON `business_outcomes` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `bo_user_status_idx` ON `business_outcomes` (`userId`,`outcomeStatus`);