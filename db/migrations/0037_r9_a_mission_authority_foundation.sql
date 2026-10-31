-- R9-A Mission Authority & Objectives — stream-local provisional migration.
--
-- ARTEFACT ONLY — NOT EXECUTED. R9-X owns canonical 0037 convergence
-- (collision/sequencing with sibling R9 streams). Do not apply; do not
-- reference from the drizzle journal/snapshot. Canonical source of truth is
-- db/schema.ts (missionProposals / missionLifecycleEvents).

CREATE TABLE `mission_proposals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`objectiveId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`sourceCandidateId` varchar(69) NOT NULL,
	`sourceReasoningIds` json NOT NULL,
	`missionType` varchar(32) NOT NULL,
	`objectiveType` varchar(32) NOT NULL,
	`objectiveStatement` text NOT NULL,
	`objectiveClientStatement` text NOT NULL,
	`objectiveWordingDraft` text,
	`modelAssistanceFlagged` boolean NOT NULL DEFAULT false,
	`expectedOutcome` text NOT NULL,
	`successCriteria` json NOT NULL,
	`constraints` json NOT NULL,
	`assumptions` json NOT NULL,
	`scope` json NOT NULL,
	`scopeKey` varchar(512) NOT NULL,
	`priorityContext` varchar(20) NOT NULL,
	`strategicRiskClass` varchar(16) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`governanceDecisionId` varchar(69),
	`governanceDecision` varchar(28),
	`policyVersion` varchar(96),
	`governanceRequirements` json NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`limitations` json NOT NULL,
	`lineageHash` varchar(64) NOT NULL,
	`missionFingerprint` varchar(64) NOT NULL,
	`objectiveFingerprint` varchar(64) NOT NULL,
	`constraintSetFingerprint` varchar(64) NOT NULL,
	`sourceProjection` json NOT NULL,
	`sourceVersions` json NOT NULL,
	`supersedesMissionId` varchar(69),
	`status` varchar(28) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `mp_mission_identity_uidx` UNIQUE(`missionId`),
	CONSTRAINT `mp_user_mission_uidx` UNIQUE(`userId`,`missionId`)
);
--> statement-breakpoint
CREATE TABLE `mission_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`targetStatus` varchar(28) NOT NULL,
	`successorMissionId` varchar(69),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `mle_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `mp_user_business_idx` ON `mission_proposals` (`userId`,`businessId`);
--> statement-breakpoint
CREATE INDEX `mp_user_status_idx` ON `mission_proposals` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `mp_source_candidate_idx` ON `mission_proposals` (`sourceCandidateId`);
--> statement-breakpoint
CREATE INDEX `mle_user_mission_idx` ON `mission_lifecycle_events` (`userId`,`missionId`);
