CREATE TABLE `business_change_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`changeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`changeDomain` varchar(32) NOT NULL,
	`changeType` varchar(40) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`previousStateRef` json NOT NULL,
	`currentStateRef` json NOT NULL,
	`previousStateFingerprint` varchar(64) NOT NULL,
	`currentStateFingerprint` varchar(64) NOT NULL,
	`previousStateValueFingerprint` varchar(64) NOT NULL,
	`currentStateValueFingerprint` varchar(64) NOT NULL,
	`evidenceRefs` json NOT NULL,
	`sourceAuthority` varchar(32) NOT NULL,
	`sourceVersion` varchar(48) NOT NULL,
	`significanceClass` varchar(16) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`detectedAt` varchar(32) NOT NULL,
	`effectiveAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`validUntil` varchar(32),
	`supersedesChangeId` varchar(69),
	`limitations` json NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_change_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bce_change_id_uidx` UNIQUE(`changeId`),
	CONSTRAINT `bce_user_change_uidx` UNIQUE(`userId`,`changeId`),
	CONSTRAINT `bce_natural_key_uidx` UNIQUE(`userId`,`businessId`,`subjectType`,`subjectId`,`changeType`,`previousStateFingerprint`,`currentStateFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `business_change_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`changeLifecycleEventId` varchar(69) NOT NULL,
	`changeId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`targetStatus` varchar(16) NOT NULL,
	`successorChangeId` varchar(69),
	`sourceIdentity` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_change_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bcle_event_id_uidx` UNIQUE(`changeLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `external_signal_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`signalLifecycleEventId` varchar(71) NOT NULL,
	`signalId` varchar(71) NOT NULL,
	`counterpartySignalId` varchar(71),
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(20) NOT NULL,
	`toStatus` varchar(16) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_signal_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsf_event_identity_uidx` UNIQUE(`signalLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `external_signals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`signalId` varchar(71) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`signalType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectRef` varchar(191) NOT NULL,
	`claimAspect` varchar(64) NOT NULL,
	`sourceId` varchar(70) NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`sourceUriRef` varchar(191) NOT NULL,
	`eventKey` varchar(191) NOT NULL,
	`registryClass` varchar(24) NOT NULL,
	`sourceTrustClass` varchar(28) NOT NULL,
	`sourceIndependenceKey` varchar(191) NOT NULL,
	`claimText` text NOT NULL,
	`claimKey` varchar(64) NOT NULL,
	`claimFamilyKey` varchar(64) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`publishedAt` varchar(32),
	`ingestedAt` varchar(32) NOT NULL,
	`freshnessClass` varchar(16) NOT NULL,
	`freshnessPolicyVersion` varchar(48) NOT NULL,
	`corroborationStatus` varchar(20) NOT NULL,
	`corroboratingSignalIds` json NOT NULL,
	`contradictingSignalIds` json NOT NULL,
	`relevanceClass` varchar(16) NOT NULL,
	`relevanceEvidence` json NOT NULL,
	`confidenceClass` varchar(12) NOT NULL,
	`signalStatus` varchar(16) NOT NULL,
	`contentIsolation` varchar(24) NOT NULL,
	`injectionSuspected` varchar(8) NOT NULL DEFAULT 'false',
	`limitations` json NOT NULL,
	`modelAssistance` json,
	`supersedesSignalId` varchar(71),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_signals_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsg_signal_identity_uidx` UNIQUE(`signalId`),
	CONSTRAINT `xsg_natural_key_uidx` UNIQUE(`userId`,`sourceId`,`eventKey`)
);
--> statement-breakpoint
CREATE TABLE `external_sources` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`sourceId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`originKey` varchar(191) NOT NULL,
	`sourceUriRef` varchar(191) NOT NULL,
	`registryClass` varchar(24) NOT NULL,
	`spoofFlagged` varchar(16),
	`firstSeenAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `external_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `xsr_source_identity_uidx` UNIQUE(`sourceId`),
	CONSTRAINT `xsr_natural_key_uidx` UNIQUE(`userId`,`originKey`)
);
--> statement-breakpoint
CREATE TABLE `strategic_governance_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`contractVersion` varchar(48) NOT NULL,
	`engineVersion` varchar(48) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`proposalId` varchar(128) NOT NULL,
	`recommendationType` varchar(48) NOT NULL,
	`evidenceRefs` json NOT NULL,
	`sourceTrustClass` varchar(32) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`strategicRiskClass` varchar(16) NOT NULL,
	`policyVersion` varchar(96),
	`decision` varchar(24) NOT NULL,
	`reasonCodes` json NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`approvalBinding` json,
	`evidenceFingerprint` varchar(64) NOT NULL,
	`proposalFingerprint` varchar(64) NOT NULL,
	`validUntil` varchar(32),
	`evaluatedAt` varchar(32) NOT NULL,
	`evaluationFingerprint` varchar(64) NOT NULL,
	`thresholds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_governance_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sgd_decision_id_idx` UNIQUE(`governanceDecisionId`),
	CONSTRAINT `sgd_user_decision_idx` UNIQUE(`userId`,`governanceDecisionId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_memory_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`memoryLifecycleEventId` varchar(70) NOT NULL,
	`memoryId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`targetStatus` varchar(16) NOT NULL,
	`successorMemoryId` varchar(69),
	`sourceIdentity` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_memory_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `smle_event_id_uidx` UNIQUE(`memoryLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `strategic_memory_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`memoryId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`memoryType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`statementType` varchar(16) NOT NULL,
	`factStatus` varchar(16) NOT NULL,
	`statement` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`sourceAuthority` varchar(32) NOT NULL,
	`sourceVersion` varchar(48) NOT NULL,
	`sourceIdentity` varchar(191) NOT NULL,
	`sourceFingerprint` varchar(64) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`basis` json,
	`limitations` json NOT NULL,
	`validFrom` varchar(32) NOT NULL,
	`validUntil` varchar(32),
	`observedAt` varchar(32) NOT NULL,
	`recordedAt` varchar(32) NOT NULL,
	`supersedesMemoryId` varchar(69),
	`contradictsMemoryIds` json NOT NULL,
	`contextScope` json NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategic_memory_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `smr_memory_id_uidx` UNIQUE(`memoryId`),
	CONSTRAINT `smr_user_memory_uidx` UNIQUE(`userId`,`memoryId`),
	CONSTRAINT `smr_natural_key_uidx` UNIQUE(`userId`,`businessId`,`sourceAuthority`,`sourceIdentity`,`memoryType`)
);
--> statement-breakpoint
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
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action','strategic_recommendation') NOT NULL;--> statement-breakpoint
CREATE INDEX `bce_user_business_idx` ON `business_change_events` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bce_user_status_idx` ON `business_change_events` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `bce_user_subject_idx` ON `business_change_events` (`userId`,`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `bce_user_source_idx` ON `business_change_events` (`userId`,`sourceAuthority`);--> statement-breakpoint
CREATE INDEX `bce_user_value_fp_idx` ON `business_change_events` (`userId`,`subjectType`,`subjectId`,`currentStateValueFingerprint`);--> statement-breakpoint
CREATE INDEX `bcle_user_change_idx` ON `business_change_lifecycle_events` (`userId`,`changeId`);--> statement-breakpoint
CREATE INDEX `xsf_user_signal_idx` ON `external_signal_lifecycle_events` (`userId`,`signalId`);--> statement-breakpoint
CREATE INDEX `xsg_user_business_idx` ON `external_signals` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `xsg_user_claim_idx` ON `external_signals` (`userId`,`claimKey`);--> statement-breakpoint
CREATE INDEX `xsg_user_family_idx` ON `external_signals` (`userId`,`claimFamilyKey`);--> statement-breakpoint
CREATE INDEX `xsg_user_status_idx` ON `external_signals` (`userId`,`signalStatus`);--> statement-breakpoint
CREATE INDEX `xsr_user_registry_idx` ON `external_sources` (`userId`,`registryClass`);--> statement-breakpoint
CREATE INDEX `sgd_business_idx` ON `strategic_governance_decisions` (`businessId`);--> statement-breakpoint
CREATE INDEX `sgd_user_idx` ON `strategic_governance_decisions` (`userId`);--> statement-breakpoint
CREATE INDEX `sgd_proposal_idx` ON `strategic_governance_decisions` (`proposalId`);--> statement-breakpoint
CREATE INDEX `sgd_decision_idx` ON `strategic_governance_decisions` (`decision`);--> statement-breakpoint
CREATE INDEX `sgd_evaluated_idx` ON `strategic_governance_decisions` (`evaluatedAt`);--> statement-breakpoint
CREATE INDEX `smle_user_memory_idx` ON `strategic_memory_lifecycle_events` (`userId`,`memoryId`);--> statement-breakpoint
CREATE INDEX `smr_user_business_idx` ON `strategic_memory_records` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `smr_user_status_idx` ON `strategic_memory_records` (`userId`,`factStatus`);--> statement-breakpoint
CREATE INDEX `smr_user_subject_idx` ON `strategic_memory_records` (`userId`,`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `smr_user_source_idx` ON `strategic_memory_records` (`userId`,`sourceAuthority`);--> statement-breakpoint
CREATE INDEX `sorc_user_business_idx` ON `strategic_opportunity_risk_candidates` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `sorc_user_status_idx` ON `strategic_opportunity_risk_candidates` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `sorc_governance_decision_idx` ON `strategic_opportunity_risk_candidates` (`governanceDecisionId`);--> statement-breakpoint
CREATE INDEX `sorle_user_candidate_idx` ON `strategic_opportunity_risk_lifecycle_events` (`userId`,`candidateId`);--> statement-breakpoint
CREATE INDEX `sorrel_user_candidate_idx` ON `strategic_opportunity_risk_relations` (`userId`,`candidateId`);--> statement-breakpoint
CREATE INDEX `srb_user_business_idx` ON `strategic_reasoning_bundles` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `srle_user_reasoning_idx` ON `strategic_reasoning_lifecycle_events` (`userId`,`reasoningId`);--> statement-breakpoint
CREATE INDEX `srr_user_business_idx` ON `strategic_reasoning_records` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `srr_governance_decision_idx` ON `strategic_reasoning_records` (`governanceDecisionId`);