CREATE TABLE `opportunity_candidates` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`opportunityId` varchar(69) NOT NULL,
	`opportunityKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`opportunityType` enum('purchase_interest','service_enquiry','demo_or_consultation_interest','partnership_interest','repeat_interest','retention_risk','churn_risk','referral_or_advocacy','unresolved_complaint_opportunity','support_to_sales_transition','unknown') NOT NULL,
	`opportunityStatus` enum('candidate','strengthening','weak','suppressed','expired','escalated','handed_off_to_r6') NOT NULL,
	`confidenceClass` enum('LOW','MEDIUM','HIGH','UNKNOWN') NOT NULL,
	`evidenceStrength` enum('LOW','MEDIUM','HIGH','UNKNOWN') NOT NULL,
	`urgency` enum('low','normal','high','critical') NOT NULL,
	`topic` varchar(48),
	`topicKey` varchar(64) NOT NULL,
	`actorKey` varchar(64) NOT NULL,
	`threadKey` varchar(64) NOT NULL,
	`campaignId` bigint unsigned,
	`publicationId` varchar(255),
	`provider` enum('meta','linkedin','twitter','tiktok'),
	`externalActorReference` varchar(255),
	`firstEvidence` json NOT NULL,
	`latestEvidence` json NOT NULL,
	`firstObservedAt` varchar(32) NOT NULL,
	`lastObservedAt` varchar(32) NOT NULL,
	`evidenceCount` int NOT NULL,
	`contradictionCount` int NOT NULL,
	`detectorRulesVersion` varchar(64) NOT NULL,
	`classifierVersions` json NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	`statusChangedAt` timestamp NOT NULL DEFAULT (now()),
	`handedOffAt` timestamp,
	CONSTRAINT `opportunity_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `oc_user_opportunity_uidx` UNIQUE(`userId`,`opportunityKey`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_evidence` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`candidateId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`interpretationId` varchar(64) NOT NULL,
	`signalId` varchar(128) NOT NULL,
	`signalVersion` int NOT NULL,
	`kind` enum('signal_interpretation','engagement_receipt') NOT NULL,
	`engagementReceiptId` varchar(128),
	`opportunityTypeAtEvaluation` enum('purchase_interest','service_enquiry','demo_or_consultation_interest','partnership_interest','repeat_interest','retention_risk','churn_risk','referral_or_advocacy','unresolved_complaint_opportunity','support_to_sales_transition','unknown') NOT NULL,
	`intent` varchar(32) NOT NULL,
	`overallConfidence` varchar(16) NOT NULL,
	`relevance` varchar(32) NOT NULL,
	`sentiment` varchar(16) NOT NULL,
	`urgency` enum('low','normal','high','critical') NOT NULL,
	`sourceCampaignId` bigint unsigned,
	`occurredAt` varchar(32) NOT NULL,
	`contributesToStrength` boolean NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `oe_interpretation_kind_uidx` UNIQUE(`interpretationId`,`kind`),
	CONSTRAINT `oe_receipt_uidx` UNIQUE(`engagementReceiptId`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_handoffs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`handoffId` varchar(69) NOT NULL,
	`opportunityId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`envelope` json NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`handedOffAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_handoffs_id` PRIMARY KEY(`id`),
	CONSTRAINT `oh_user_opportunity_uidx` UNIQUE(`userId`,`opportunityId`),
	CONSTRAINT `oh_handoff_id_idx` UNIQUE(`handoffId`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_suppressions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`interpretationId` varchar(64) NOT NULL,
	`signalId` varchar(128) NOT NULL,
	`reason` enum('SAFETY_ESCALATION','RISK_GATED','POLICY_SUPPRESSED','NOT_OPPORTUNITY_SIGNAL','INSUFFICIENT_CLASSIFICATION','NO_OPPORTUNITY_CLASSIFICATION','LOW_RELEVANCE','FLOOD_GUARDED') NOT NULL,
	`detail` varchar(255),
	`actorKey` varchar(64),
	`threadKey` varchar(64),
	`intent` varchar(32) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_suppressions_id` PRIMARY KEY(`id`),
	CONSTRAINT `os_interpretation_uidx` UNIQUE(`interpretationId`)
);
--> statement-breakpoint
CREATE INDEX `oc_user_status_idx` ON `opportunity_candidates` (`userId`,`opportunityStatus`);--> statement-breakpoint
CREATE INDEX `oc_user_actor_idx` ON `opportunity_candidates` (`userId`,`actorKey`);--> statement-breakpoint
CREATE INDEX `oc_user_thread_idx` ON `opportunity_candidates` (`userId`,`threadKey`);--> statement-breakpoint
CREATE INDEX `oe_candidate_idx` ON `opportunity_evidence` (`candidateId`);--> statement-breakpoint
CREATE INDEX `os_user_thread_idx` ON `opportunity_suppressions` (`userId`,`threadKey`);--> statement-breakpoint
CREATE INDEX `os_user_reason_idx` ON `opportunity_suppressions` (`userId`,`reason`);