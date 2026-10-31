-- R9-X Mission Control Integration — CANONICAL 0037 migration.
--
-- Converged at R9-X from the six stream-local provisional migrations
-- (0037_r9_a/b/c/d/e/f_*_foundation), each proven COMPLETE against this
-- canonical file (see docs/recovery/r9-x-migration-convergence.md).
-- Canonical source of truth is db/schema.ts. R8 canonical 0036 is preserved
-- unchanged.
--
-- ARTEFACT ONLY — NOT EXECUTED. MIGRATION_EXECUTION=False (R10 gate).

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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `mission_governance_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`contractVersion` varchar(48) NOT NULL,
	`engineVersion` varchar(48) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`missionRef` varchar(128) NOT NULL,
	`planRef` varchar(128),
	`taskRef` varchar(128),
	`subjectClass` varchar(24) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`actionParamsFingerprint` varchar(64) NOT NULL,
	`missionRiskClass` varchar(16) NOT NULL,
	`riskFactors` json NOT NULL,
	`policyVersion` varchar(96),
	`decision` varchar(24) NOT NULL,
	`reasonCodes` json NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`approvalBinding` json,
	`evaluationFingerprint` varchar(64) NOT NULL,
	`validUntil` varchar(32),
	`evaluatedAt` varchar(32) NOT NULL,
	`thresholds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_governance_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mgd_decision_id_uidx` UNIQUE(`governanceDecisionId`),
	CONSTRAINT `mgd_user_decision_uidx` UNIQUE(`userId`,`governanceDecisionId`)
);
--> statement-breakpoint
CREATE INDEX `mgd_business_idx` ON `mission_governance_decisions` (`businessId`);
--> statement-breakpoint
CREATE INDEX `mgd_user_idx` ON `mission_governance_decisions` (`userId`);
--> statement-breakpoint
CREATE INDEX `mgd_mission_idx` ON `mission_governance_decisions` (`missionRef`);
--> statement-breakpoint
CREATE INDEX `mgd_decision_idx` ON `mission_governance_decisions` (`decision`);
--> statement-breakpoint
CREATE INDEX `mgd_evaluated_idx` ON `mission_governance_decisions` (`evaluatedAt`);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action','strategic_recommendation','mission_action') NOT NULL;
--> statement-breakpoint
