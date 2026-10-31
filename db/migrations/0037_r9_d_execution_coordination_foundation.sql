-- R9-D Execution Coordination — stream-local provisional migration.
--
-- ARTEFACT ONLY — NOT EXECUTED. R9-X owns canonical 0037 convergence
-- (collision/sequencing with sibling R9 streams: R9-A mission authority,
-- R9-B mission planning, R9-C dependency scheduling, R9-F mission
-- governance). Do not apply; do not reference from the drizzle
-- journal/snapshot. Canonical source of truth is db/schema.ts
-- (executionActions / executionAttempts / executionLifecycleEvents).
-- Canonical R8 0036 is never modified by this artefact.

CREATE TABLE `execution_actions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`executionActionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`taskId` varchar(128) NOT NULL,
	`taskType` varchar(64) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`actionParametersHash` varchar(64) NOT NULL,
	`inputRefs` json NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`approvalReference` bigint unsigned,
	`authorizationFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(70) NOT NULL,
	`adapterType` varchar(24) NOT NULL,
	`capability` varchar(40) NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`dispatchState` varchar(20) NOT NULL,
	`dispatchFingerprint` varchar(64) NOT NULL,
	`attemptCount` int NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `exa_action_identity_uidx` UNIQUE(`executionActionId`),
	CONSTRAINT `exa_user_action_uidx` UNIQUE(`userId`,`executionActionId`),
	CONSTRAINT `exa_user_idempotency_uidx` UNIQUE(`userId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `execution_attempts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attemptId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`executionActionId` varchar(69) NOT NULL,
	`attemptNumber` int NOT NULL,
	`dispatchFingerprint` varchar(64) NOT NULL,
	`adapterType` varchar(24) NOT NULL,
	`capability` varchar(40) NOT NULL,
	`externalReference` varchar(191),
	`resultStatus` varchar(20),
	`resultHash` varchar(64),
	`failureClass` varchar(24) NOT NULL,
	`uncertaintyClass` varchar(28) NOT NULL,
	`startedAt` varchar(32) NOT NULL,
	`completedAt` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `exr_attempt_identity_uidx` UNIQUE(`attemptId`),
	CONSTRAINT `exr_user_attempt_uidx` UNIQUE(`userId`,`attemptId`),
	CONSTRAINT `exr_user_action_attempt_uidx` UNIQUE(`userId`,`executionActionId`,`attemptNumber`)
);
--> statement-breakpoint
CREATE TABLE `execution_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`executionActionId` varchar(69) NOT NULL,
	`attemptId` varchar(69),
	`lifecycleType` varchar(28) NOT NULL,
	`fromState` varchar(20),
	`toState` varchar(20) NOT NULL,
	`reasonCode` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `exl_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `exa_user_task_idx` ON `execution_actions` (`userId`,`taskId`);
--> statement-breakpoint
CREATE INDEX `exa_user_mission_idx` ON `execution_actions` (`userId`,`missionId`);
--> statement-breakpoint
CREATE INDEX `exr_user_action_idx` ON `execution_attempts` (`userId`,`executionActionId`);
--> statement-breakpoint
CREATE INDEX `exl_user_action_idx` ON `execution_lifecycle_events` (`userId`,`executionActionId`);
