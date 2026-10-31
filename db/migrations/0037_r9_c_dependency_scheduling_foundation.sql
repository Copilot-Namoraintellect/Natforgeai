-- R9-C Dependency & Scheduling Intelligence — stream-local provisional migration.
--
-- ARTEFACT ONLY — NOT EXECUTED. R9-X owns canonical 0037 convergence
-- (collision/sequencing with sibling R9 streams: R9-A mission authority,
-- R9-F mission governance). Do not apply; do not reference from the drizzle
-- journal/snapshot. Canonical source of truth is db/schema.ts
-- (missionTaskPlanSnapshots / missionDependencyEdges / missionSchedules /
-- missionScheduleLifecycleEvents).

CREATE TABLE `mission_task_plan_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`planDocument` json NOT NULL,
	`supportedCapabilities` json NOT NULL,
	`taskIds` json NOT NULL,
	`planFingerprint` varchar(64) NOT NULL,
	`planHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_task_plan_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `mtps_plan_fingerprint_uidx` UNIQUE(`planFingerprint`),
	CONSTRAINT `mtps_coordinate_fingerprint_uidx` UNIQUE(`userId`,`missionId`,`planId`,`planFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `mission_dependency_edges` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`dependencyId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`predecessorTaskId` varchar(128) NOT NULL,
	`successorTaskId` varchar(128) NOT NULL,
	`dependencyType` varchar(28) NOT NULL,
	`reason` varchar(280),
	`hardOrSoft` varchar(8) NOT NULL,
	`source` varchar(24) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_dependency_edges_id` PRIMARY KEY(`id`),
	CONSTRAINT `mde_dependency_id_uidx` UNIQUE(`dependencyId`),
	CONSTRAINT `mde_user_dependency_uidx` UNIQUE(`userId`,`dependencyId`),
	CONSTRAINT `mde_natural_key_uidx` UNIQUE(`userId`,`missionId`,`planId`,`predecessorTaskId`,`successorTaskId`,`dependencyType`)
);
--> statement-breakpoint
CREATE TABLE `mission_schedules` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`planId` varchar(128) NOT NULL,
	`planFingerprint` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL,
	`orderedTaskIds` json NOT NULL,
	`parallelGroups` json NOT NULL,
	`blockingStates` json NOT NULL,
	`dependencyRefs` json NOT NULL,
	`governanceRequirements` json NOT NULL,
	`riskClass` varchar(16) NOT NULL,
	`requiresApproval` boolean NOT NULL DEFAULT false,
	`graphHash` varchar(64) NOT NULL,
	`stateViewHash` varchar(64) NOT NULL,
	`readinessHash` varchar(64) NOT NULL,
	`approvalEvidenceHash` varchar(64) NOT NULL,
	`capabilityEvidenceHash` varchar(64) NOT NULL,
	`scheduleFingerprint` varchar(64) NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`supersedesScheduleId` varchar(69),
	`producedAt` varchar(32) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `msch_schedule_id_uidx` UNIQUE(`scheduleId`),
	CONSTRAINT `msch_user_schedule_uidx` UNIQUE(`userId`,`scheduleId`)
);
--> statement-breakpoint
CREATE TABLE `mission_schedule_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`scheduleId` varchar(69) NOT NULL,
	`lifecycleType` varchar(20) NOT NULL,
	`targetStatus` varchar(16) NOT NULL,
	`successorScheduleId` varchar(69),
	`sourceIdentity` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_schedule_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `msle_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `mtps_user_mission_plan_idx` ON `mission_task_plan_snapshots` (`userId`,`missionId`,`planId`);
--> statement-breakpoint
CREATE INDEX `mde_user_mission_plan_idx` ON `mission_dependency_edges` (`userId`,`missionId`,`planId`);
--> statement-breakpoint
CREATE INDEX `msch_user_mission_plan_idx` ON `mission_schedules` (`userId`,`missionId`,`planId`);
--> statement-breakpoint
CREATE INDEX `msch_user_status_idx` ON `mission_schedules` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `msle_user_schedule_idx` ON `mission_schedule_lifecycle_events` (`userId`,`scheduleId`);
