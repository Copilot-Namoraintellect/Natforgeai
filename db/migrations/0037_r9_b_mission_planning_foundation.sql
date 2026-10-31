-- R9-B Mission Planning & Decomposition — stream-local provisional migration.
--
-- ARTEFACT ONLY — NOT EXECUTED. R9-X owns canonical 0037 convergence
-- (collision/sequencing with sibling R9 streams A and F). Do not apply; do
-- not reference from the drizzle journal/snapshot. Canonical source of truth
-- is db/schema.ts (missionPlans / missionPlanTasks / missionPlanLifecycleEvents).
-- R8 canonical 0036 is never modified by this artefact.

CREATE TABLE `mission_plans` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`planId` varchar(69) NOT NULL,
	`planVersion` int NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`missionAuthorityVersion` varchar(64) NOT NULL,
	`boundMissionVersion` int NOT NULL,
	`planScopeKey` varchar(512) NOT NULL,
	`taskIds` json NOT NULL,
	`taskSetFingerprint` varchar(64) NOT NULL,
	`constraintSetFingerprint` varchar(64) NOT NULL,
	`missionConstraints` json NOT NULL,
	`planningAssumptions` json NOT NULL,
	`unresolvedItems` json NOT NULL,
	`completenessStatus` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`supersedesPlanId` varchar(69),
	`planFingerprint` varchar(64) NOT NULL,
	`modelAssistanceFlagged` boolean NOT NULL DEFAULT false,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `mplans_plan_identity_uidx` UNIQUE(`planId`),
	CONSTRAINT `mplans_user_plan_uidx` UNIQUE(`userId`,`planId`),
	CONSTRAINT `mplans_user_mission_version_uidx` UNIQUE(`userId`,`missionId`,`planVersion`)
);
--> statement-breakpoint
CREATE TABLE `mission_plan_tasks` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`taskId` varchar(69) NOT NULL,
	`planId` varchar(69) NOT NULL,
	`planVersion` int NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`missionId` varchar(69) NOT NULL,
	`taskType` varchar(32) NOT NULL,
	`taskSequence` int NOT NULL,
	`taskObjective` text NOT NULL,
	`objectiveWordingDraft` text,
	`requiredInputs` json NOT NULL,
	`expectedOutputs` json NOT NULL,
	`requiredCapabilities` json NOT NULL,
	`constraints` json NOT NULL,
	`preconditions` json NOT NULL,
	`postconditions` json NOT NULL,
	`governanceClass` varchar(28) NOT NULL,
	`sideEffectClass` varchar(28) NOT NULL,
	`executionClass` varchar(32) NOT NULL,
	`capabilityStatus` varchar(28) NOT NULL,
	`governanceCharacteristics` json NOT NULL,
	`status` varchar(28) NOT NULL,
	`taskFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_plan_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `mptasks_task_identity_uidx` UNIQUE(`taskId`),
	CONSTRAINT `mptasks_user_task_uidx` UNIQUE(`userId`,`taskId`)
);
--> statement-breakpoint
CREATE TABLE `mission_plan_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`planId` varchar(69) NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`targetStatus` varchar(24) NOT NULL,
	`successorPlanId` varchar(69),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_plan_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `mpl_lifecycle_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `mplans_user_mission_idx` ON `mission_plans` (`userId`,`missionId`);
--> statement-breakpoint
CREATE INDEX `mplans_user_status_idx` ON `mission_plans` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `mptasks_user_plan_idx` ON `mission_plan_tasks` (`userId`,`planId`);
--> statement-breakpoint
CREATE INDEX `mpl_user_plan_idx` ON `mission_plan_lifecycle_events` (`userId`,`planId`);
