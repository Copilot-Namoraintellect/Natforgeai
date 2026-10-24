CREATE TABLE `engagement_executions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`executionId` varchar(64) NOT NULL,
	`actionRequestId` varchar(128) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`signalId` varchar(128) NOT NULL,
	`signalVersion` int NOT NULL,
	`interpretationId` varchar(128) NOT NULL,
	`policyDecisionId` varchar(48) NOT NULL,
	`approvalRequestId` int,
	`responseContentId` varchar(64) NOT NULL,
	`responseContentVersion` int NOT NULL,
	`provider` varchar(16) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`integrationId` bigint unsigned,
	`externalTarget` varchar(255) NOT NULL,
	`status` varchar(24) NOT NULL,
	`attempt` int NOT NULL DEFAULT 0,
	`maxRetries` int NOT NULL DEFAULT 3,
	`providerOperationIdentity` varchar(64),
	`claimedAt` timestamp,
	`claimExpiresAt` timestamp,
	`nextRetryAt` timestamp,
	`reconciliationState` varchar(24) NOT NULL,
	`failureClass` varchar(24),
	`billingReservationId` varchar(64),
	`lastError` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `engagement_executions_id` PRIMARY KEY(`id`),
	CONSTRAINT `ee_action_request_idx` UNIQUE(`actionRequestId`),
	CONSTRAINT `ee_operation_identity_idx` UNIQUE(`providerOperationIdentity`)
);
--> statement-breakpoint
CREATE TABLE `engagement_receipts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`engagementReceiptId` varchar(64) NOT NULL,
	`executionId` varchar(64) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`signalId` varchar(128) NOT NULL,
	`interpretationId` varchar(128) NOT NULL,
	`actionRequestId` varchar(128) NOT NULL,
	`policyDecisionId` varchar(48) NOT NULL,
	`approvalRequestId` int,
	`responseContentId` varchar(64) NOT NULL,
	`responseContentVersion` int NOT NULL,
	`provider` varchar(16) NOT NULL,
	`integrationId` bigint unsigned,
	`providerAccountRef` varchar(255),
	`externalTarget` varchar(255) NOT NULL,
	`providerOperationIdentity` varchar(64) NOT NULL,
	`providerExternalReceipt` varchar(512),
	`executedAt` varchar(32) NOT NULL,
	`status` varchar(24) NOT NULL,
	`reconciliationState` varchar(24) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `engagement_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `er_receipt_id_idx` UNIQUE(`engagementReceiptId`),
	CONSTRAINT `er_execution_idx` UNIQUE(`executionId`),
	CONSTRAINT `er_operation_identity_idx` UNIQUE(`providerOperationIdentity`)
);
--> statement-breakpoint
CREATE TABLE `engagement_response_contents` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`responseContentId` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`actionRequestId` varchar(128) NOT NULL,
	`interpretationId` varchar(128) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`content` text NOT NULL,
	`status` varchar(24) NOT NULL,
	`model` varchar(64),
	`promptTokens` int,
	`completionTokens` int,
	`billingIdentity` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `engagement_response_contents_id` PRIMARY KEY(`id`),
	CONSTRAINT `erc_content_version_idx` UNIQUE(`responseContentId`,`version`)
);
--> statement-breakpoint
CREATE INDEX `ee_business_idx` ON `engagement_executions` (`businessId`);--> statement-breakpoint
CREATE INDEX `ee_status_idx` ON `engagement_executions` (`status`);--> statement-breakpoint
CREATE INDEX `ee_reconciliation_idx` ON `engagement_executions` (`reconciliationState`);--> statement-breakpoint
CREATE INDEX `er_business_idx` ON `engagement_receipts` (`businessId`);--> statement-breakpoint
CREATE INDEX `er_signal_idx` ON `engagement_receipts` (`signalId`);--> statement-breakpoint
CREATE INDEX `erc_business_idx` ON `engagement_response_contents` (`businessId`);--> statement-breakpoint
CREATE INDEX `erc_action_request_idx` ON `engagement_response_contents` (`actionRequestId`);