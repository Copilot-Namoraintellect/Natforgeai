-- R8-A STRATEGIC MEMORY FOUNDATION — STREAM-LOCAL PROVISIONAL MIGRATION
--
-- STATUS: artefact only — NOT executed (MIGRATION_EXECUTION=False).
-- R8-X owns canonical sequencing/convergence. R7's
-- 0035_r7_business_optimisation_foundation is untouched.
-- See docs/recovery/r8-a-unexecuted-migrations.md and
-- docs/contracts/strategic-memory-contract.md.
--
-- Strategic memory is durable, versioned context derived from authoritative
-- upstream evidence — never execution authority. No execution columns exist.
-- Deterministic mem1:/smf1: identities; immutable evidenceHash-bound cores;
-- append-only lifecycle facts; CAS-guarded status transitions.

CREATE TABLE `strategic_memory_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`memoryId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`memoryType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`statementType` varchar(16) NOT NULL,
	`factStatus` varchar(16) NOT NULL,
	`statement` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`sourceAuthority` varchar(32) NOT NULL,
	`sourceVersion` varchar(48) NOT NULL,
	`sourceIdentity` varchar(191) NOT NULL,
	`sourceFingerprint` varchar(64) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`basis` json,
	`limitations` json NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32),
	`observedAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`supersedesMemoryId` varchar(69),
	`contradictsMemoryIds` json NOT NULL,
	`contextScope` json NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_memory_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `smr_memory_id_uidx` UNIQUE(`memoryId`),
	CONSTRAINT `smr_user_memory_uidx` UNIQUE(`userId`,`memoryId`),
	CONSTRAINT `smr_natural_key_uidx` UNIQUE(`userId`,`businessId`,`sourceAuthority`,`sourceIdentity`,`memoryType`)
);
--> statement-breakpoint
CREATE TABLE `strategic_memory_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`memoryLifecycleEventId` varchar(70) NOT NULL,
	`memoryId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`targetStatus` varchar(16) NOT NULL,
	`successorMemoryId` varchar(69),
	`sourceIdentity` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_memory_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `smle_event_id_uidx` UNIQUE(`memoryLifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `smr_user_business_idx` ON `strategic_memory_records` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `smr_user_status_idx` ON `strategic_memory_records` (`userId`,`factStatus`);
--> statement-breakpoint
CREATE INDEX `smr_user_subject_idx` ON `strategic_memory_records` (`userId`,`subjectType`,`subjectId`);
--> statement-breakpoint
CREATE INDEX `smr_user_source_idx` ON `strategic_memory_records` (`userId`,`sourceAuthority`);
--> statement-breakpoint
CREATE INDEX `smle_user_memory_idx` ON `strategic_memory_lifecycle_events` (`userId`,`memoryId`);
