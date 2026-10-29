CREATE TABLE `attribution_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attributionLifecycleEventId` varchar(70) NOT NULL,
	`attributionId` varchar(69) NOT NULL,
	`priorAttributionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attribution_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `atf_event_id_uidx` UNIQUE(`attributionLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `attribution_results` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attributionId` varchar(69) NOT NULL,
	`attributionKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`conversionId` varchar(69) NOT NULL,
	`outcomeType` varchar(32) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`outcomeAmountMinor` bigint,
	`outcomeCurrency` varchar(3),
	`modelType` varchar(24) NOT NULL,
	`modelVersion` varchar(40) NOT NULL,
	`windowStart` varchar(32) NOT NULL,
	`windowEnd` varchar(32) NOT NULL,
	`journeyHash` varchar(64) NOT NULL,
	`touchpoints` json NOT NULL,
	`excludedTouchpoints` json NOT NULL,
	`totalCreditBps` int NOT NULL,
	`confidenceClass` enum('HIGH','MEDIUM','LOW','NONE') NOT NULL,
	`evidenceClass` enum('DIRECT_LINKAGE','STRONG_ASSOCIATION','WEAK_ASSOCIATION','INSUFFICIENT_EVIDENCE') NOT NULL,
	`policyVersion` varchar(96) NOT NULL,
	`sourceVersions` json NOT NULL,
	`supersedesAttributionId` varchar(69),
	`recordHash` varchar(64) NOT NULL,
	`calculatedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attribution_results_id` PRIMARY KEY(`id`),
	CONSTRAINT `atr_attribution_id_uidx` UNIQUE(`attributionId`),
	CONSTRAINT `atr_natural_key_uidx` UNIQUE(`userId`,`outcomeId`,`modelType`,`modelVersion`,`windowStart`,`windowEnd`,`journeyHash`)
);
--> statement-breakpoint
CREATE TABLE `budget_portfolio_allocation_instructions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`instructionId` varchar(68) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`optimisationId` varchar(68) NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`approvalRequestId` bigint unsigned,
	`policyVersion` varchar(96) NOT NULL,
	`authorisedAt` varchar(32) NOT NULL,
	`expiresAt` varchar(32) NOT NULL,
	`allocations` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `budget_portfolio_allocation_instructions_id` PRIMARY KEY(`id`),
	CONSTRAINT `bpi_instruction_identity_uidx` UNIQUE(`instructionId`),
	CONSTRAINT `bpi_user_instruction_uidx` UNIQUE(`userId`,`instructionId`)
);
--> statement-breakpoint
CREATE TABLE `budget_portfolio_proposals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`optimisationId` varchar(68) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`portfolioSnapshotId` varchar(69) NOT NULL,
	`budgetPeriod` varchar(7) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`currentTotalBudgetMinor` bigint NOT NULL,
	`currentAllocations` json NOT NULL,
	`proposedAllocations` json NOT NULL,
	`deltaAllocations` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`learningRefs` json NOT NULL,
	`attributionRefs` json NOT NULL,
	`outcomeRefs` json NOT NULL,
	`objective` varchar(48) NOT NULL,
	`algorithmVersion` varchar(48) NOT NULL,
	`constraintVersion` varchar(48) NOT NULL,
	`evidenceBundleHash` varchar(64) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`reasonCodes` json NOT NULL,
	`governanceDecisionId` varchar(69),
	`governanceDecision` json,
	`approvalRequired` boolean NOT NULL,
	`status` varchar(24) NOT NULL,
	`proposalContentHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`validUntil` varchar(32),
	CONSTRAINT `budget_portfolio_proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `bpp_optimisation_identity_uidx` UNIQUE(`optimisationId`),
	CONSTRAINT `bpp_user_optimisation_uidx` UNIQUE(`userId`,`optimisationId`)
);
--> statement-breakpoint
CREATE TABLE `budget_portfolio_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`portfolioSnapshotId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`budgetPeriod` varchar(7) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`approvedTotalBudgetMinor` bigint NOT NULL,
	`committedMinor` bigint NOT NULL,
	`reservedMinor` bigint NOT NULL,
	`availableReallocatableMinor` bigint NOT NULL,
	`currentAllocations` json NOT NULL,
	`supportedProviders` json NOT NULL,
	`lockedAllocationKeys` json NOT NULL,
	`disabledAllocationKeys` json NOT NULL,
	`capturedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `budget_portfolio_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `bps_snapshot_identity_uidx` UNIQUE(`portfolioSnapshotId`),
	CONSTRAINT `bps_user_snapshot_uidx` UNIQUE(`userId`,`portfolioSnapshotId`)
);
--> statement-breakpoint
CREATE TABLE `business_learning_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`learningLifecycleEventId` varchar(70) NOT NULL,
	`learningId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL,
	`reasonCode` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_learning_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bll_event_id_uidx` UNIQUE(`learningLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `business_learning_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`learningId` varchar(69) NOT NULL,
	`evidenceBundleId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`learningType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`outcomeTypeFamily` varchar(64) NOT NULL,
	`contextScope` json NOT NULL,
	`statement` json NOT NULL,
	`outcomeIds` json NOT NULL,
	`attributionIds` json NOT NULL,
	`upstreamStateFingerprint` varchar(64) NOT NULL,
	`supportCount` int NOT NULL,
	`contradictionCount` int NOT NULL,
	`confidenceClass` varchar(24) NOT NULL,
	`evidenceClass` varchar(24) NOT NULL,
	`noveltyClass` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'CANDIDATE',
	`limitations` json NOT NULL,
	`sourceVersions` json NOT NULL,
	`narrativeDraft` text,
	`validUntil` varchar(32),
	`supersedesLearningId` varchar(69),
	`recordHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`derivedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_learning_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `blr_learning_id_uidx` UNIQUE(`learningId`),
	CONSTRAINT `blr_natural_key_uidx` UNIQUE(`userId`,`evidenceBundleId`,`learningType`,`subjectType`,`subjectId`,`upstreamStateFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `business_outcome_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`outcomeLifecycleEventId` varchar(70) NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`amountMinor` bigint,
	`currency` varchar(3),
	`externalLifecycleId` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_outcome_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bole_event_id_uidx` UNIQUE(`outcomeLifecycleEventId`),
	CONSTRAINT `bole_external_uidx` UNIQUE(`outcomeId`,`externalLifecycleId`)
);
--> statement-breakpoint
CREATE TABLE `business_outcomes` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`conversionId` varchar(69) NOT NULL,
	`outcomeType` varchar(32) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`valueType` varchar(16) NOT NULL,
	`amountMinor` bigint,
	`currency` varchar(3),
	`quantity` int,
	`metricUnit` varchar(32),
	`evidenceSource` varchar(32) NOT NULL,
	`evidenceAuthority` varchar(24) NOT NULL,
	`evidenceIdentity` varchar(191) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`reversesOutcomeId` varchar(69),
	`renewsOutcomeId` varchar(69),
	`supersedesOutcomeId` varchar(69),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_outcomes_id` PRIMARY KEY(`id`),
	CONSTRAINT `bo_outcome_id_uidx` UNIQUE(`outcomeId`),
	CONSTRAINT `bo_natural_key_uidx` UNIQUE(`userId`,`conversionId`,`evidenceSource`,`evidenceIdentity`)
);
--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`assignmentId` varchar(69) NOT NULL,
	`experimentId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`subjectKey` varchar(64) NOT NULL,
	`arm` enum('CONTROL','TREATMENT') NOT NULL,
	`armIndex` int NOT NULL,
	`assignmentHash` varchar(64) NOT NULL,
	`assignedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `exa_assignment_uidx` UNIQUE(`userId`,`experimentId`,`subjectKey`)
);
--> statement-breakpoint
CREATE TABLE `experiment_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`experimentLifecycleEventId` varchar(70) NOT NULL,
	`experimentId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` enum('creation','governance','approval','activation','pause','resume','stop','completion','invalidation','cancellation') NOT NULL,
	`fromStatus` varchar(24) NOT NULL,
	`toStatus` varchar(24) NOT NULL,
	`reasonCode` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `exl_event_id_uidx` UNIQUE(`experimentLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `experiment_outcome_evidence` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`evidenceId` varchar(69) NOT NULL,
	`experimentId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`outcomeId` varchar(69) NOT NULL,
	`attributionId` varchar(69),
	`subjectKey` varchar(64) NOT NULL,
	`armIndex` int NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`outcomeType` varchar(32) NOT NULL,
	`valueType` varchar(16) NOT NULL,
	`amountMinor` bigint,
	`occurredAt` varchar(32) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_outcome_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `exe_evidence_uidx` UNIQUE(`userId`,`experimentId`,`outcomeId`)
);
--> statement-breakpoint
CREATE TABLE `experiment_results` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`resultId` varchar(69) NOT NULL,
	`experimentId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`calculationVersion` varchar(48) NOT NULL,
	`verdict` enum('INSUFFICIENT_EVIDENCE','DIRECTIONAL_SIGNAL','SUPPORTED_DIFFERENCE','NO_MEANINGFUL_DIFFERENCE','INVALID_EXPERIMENT') NOT NULL,
	`confidenceClass` varchar(24) NOT NULL,
	`primaryMetric` json NOT NULL,
	`armSummaries` json NOT NULL,
	`comparisons` json NOT NULL,
	`evidenceCounts` json NOT NULL,
	`limitations` json NOT NULL,
	`conclusion` varchar(1024) NOT NULL,
	`evidenceFingerprint` varchar(64) NOT NULL,
	`resultHash` varchar(64) NOT NULL,
	`calculatedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_results_id` PRIMARY KEY(`id`),
	CONSTRAINT `exr_result_uidx` UNIQUE(`resultId`),
	CONSTRAINT `exr_natural_uidx` UNIQUE(`userId`,`experimentId`,`calculationVersion`)
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`experimentId` varchar(69) NOT NULL,
	`hypothesisId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`learningId` varchar(69) NOT NULL,
	`statement` varchar(1024) NOT NULL,
	`designType` enum('A_B','MULTI_ARM') NOT NULL,
	`dimension` varchar(24) NOT NULL,
	`controlDefinition` json NOT NULL,
	`treatmentDefinitions` json NOT NULL,
	`allocationPolicy` json NOT NULL,
	`primaryMetric` json NOT NULL,
	`secondaryMetrics` json NOT NULL,
	`guardrails` json NOT NULL,
	`minimumSamplePerArm` int NOT NULL,
	`durationDays` int NOT NULL,
	`startAt` varchar(32),
	`endAt` varchar(32),
	`assignmentVersion` varchar(64),
	`status` enum('DRAFT','GOVERNANCE_REQUIRED','APPROVAL_REQUIRED','READY','ACTIVE','PAUSED','STOPPED','COMPLETED','INVALIDATED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`governanceDecisionId` varchar(69),
	`approvalReference` varchar(64),
	`designHash` varchar(64) NOT NULL,
	`resultId` varchar(69),
	`recordHash` varchar(64) NOT NULL,
	`narrativeDraft` text,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiments_id` PRIMARY KEY(`id`),
	CONSTRAINT `exp_experiment_id_uidx` UNIQUE(`experimentId`),
	CONSTRAINT `exp_natural_key_uidx` UNIQUE(`userId`,`learningId`,`hypothesisId`,`designHash`)
);
--> statement-breakpoint
CREATE TABLE `optimisation_governance_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`contractVersion` varchar(48) NOT NULL,
	`engineVersion` varchar(48) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`proposalId` varchar(128) NOT NULL,
	`proposalType` varchar(32) NOT NULL,
	`campaignId` bigint unsigned,
	`policyVersion` varchar(96),
	`decision` varchar(24) NOT NULL,
	`reasonCodes` json NOT NULL,
	`riskClass` varchar(16) NOT NULL,
	`financialImpactClass` varchar(48) NOT NULL,
	`financialDeltaMinor` bigint NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`approvalBinding` json,
	`evidenceHash` varchar(128) NOT NULL,
	`proposalFingerprint` varchar(64) NOT NULL,
	`validUntil` varchar(32),
	`evaluatedAt` varchar(32) NOT NULL,
	`evaluationFingerprint` varchar(64) NOT NULL,
	`thresholds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `optimisation_governance_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `ogd_decision_id_idx` UNIQUE(`governanceDecisionId`),
	CONSTRAINT `ogd_user_decision_idx` UNIQUE(`userId`,`governanceDecisionId`)
);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action') NOT NULL;--> statement-breakpoint
CREATE INDEX `atf_user_attribution_idx` ON `attribution_lifecycle_events` (`userId`,`attributionId`);--> statement-breakpoint
CREATE INDEX `atr_user_outcome_idx` ON `attribution_results` (`userId`,`outcomeId`);--> statement-breakpoint
CREATE INDEX `atr_user_business_idx` ON `attribution_results` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bpi_user_optimisation_idx` ON `budget_portfolio_allocation_instructions` (`userId`,`optimisationId`);--> statement-breakpoint
CREATE INDEX `bpp_user_business_idx` ON `budget_portfolio_proposals` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bpp_user_status_idx` ON `budget_portfolio_proposals` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `bps_user_business_idx` ON `budget_portfolio_snapshots` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bll_user_learning_idx` ON `business_learning_lifecycle_events` (`userId`,`learningId`);--> statement-breakpoint
CREATE INDEX `blr_user_business_idx` ON `business_learning_records` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `blr_user_subject_idx` ON `business_learning_records` (`userId`,`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `blr_user_status_idx` ON `business_learning_records` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `bole_user_outcome_idx` ON `business_outcome_lifecycle_events` (`userId`,`outcomeId`);--> statement-breakpoint
CREATE INDEX `bo_user_business_idx` ON `business_outcomes` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bo_user_conversion_idx` ON `business_outcomes` (`userId`,`conversionId`);--> statement-breakpoint
CREATE INDEX `bo_user_lead_idx` ON `business_outcomes` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `bo_user_status_idx` ON `business_outcomes` (`userId`,`outcomeStatus`);--> statement-breakpoint
CREATE INDEX `exa_experiment_idx` ON `experiment_assignments` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exl_user_experiment_idx` ON `experiment_lifecycle_events` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exe_experiment_idx` ON `experiment_outcome_evidence` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exr_experiment_idx` ON `experiment_results` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exp_user_business_idx` ON `experiments` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `exp_user_status_idx` ON `experiments` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `ogd_business_idx` ON `optimisation_governance_decisions` (`businessId`);--> statement-breakpoint
CREATE INDEX `ogd_user_idx` ON `optimisation_governance_decisions` (`userId`);--> statement-breakpoint
CREATE INDEX `ogd_proposal_idx` ON `optimisation_governance_decisions` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ogd_decision_idx` ON `optimisation_governance_decisions` (`decision`);--> statement-breakpoint
CREATE INDEX `ogd_evaluated_idx` ON `optimisation_governance_decisions` (`evaluatedAt`);