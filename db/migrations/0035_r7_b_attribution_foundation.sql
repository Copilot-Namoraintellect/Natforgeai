CREATE TABLE `attribution_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attributionLifecycleEventId` varchar(70) NOT NULL,
	`attributionId` varchar(69) NOT NULL,
	`priorAttributionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attribution_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `atf_event_id_uidx` UNIQUE(`attributionLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `attribution_results` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attributionId` varchar(69) NOT NULL,
	`attributionKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`conversionId` varchar(69) NOT NULL,
	`outcomeType` varchar(32) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`outcomeAmountMinor` bigint,
	`outcomeCurrency` varchar(3),
	`modelType` varchar(24) NOT NULL,
	`modelVersion` varchar(40) NOT NULL,
	`windowStart` varchar(32) NOT NULL,
	`windowEnd` varchar(32) NOT NULL,
	`journeyHash` varchar(64) NOT NULL,
	`touchpoints` json NOT NULL,
	`excludedTouchpoints` json NOT NULL,
	`totalCreditBps` int NOT NULL,
	`confidenceClass` enum('HIGH','MEDIUM','LOW','NONE') NOT NULL,
	`evidenceClass` enum('DIRECT_LINKAGE','STRONG_ASSOCIATION','WEAK_ASSOCIATION','INSUFFICIENT_EVIDENCE') NOT NULL,
	`policyVersion` varchar(96) NOT NULL,
	`sourceVersions` json NOT NULL,
	`supersedesAttributionId` varchar(69),
	`recordHash` varchar(64) NOT NULL,
	`calculatedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attribution_results_id` PRIMARY KEY(`id`),
	CONSTRAINT `atr_attribution_id_uidx` UNIQUE(`attributionId`),
	CONSTRAINT `atr_natural_key_uidx` UNIQUE(`userId`,`outcomeId`,`modelType`,`modelVersion`,`windowStart`,`windowEnd`,`journeyHash`)
);
--> statement-breakpoint
CREATE INDEX `atf_user_attribution_idx` ON `attribution_lifecycle_events` (`userId`,`attributionId`);--> statement-breakpoint
CREATE INDEX `atr_user_outcome_idx` ON `attribution_results` (`userId`,`outcomeId`);--> statement-breakpoint
CREATE INDEX `atr_user_business_idx` ON `attribution_results` (`userId`,`businessId`);