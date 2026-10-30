-- R8-D STRATEGIC REASONING FOUNDATION — STREAM-LOCAL PROVISIONAL MIGRATION
--
-- STATUS: artefact only — NOT executed (MIGRATION_EXECUTION=False).
-- R8-X owns canonical sequencing/convergence and collision resolution with
-- the other stream-local 0036 provisionals (R8-A strategic memory, R8-B
-- business change, R8-C market external signals, R8-F strategic governance).
-- R7's 0035_r7_business_optimisation_foundation is untouched.
-- See docs/recovery/r8-d-unexecuted-migrations.md and
-- docs/contracts/strategic-reasoning-contract.md.
--
-- Strategic reasoning is bounded, evidence-preserving synthesis over frozen
-- upstream authorities — never execution authority. No execution columns
-- exist. Deterministic evb1:/hyp1:/rsn1:/srl1: identities; immutable
-- fingerprint-bound cores; append-only lifecycle facts; durable convergence
-- anchors (userId, bundleId) and (userId, reasoningId).

CREATE TABLE `strategic_reasoning_bundles` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`bundleId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`evidenceRefs` json NOT NULL,
	`evidenceFingerprint` varchar(64) NOT NULL,
	`reasoningGraph` json NOT NULL,
	`sourceVersions` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_reasoning_bundles_id` PRIMARY KEY(`id`),
	CONSTRAINT `srb_bundle_identity_uidx` UNIQUE(`bundleId`),
	CONSTRAINT `srb_user_bundle_uidx` UNIQUE(`userId`,`bundleId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_reasoning_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`reasoningId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`bundleId` varchar(69) NOT NULL,
	`hypothesisId` varchar(69) NOT NULL,
	`hypothesisType` varchar(40) NOT NULL,
	`implicationType` varchar(32) NOT NULL,
	`supportingEvidence` json NOT NULL,
	`contradictingEvidence` json NOT NULL,
	`missingEvidence` json NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`uncertaintyClasses` json NOT NULL,
	`strategicRiskClass` varchar(16),
	`status` varchar(28) NOT NULL,
	`governanceDecisionId` varchar(69),
	`governanceDecision` varchar(28),
	`governanceDecisionRecord` json,
	`policyVersion` varchar(96),
	`evidenceFingerprint` varchar(64) NOT NULL,
	`reasoningFingerprint` varchar(64) NOT NULL,
	`limitations` json NOT NULL,
	`validUntil` varchar(32),
	`supersedesReasoningId` varchar(69),
	`sourceVersions` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_reasoning_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `srr_reasoning_identity_uidx` UNIQUE(`reasoningId`),
	CONSTRAINT `srr_user_reasoning_uidx` UNIQUE(`userId`,`reasoningId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_reasoning_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`reasoningId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`targetStatus` varchar(28) NOT NULL,
	`successorReasoningId` varchar(69),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_reasoning_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `srle_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `srb_user_business_idx` ON `strategic_reasoning_bundles` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `srr_user_business_idx` ON `strategic_reasoning_records` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `srr_governance_decision_idx` ON `strategic_reasoning_records` (`governanceDecisionId`);
--> statement-breakpoint
CREATE INDEX `srle_user_reasoning_idx` ON `strategic_reasoning_lifecycle_events` (`userId`,`reasoningId`);
