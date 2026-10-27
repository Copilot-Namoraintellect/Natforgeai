CREATE TABLE `conversion_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`conversionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`leadId` bigint unsigned,
	`leadIdentityVersion` varchar(64),
	`externalConversionId` varchar(191) NOT NULL,
	`sourceSystem` varchar(32) NOT NULL,
	`sourceTrustClass` varchar(24) NOT NULL,
	`conversionType` varchar(32) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`amount` bigint,
	`currency` varchar(3),
	`outcomeStatus` varchar(16) NOT NULL,
	`reversesConversionId` varchar(69),
	`sourceOpportunityId` varchar(69),
	`sourceEngagementReceiptId` varchar(64),
	`sourceSignalId` varchar(64),
	`sourceCampaignId` bigint unsigned,
	`sourcePublicationId` bigint unsigned,
	`evidenceReference` varchar(255),
	`evidenceHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversion_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ce_conversion_id_uidx` UNIQUE(`conversionId`),
	CONSTRAINT `ce_natural_key_uidx` UNIQUE(`userId`,`sourceSystem`,`externalConversionId`)
);
--> statement-breakpoint
CREATE TABLE `conversion_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`conversionId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(16) NOT NULL,
	`outcomeStatus` varchar(16) NOT NULL,
	`amount` bigint,
	`currency` varchar(3),
	`externalLifecycleId` varchar(191),
	`occurredAt` varchar(32) NOT NULL,
	`reasonCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversion_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `cle_event_id_uidx` UNIQUE(`lifecycleEventId`),
	CONSTRAINT `cle_external_uidx` UNIQUE(`conversionId`,`externalLifecycleId`)
);
--> statement-breakpoint
CREATE TABLE `handoff_dispatch_receipts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`executionIdentity` varchar(69) NOT NULL,
	`handoffId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`attemptSeq` int NOT NULL,
	`outcome` enum('ACCEPTED','REJECTED','FAILURE') NOT NULL,
	`providerAck` varchar(255),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `handoff_dispatch_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `hdr_execution_identity_uidx` UNIQUE(`executionIdentity`)
);
--> statement-breakpoint
CREATE TABLE `lead_identities` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadId` varchar(69) NOT NULL,
	`identityKey` varchar(64) NOT NULL,
	`contractVersion` varchar(40) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`primaryIdentityType` enum('provider_actor','email_hash','phone_hash','authenticated_customer_reference','crm_external_reference','anonymous_thread','unknown') NOT NULL,
	`identityStatus` enum('active','anonymous','partially_identified','resolved','conflicting','suppressed','merged','archived') NOT NULL,
	`identityConfidence` enum('unknown','low','medium','high') NOT NULL,
	`externalActorReferenceHash` varchar(64),
	`provider` enum('meta','linkedin','twitter','tiktok'),
	`emailIdentityHash` varchar(64),
	`phoneIdentityHash` varchar(64),
	`customerReferenceHash` varchar(64),
	`sourceOpportunityId` varchar(69) NOT NULL,
	`sourceHandoffId` varchar(69) NOT NULL,
	`canonicalLeadId` varchar(69),
	`firstObservedAt` varchar(32) NOT NULL,
	`lastObservedAt` varchar(32) NOT NULL,
	`provenanceCount` int NOT NULL DEFAULT 1,
	`identityEvidenceCount` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`statusChangedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `li_user_identity_uidx` UNIQUE(`userId`,`identityKey`),
	CONSTRAINT `li_user_lead_uidx` UNIQUE(`userId`,`leadId`),
	CONSTRAINT `li_user_email_uidx` UNIQUE(`userId`,`emailIdentityHash`),
	CONSTRAINT `li_user_phone_uidx` UNIQUE(`userId`,`phoneIdentityHash`),
	CONSTRAINT `li_user_custref_uidx` UNIQUE(`userId`,`customerReferenceHash`)
);
--> statement-breakpoint
CREATE TABLE `lead_identity_merges` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`mergeId` varchar(69) NOT NULL,
	`mergeHash` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`canonicalLeadId` varchar(69) NOT NULL,
	`absorbedLeadId` varchar(69) NOT NULL,
	`linkingEvidenceType` enum('email_hash','phone_hash','authenticated_customer_reference','crm_external_reference') NOT NULL,
	`linkingEvidenceHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identity_merges_id` PRIMARY KEY(`id`),
	CONSTRAINT `lim_user_merge_uidx` UNIQUE(`userId`,`mergeId`),
	CONSTRAINT `lim_user_pair_uidx` UNIQUE(`userId`,`canonicalLeadId`,`absorbedLeadId`),
	CONSTRAINT `lim_user_hash_uidx` UNIQUE(`userId`,`mergeHash`)
);
--> statement-breakpoint
CREATE TABLE `lead_identity_provenance` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadRowId` bigint unsigned NOT NULL,
	`leadId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`kind` enum('opportunity_handoff','identity_evidence','merge','conflict') NOT NULL,
	`handoffId` varchar(69),
	`opportunityId` varchar(69),
	`provider` enum('meta','linkedin','twitter','tiktok'),
	`campaignId` bigint unsigned,
	`publicationId` varchar(128),
	`evidenceType` varchar(40),
	`evidenceHash` varchar(64) NOT NULL,
	`envelopeHash` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identity_provenance_id` PRIMARY KEY(`id`),
	CONSTRAINT `lip_user_handoff_uidx` UNIQUE(`userId`,`handoffId`),
	CONSTRAINT `lip_user_kind_hash_uidx` UNIQUE(`userId`,`kind`,`evidenceHash`)
);
--> statement-breakpoint
CREATE TABLE `lead_privacy_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`privacyState` enum('ACTIVE','SUPPRESSED','RESTRICTED','RETENTION_PENDING','RETENTION_EXPIRED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`previousState` enum('ACTIVE','SUPPRESSED','RESTRICTED','RETENTION_PENDING','RETENTION_EXPIRED','ARCHIVED'),
	`reason` varchar(500),
	`retentionDeadlineAt` timestamp,
	`source` varchar(32) NOT NULL DEFAULT 'operator',
	`actorUserId` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_privacy_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `lps_lead_uidx` UNIQUE(`leadId`)
);
--> statement-breakpoint
CREATE TABLE `lead_qualification_reviews` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`reviewId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` varchar(69) NOT NULL,
	`qualificationId` varchar(69) NOT NULL,
	`decisionBindingHash` varchar(64) NOT NULL,
	`status` enum('pending','progress_authorized','progression_rejected') NOT NULL,
	`triggerReasonCodes` json NOT NULL,
	`resolvedBy` bigint unsigned,
	`resolvedAt` varchar(32),
	`resolutionReason` varchar(500),
	`pendingChallengeToken` varchar(255),
	`challengeExpiresAt` varchar(32),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_qualification_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `lqr_review_uidx` UNIQUE(`userId`,`reviewId`),
	CONSTRAINT `lqr_qualification_uidx` UNIQUE(`userId`,`qualificationId`)
);
--> statement-breakpoint
CREATE TABLE `lead_qualifications` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`qualificationId` varchar(69) NOT NULL,
	`contractVersion` varchar(40) NOT NULL,
	`engineVersion` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` varchar(69) NOT NULL,
	`leadIdentityVersion` varchar(96) NOT NULL,
	`identityReference` varchar(64) NOT NULL,
	`leadScoreId` varchar(69) NOT NULL,
	`scoringVersion` varchar(64) NOT NULL,
	`scoreContentHash` varchar(64) NOT NULL,
	`qualificationPolicyVersion` varchar(96) NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`evidenceSnapshot` json NOT NULL,
	`decision` enum('QUALIFIED','NOT_QUALIFIED','REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE','BLOCKED') NOT NULL,
	`reasonCodes` json NOT NULL,
	`confidenceScore` int NOT NULL,
	`reviewRequired` boolean NOT NULL,
	`evaluatedAt` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_qualifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `lqd_convergence_uidx` UNIQUE(`userId`,`qualificationId`)
);
--> statement-breakpoint
CREATE TABLE `lead_score_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadScoreId` varchar(69) NOT NULL,
	`evidenceSnapshotId` varchar(69) NOT NULL,
	`scoreContractVersion` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` bigint unsigned NOT NULL,
	`leadIdentityVersion` varchar(96) NOT NULL,
	`scoringVersion` varchar(64) NOT NULL,
	`featureVersion` varchar(64) NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`evidenceManifest` json NOT NULL,
	`overallScore` int NOT NULL,
	`scoreBand` enum('VERY_LOW','LOW','MEDIUM','HIGH','VERY_HIGH') NOT NULL,
	`scoreConfidence` enum('LOW','MEDIUM','HIGH','UNKNOWN') NOT NULL,
	`fitScore` int NOT NULL,
	`intentScore` int NOT NULL,
	`engagementScore` int NOT NULL,
	`recencyScore` int NOT NULL,
	`opportunityScore` int NOT NULL,
	`componentWeights` json NOT NULL,
	`reasonCodes` json NOT NULL,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_score_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `lss_convergence_uidx` UNIQUE(`userId`,`leadId`,`evidenceSnapshotHash`,`scoringVersion`),
	CONSTRAINT `lss_score_id_uidx` UNIQUE(`leadScoreId`)
);
--> statement-breakpoint
CREATE TABLE `nurture_handoff_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`nurtureDecisionId` varchar(69) NOT NULL,
	`decisionKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` varchar(69) NOT NULL,
	`qualificationId` varchar(69) NOT NULL,
	`qualificationFingerprint` varchar(64) NOT NULL,
	`qualificationPolicyVersion` varchar(96) NOT NULL,
	`privacyState` enum('ACTIVE','SUPPRESSED','RESTRICTED','RETENTION_PENDING','RETENTION_EXPIRED','ARCHIVED') NOT NULL,
	`privacyStateUpdatedAt` varchar(32),
	`policyVersion` varchar(112) NOT NULL,
	`decision` enum('NURTURE','SALES_HANDOFF','WAIT','REVIEW_REQUIRED','BLOCKED','NO_ACTION') NOT NULL,
	`reasonCodes` json NOT NULL,
	`channel` enum('email','whatsapp','sms','crm'),
	`provider` varchar(32),
	`approvalRequired` boolean NOT NULL,
	`approvalRequestId` bigint unsigned,
	`handoffId` varchar(69),
	`conversionStopped` boolean NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`validUntil` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `nurture_handoff_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `nhd_decision_id_uidx` UNIQUE(`nurtureDecisionId`),
	CONSTRAINT `nhd_user_decision_key_uidx` UNIQUE(`userId`,`decisionKey`)
);
--> statement-breakpoint
CREATE TABLE `nurture_touch_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`touchIdentity` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` varchar(69) NOT NULL,
	`nurtureDecisionId` varchar(69) NOT NULL,
	`channel` enum('email','whatsapp','sms','crm') NOT NULL,
	`provider` varchar(32) NOT NULL,
	`touchSeq` int NOT NULL,
	`outcome` enum('ACCEPTED','REJECTED','FAILURE') NOT NULL,
	`providerAck` varchar(255),
	`touchedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `nurture_touch_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `ntr_user_touch_identity_uidx` UNIQUE(`userId`,`touchIdentity`)
);
--> statement-breakpoint
CREATE TABLE `sales_handoffs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`handoffId` varchar(69) NOT NULL,
	`handoffKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` varchar(69) NOT NULL,
	`qualificationId` varchar(69) NOT NULL,
	`nurtureDecisionId` varchar(69) NOT NULL,
	`qualificationFingerprint` varchar(64) NOT NULL,
	`handoffPolicyVersion` varchar(112) NOT NULL,
	`contentSnapshotHash` varchar(64) NOT NULL,
	`handoffStatus` enum('PREPARED','APPROVAL_REQUIRED','APPROVED','DISPATCH_PENDING','DISPATCHED','ACKNOWLEDGED','FAILED','BLOCKED','CANCELLED') NOT NULL DEFAULT 'PREPARED',
	`approvalRequestId` bigint unsigned,
	`lastError` varchar(64),
	`version` int NOT NULL,
	`preparedAt` varchar(32) NOT NULL,
	`dispatchedAt` varchar(32),
	`acknowledgedAt` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sales_handoffs_id` PRIMARY KEY(`id`),
	CONSTRAINT `sh_handoff_id_uidx` UNIQUE(`handoffId`),
	CONSTRAINT `sh_user_handoff_key_uidx` UNIQUE(`userId`,`handoffKey`)
);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff') NOT NULL;--> statement-breakpoint
CREATE INDEX `ce_user_business_idx` ON `conversion_events` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `ce_user_lead_idx` ON `conversion_events` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `ce_user_occurred_idx` ON `conversion_events` (`userId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `ce_user_reverses_idx` ON `conversion_events` (`userId`,`reversesConversionId`);--> statement-breakpoint
CREATE INDEX `cle_user_conversion_idx` ON `conversion_lifecycle_events` (`userId`,`conversionId`);--> statement-breakpoint
CREATE INDEX `hdr_user_handoff_idx` ON `handoff_dispatch_receipts` (`userId`,`handoffId`);--> statement-breakpoint
CREATE INDEX `li_user_status_idx` ON `lead_identities` (`userId`,`identityStatus`);--> statement-breakpoint
CREATE INDEX `lip_lead_row_idx` ON `lead_identity_provenance` (`leadRowId`);--> statement-breakpoint
CREATE INDEX `lps_user_idx` ON `lead_privacy_states` (`userId`);--> statement-breakpoint
CREATE INDEX `lps_business_idx` ON `lead_privacy_states` (`businessId`);--> statement-breakpoint
CREATE INDEX `lps_state_idx` ON `lead_privacy_states` (`privacyState`);--> statement-breakpoint
CREATE INDEX `lqr_user_lead_idx` ON `lead_qualification_reviews` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `lqd_user_lead_idx` ON `lead_qualifications` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `lqd_user_business_idx` ON `lead_qualifications` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `lss_snapshot_id_idx` ON `lead_score_snapshots` (`evidenceSnapshotId`);--> statement-breakpoint
CREATE INDEX `lss_user_lead_idx` ON `lead_score_snapshots` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `nhd_user_lead_idx` ON `nurture_handoff_decisions` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `nhd_user_qualification_idx` ON `nurture_handoff_decisions` (`userId`,`qualificationId`);--> statement-breakpoint
CREATE INDEX `ntr_user_lead_channel_idx` ON `nurture_touch_records` (`userId`,`leadId`,`channel`);--> statement-breakpoint
CREATE INDEX `sh_user_lead_idx` ON `sales_handoffs` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `sh_user_status_idx` ON `sales_handoffs` (`userId`,`handoffStatus`);