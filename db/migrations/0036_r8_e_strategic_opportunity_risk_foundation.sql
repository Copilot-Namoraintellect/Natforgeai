-- R8-E STRATEGIC OPPORTUNITY & RISK FOUNDATION — STREAM-LOCAL PROVISIONAL MIGRATION
--
-- STATUS: artefact only — NOT executed (MIGRATION_EXECUTION=False).
-- R8-X owns canonical sequencing/convergence and collision resolution with
-- the other stream-local 0036 provisionals (R8-A strategic memory, R8-B
-- business change, R8-C market external signals, R8-D strategic reasoning,
-- R8-F strategic governance). Multiple stream-local 0036 artefacts exist by
-- design; the journal name collides provisionally and R8-X renames at
-- convergence. R7's 0035_r7_business_optimisation_foundation is untouched.
-- See docs/recovery/r8-e-unexecuted-migrations.md and
-- docs/contracts/strategic-opportunity-risk-contract.md.
--
-- Strategic opportunity/risk candidates are bounded, evidence-preserving
-- strategic evidence derived from governed R8-D conclusions — never
-- execution instructions. No execution columns exist. Deterministic
-- sor1:/sorl1: identities; fingerprint-bound immutable material cores;
-- append-only lifecycle facts; durable convergence anchors (userId,
-- candidateId); deterministic relation lineage (never score inputs).

CREATE TABLE `strategic_opportunity_risk_candidates` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`candidateId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`candidateKind` varchar(16) NOT NULL,
	`candidateType` varchar(32) NOT NULL,
	`reasoningIds` json NOT NULL,
	`memoryRefs` json NOT NULL,
	`changeRefs` json NOT NULL,
	`signalRefs` json NOT NULL,
	`supportingEvidence` json NOT NULL,
	`contradictingEvidence` json NOT NULL,
	`anchorRefs` json NOT NULL,
	`subjectKey` varchar(512) NOT NULL,
	`evidenceBundleFingerprint` varchar(64) NOT NULL,
	`candidateFingerprint` varchar(64) NOT NULL,
	`impactClass` varchar(16) NOT NULL,
	`urgencyClass` varchar(16) NOT NULL,
	`timeHorizon` varchar(16) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`evidenceQualityScore` int NOT NULL,
	`priorityScore` int NOT NULL,
	`priorityClass` varchar(20) NOT NULL,
	`strategicRiskClass` varchar(16),
	`governanceDecisionId` varchar(69),
	`governanceDecision` varchar(28),
	`governanceRecord` json,
	`policyVersion` varchar(96),
	`approvalStatus` varchar(12) NOT NULL,
	`status` varchar(28) NOT NULL,
	`portfolioRelation` varchar(16) NOT NULL,
	`relationCandidateIds` json NOT NULL,
	`derivationOutcome` varchar(20) NOT NULL,
	`limitations` json NOT NULL,
	`validUntil` varchar(32),
	`supersedesCandidateId` varchar(69),
	`sourceVersions` json NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_opportunity_risk_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `sorc_candidate_identity_uidx` UNIQUE(`candidateId`),
	CONSTRAINT `sorc_user_candidate_uidx` UNIQUE(`userId`,`candidateId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_opportunity_risk_relations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`relationId` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`candidateId` varchar(69) NOT NULL,
	`relatedCandidateId` varchar(69) NOT NULL,
	`relation` varchar(16) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_opportunity_risk_relations_id` PRIMARY KEY(`id`),
	CONSTRAINT `sorrel_relation_identity_uidx` UNIQUE(`relationId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_opportunity_risk_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`candidateId` varchar(69) NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`targetStatus` varchar(28) NOT NULL,
	`successorCandidateId` varchar(69),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_opportunity_risk_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `sorle_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `sorc_user_business_idx` ON `strategic_opportunity_risk_candidates` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `sorc_user_status_idx` ON `strategic_opportunity_risk_candidates` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `sorc_governance_decision_idx` ON `strategic_opportunity_risk_candidates` (`governanceDecisionId`);
--> statement-breakpoint
CREATE INDEX `sorrel_user_candidate_idx` ON `strategic_opportunity_risk_relations` (`userId`,`candidateId`);
--> statement-breakpoint
CREATE INDEX `sorle_user_candidate_idx` ON `strategic_opportunity_risk_lifecycle_events` (`userId`,`candidateId`);
