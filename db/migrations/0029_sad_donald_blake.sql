CREATE TABLE `business_policies` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`policyId` varchar(32) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`version` int NOT NULL,
	`policyVersion` varchar(64) NOT NULL,
	`configHash` varchar(64) NOT NULL,
	`config` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `bp_policy_version_idx` UNIQUE(`policyId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `policy_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`policyDecisionId` varchar(48) NOT NULL,
	`policyId` varchar(32),
	`policyVersion` varchar(64),
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`actionRequestId` varchar(128) NOT NULL,
	`decisionScopeKey` varchar(200) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`campaignId` bigint unsigned,
	`sourceSignalId` varchar(128),
	`sourceInterpretationId` varchar(128),
	`intelligenceVersion` varchar(128),
	`decision` varchar(24) NOT NULL,
	`reasonCodes` json NOT NULL,
	`riskClass` varchar(16) NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`costEligible` boolean NOT NULL DEFAULT false,
	`rateEligible` boolean NOT NULL DEFAULT false,
	`providerEligible` boolean NOT NULL DEFAULT false,
	`estimatedCostClass` varchar(16) NOT NULL,
	`estimatedCredits` int NOT NULL DEFAULT 0,
	`billingIdentity` varchar(48),
	`approvalBinding` json,
	`thresholds` json NOT NULL,
	`expiresAt` timestamp,
	`evaluatedAt` varchar(32) NOT NULL,
	`evaluationFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `policy_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pd_decision_id_idx` UNIQUE(`policyDecisionId`),
	CONSTRAINT `pd_scope_idx` UNIQUE(`decisionScopeKey`)
);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action') NOT NULL;--> statement-breakpoint
CREATE INDEX `bp_business_idx` ON `business_policies` (`businessId`);--> statement-breakpoint
CREATE INDEX `bp_active_idx` ON `business_policies` (`policyId`,`isActive`);--> statement-breakpoint
CREATE INDEX `pd_business_idx` ON `policy_decisions` (`businessId`);--> statement-breakpoint
CREATE INDEX `pd_user_idx` ON `policy_decisions` (`userId`);--> statement-breakpoint
CREATE INDEX `pd_campaign_idx` ON `policy_decisions` (`campaignId`);--> statement-breakpoint
CREATE INDEX `pd_decision_idx` ON `policy_decisions` (`decision`);--> statement-breakpoint
CREATE INDEX `pd_evaluated_idx` ON `policy_decisions` (`evaluatedAt`);