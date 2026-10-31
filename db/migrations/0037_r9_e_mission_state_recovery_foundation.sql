-- R9-E Mission State, Recovery & Observability — stream-local provisional migration.
--
-- ARTEFACT ONLY — NOT EXECUTED. R9-X owns canonical 0037 convergence
-- (collision/sequencing with sibling R9 streams: R9-D execution coordination,
-- R9-F mission governance). Do not apply; do not reference from the drizzle
-- journal/snapshot. Canonical source of truth is db/schema.ts
-- (missionStateRecords / missionTaskStates / missionRecoveryCandidates /
-- missionOperationalTimelineEvents). Canonical R8 0036 is never modified by
-- this artefact.

CREATE TABLE `mission_state_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`missionStateId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`missionStatus` varchar(28) NOT NULL,
	`healthClass` varchar(16) NOT NULL,
	`taskSummary` json NOT NULL,
	`latestExecutionRefs` json NOT NULL,
	`blockingReasons` json NOT NULL,
	`uncertainties` json NOT NULL,
	`recoveryCandidateIds` json NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`derivedFromVersion` varchar(64) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_state_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `msr_state_identity_uidx` UNIQUE(`missionStateId`),
	CONSTRAINT `msr_user_state_uidx` UNIQUE(`userId`,`missionStateId`)
);
--> statement-breakpoint
CREATE TABLE `mission_task_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`taskStateId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`taskId` varchar(128) NOT NULL,
	`latestAttemptId` varchar(69),
	`status` varchar(20) NOT NULL,
	`failureClass` varchar(32) NOT NULL,
	`uncertaintyClass` varchar(28) NOT NULL,
	`retryEligibility` tinyint(1) NOT NULL,
	`recoveryRequired` tinyint(1) NOT NULL,
	`blockingReasons` json NOT NULL,
	`uncertainties` json NOT NULL,
	`lastUpdatedAt` varchar(32) NOT NULL,
	`stateHash` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_task_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `mts_state_identity_uidx` UNIQUE(`taskStateId`),
	CONSTRAINT `mts_user_state_uidx` UNIQUE(`userId`,`taskStateId`)
);
--> statement-breakpoint
CREATE TABLE `mission_recovery_candidates` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`recoveryCandidateId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`taskId` varchar(128) NOT NULL,
	`executionActionId` varchar(69),
	`latestAttemptId` varchar(69),
	`failureClass` varchar(32) NOT NULL,
	`uncertaintyClass` varchar(28) NOT NULL,
	`recoveryType` varchar(28) NOT NULL,
	`status` varchar(20) NOT NULL,
	`scope` json NOT NULL,
	`proposalHash` varchar(64) NOT NULL,
	`governanceDecisionId` varchar(69),
	`governanceStatus` varchar(20),
	`consumedAuthorization` json,
	`supersededByRecoveryId` varchar(69),
	`validUntil` varchar(32),
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_recovery_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `mrc_identity_uidx` UNIQUE(`recoveryCandidateId`),
	CONSTRAINT `mrc_user_recovery_uidx` UNIQUE(`userId`,`recoveryCandidateId`)
);
--> statement-breakpoint
CREATE TABLE `mission_operational_timeline_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`timelineEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`scheduleId` varchar(69),
	`taskId` varchar(128),
	`recoveryCandidateId` varchar(69),
	`eventType` varchar(32) NOT NULL,
	`eventLabel` varchar(64) NOT NULL,
	`fromStatus` varchar(28),
	`toStatus` varchar(28),
	`occurredAt` varchar(32) NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_operational_timeline_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `mote_identity_uidx` UNIQUE(`timelineEventId`),
	CONSTRAINT `mote_user_timeline_uidx` UNIQUE(`userId`,`timelineEventId`)
);
--> statement-breakpoint
CREATE INDEX `msr_user_mission_idx` ON `mission_state_records` (`userId`,`missionId`);
--> statement-breakpoint
CREATE INDEX `mts_user_mission_task_idx` ON `mission_task_states` (`userId`,`missionId`,`taskId`);
--> statement-breakpoint
CREATE INDEX `mrc_user_mission_idx` ON `mission_recovery_candidates` (`userId`,`missionId`);
--> statement-breakpoint
CREATE INDEX `mrc_user_task_idx` ON `mission_recovery_candidates` (`userId`,`taskId`);
--> statement-breakpoint
CREATE INDEX `mote_user_mission_idx` ON `mission_operational_timeline_events` (`userId`,`missionId`);
