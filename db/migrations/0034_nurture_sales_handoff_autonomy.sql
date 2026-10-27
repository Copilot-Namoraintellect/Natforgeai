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
CREATE INDEX `hdr_user_handoff_idx` ON `handoff_dispatch_receipts` (`userId`,`handoffId`);--> statement-breakpoint
CREATE INDEX `nhd_user_lead_idx` ON `nurture_handoff_decisions` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `nhd_user_qualification_idx` ON `nurture_handoff_decisions` (`userId`,`qualificationId`);--> statement-breakpoint
CREATE INDEX `ntr_user_lead_channel_idx` ON `nurture_touch_records` (`userId`,`leadId`,`channel`);--> statement-breakpoint
CREATE INDEX `sh_user_lead_idx` ON `sales_handoffs` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `sh_user_status_idx` ON `sales_handoffs` (`userId`,`handoffStatus`);