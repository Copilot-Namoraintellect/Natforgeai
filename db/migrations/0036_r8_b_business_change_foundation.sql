-- R8-B BUSINESS CHANGE INTELLIGENCE FOUNDATION — STREAM-LOCAL PROVISIONAL MIGRATION
--
-- STATUS: artefact only — NOT executed (MIGRATION_EXECUTION=False).
-- R8-X owns canonical sequencing/convergence and collision resolution with
-- the other stream-local 0036 provisionals (R8-A strategic memory, R8-F
-- strategic governance). R7's 0035_r7_business_optimisation_foundation is
-- untouched.
-- See docs/recovery/r8-b-unexecuted-migrations.md and
-- docs/contracts/business-change-intelligence-contract.md.
--
-- Business change evidence is a deterministic before/after comparison of
-- authoritative states — never execution authority. No execution columns
-- exist. Deterministic chg1:/bcl1: identities; immutable evidenceHash-bound
-- cores; append-only lifecycle facts; CAS-guarded status transitions.

CREATE TABLE `business_change_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`changeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`changeDomain` varchar(32) NOT NULL,
	`changeType` varchar(40) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`previousStateRef` json NOT NULL,
	`currentStateRef` json NOT NULL,
	`previousStateFingerprint` varchar(64) NOT NULL,
	`currentStateFingerprint` varchar(64) NOT NULL,
	`previousStateValueFingerprint` varchar(64) NOT NULL,
	`currentStateValueFingerprint` varchar(64) NOT NULL,
	`evidenceRefs` json NOT NULL,
	`sourceAuthority` varchar(32) NOT NULL,
	`sourceVersion` varchar(48) NOT NULL,
	`significanceClass` varchar(16) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`detectedAt` varchar(32) NOT NULL,
	`effectiveAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`validUntil` varchar(32),
	`supersedesChangeId` varchar(69),
	`limitations` json NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_change_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bce_change_id_uidx` UNIQUE(`changeId`),
	CONSTRAINT `bce_user_change_uidx` UNIQUE(`userId`,`changeId`),
	CONSTRAINT `bce_natural_key_uidx` UNIQUE(`userId`,`businessId`,`subjectType`,`subjectId`,`changeType`,`previousStateFingerprint`,`currentStateFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `business_change_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`changeLifecycleEventId` varchar(69) NOT NULL,
	`changeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`targetStatus` varchar(16) NOT NULL,
	`successorChangeId` varchar(69),
	`sourceIdentity` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_change_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bcle_event_id_uidx` UNIQUE(`changeLifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `bce_user_business_idx` ON `business_change_events` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `bce_user_status_idx` ON `business_change_events` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `bce_user_subject_idx` ON `business_change_events` (`userId`,`subjectType`,`subjectId`);
--> statement-breakpoint
CREATE INDEX `bce_user_source_idx` ON `business_change_events` (`userId`,`sourceAuthority`);
--> statement-breakpoint
CREATE INDEX `bce_user_value_fp_idx` ON `business_change_events` (`userId`,`subjectType`,`subjectId`,`currentStateValueFingerprint`);
--> statement-breakpoint
CREATE INDEX `bcle_user_change_idx` ON `business_change_lifecycle_events` (`userId`,`changeId`);
