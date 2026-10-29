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
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action','strategic_recommendation') NOT NULL;--> statement-breakpoint
CREATE INDEX `sgd_business_idx` ON `strategic_governance_decisions` (`businessId`);--> statement-breakpoint
CREATE INDEX `sgd_user_idx` ON `strategic_governance_decisions` (`userId`);--> statement-breakpoint
CREATE INDEX `sgd_proposal_idx` ON `strategic_governance_decisions` (`proposalId`);--> statement-breakpoint
CREATE INDEX `sgd_decision_idx` ON `strategic_governance_decisions` (`decision`);--> statement-breakpoint
CREATE INDEX `sgd_evaluated_idx` ON `strategic_governance_decisions` (`evaluatedAt`);