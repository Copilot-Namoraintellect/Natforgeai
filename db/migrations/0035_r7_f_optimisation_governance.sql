ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action') NOT NULL;
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
CREATE INDEX `ogd_business_idx` ON `optimisation_governance_decisions` (`businessId`);
--> statement-breakpoint
CREATE INDEX `ogd_user_idx` ON `optimisation_governance_decisions` (`userId`);
--> statement-breakpoint
CREATE INDEX `ogd_proposal_idx` ON `optimisation_governance_decisions` (`proposalId`);
--> statement-breakpoint
CREATE INDEX `ogd_decision_idx` ON `optimisation_governance_decisions` (`decision`);
--> statement-breakpoint
CREATE INDEX `ogd_evaluated_idx` ON `optimisation_governance_decisions` (`evaluatedAt`);
