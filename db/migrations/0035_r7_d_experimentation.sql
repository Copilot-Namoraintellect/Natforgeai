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
CREATE INDEX `exa_experiment_idx` ON `experiment_assignments` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exl_user_experiment_idx` ON `experiment_lifecycle_events` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exe_experiment_idx` ON `experiment_outcome_evidence` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exr_experiment_idx` ON `experiment_results` (`userId`,`experimentId`);--> statement-breakpoint
CREATE INDEX `exp_user_business_idx` ON `experiments` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `exp_user_status_idx` ON `experiments` (`userId`,`status`);