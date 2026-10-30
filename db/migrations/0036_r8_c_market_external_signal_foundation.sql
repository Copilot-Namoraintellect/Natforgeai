-- R8-C Market & External Signal Intelligence — provisional stream-local migration.
-- Artefact only: NOT executed. R8-X owns canonical R8 sequencing/collision with
-- the R8-A (0036_r8_a_strategic_memory_foundation) and R8-F
-- (0036_r8_f_strategic_governance_foundation) provisional migrations.
-- R7's 0035 migration is untouched. See docs/recovery/r8-c-unexecuted-migrations.md.
-- Contract: docs/contracts/market-external-signal-contract.md (market-external-signal/v1).

CREATE TABLE `external_sources` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`sourceId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`originKey` varchar(191) NOT NULL,
	`sourceUriRef` varchar(191) NOT NULL,
	`registryClass` varchar(24) NOT NULL,
	`spoofFlagged` varchar(16),
	`firstSeenAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsr_source_identity_uidx` UNIQUE(`sourceId`),
	CONSTRAINT `xsr_natural_key_uidx` UNIQUE(`userId`,`originKey`)
);
--> statement-breakpoint
CREATE TABLE `external_signals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`signalId` varchar(71) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`signalType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectRef` varchar(191) NOT NULL,
	`claimAspect` varchar(64) NOT NULL,
	`sourceId` varchar(70) NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`sourceUriRef` varchar(191) NOT NULL,
	`eventKey` varchar(191) NOT NULL,
	`registryClass` varchar(24) NOT NULL,
	`sourceTrustClass` varchar(28) NOT NULL,
	`sourceIndependenceKey` varchar(191) NOT NULL,
	`claimText` text NOT NULL,
	`claimKey` varchar(64) NOT NULL,
	`claimFamilyKey` varchar(64) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`publishedAt` varchar(32),
	`ingestedAt` varchar(32) NOT NULL,
	`freshnessClass` varchar(16) NOT NULL,
	`freshnessPolicyVersion` varchar(48) NOT NULL,
	`corroborationStatus` varchar(20) NOT NULL,
	`corroboratingSignalIds` json NOT NULL,
	`contradictingSignalIds` json NOT NULL,
	`relevanceClass` varchar(16) NOT NULL,
	`relevanceEvidence` json NOT NULL,
	`confidenceClass` varchar(12) NOT NULL,
	`signalStatus` varchar(16) NOT NULL,
	`contentIsolation` varchar(24) NOT NULL,
	`injectionSuspected` varchar(8) NOT NULL DEFAULT 'false',
	`limitations` json NOT NULL,
	`modelAssistance` json,
	`supersedesSignalId` varchar(71),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_signals_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsg_signal_identity_uidx` UNIQUE(`signalId`),
	CONSTRAINT `xsg_natural_key_uidx` UNIQUE(`userId`,`sourceId`,`eventKey`)
);
--> statement-breakpoint
CREATE INDEX `xsg_user_business_idx` ON `external_signals` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `xsg_user_claim_idx` ON `external_signals` (`userId`,`claimKey`);
--> statement-breakpoint
CREATE INDEX `xsg_user_family_idx` ON `external_signals` (`userId`,`claimFamilyKey`);
--> statement-breakpoint
CREATE INDEX `xsg_user_status_idx` ON `external_signals` (`userId`,`signalStatus`);
--> statement-breakpoint
CREATE INDEX `xsr_user_registry_idx` ON `external_sources` (`userId`,`registryClass`);
--> statement-breakpoint
CREATE TABLE `external_signal_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`signalLifecycleEventId` varchar(71) NOT NULL,
	`signalId` varchar(71) NOT NULL,
	`counterpartySignalId` varchar(71),
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(20) NOT NULL,
	`toStatus` varchar(16) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_signal_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsf_event_identity_uidx` UNIQUE(`signalLifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `xsf_user_signal_idx` ON `external_signal_lifecycle_events` (`userId`,`signalId`);
