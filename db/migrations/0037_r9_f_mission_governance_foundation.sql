CREATE TABLE `mission_governance_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`contractVersion` varchar(48) NOT NULL,
	`engineVersion` varchar(48) NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`missionRef` varchar(128) NOT NULL,
	`planRef` varchar(128),
	`taskRef` varchar(128),
	`subjectClass` varchar(24) NOT NULL,
	`actionType` varchar(32) NOT NULL,
	`actionParamsFingerprint` varchar(64) NOT NULL,
	`missionRiskClass` varchar(16) NOT NULL,
	`riskFactors` json NOT NULL,
	`policyVersion` varchar(96),
	`decision` varchar(24) NOT NULL,
	`reasonCodes` json NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`approvalBinding` json,
	`evaluationFingerprint` varchar(64) NOT NULL,
	`validUntil` varchar(32),
	`evaluatedAt` varchar(32) NOT NULL,
	`thresholds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mission_governance_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mgd_decision_id_uidx` UNIQUE(`governanceDecisionId`),
	CONSTRAINT `mgd_user_decision_uidx` UNIQUE(`userId`,`governanceDecisionId`)
);
--> statement-breakpoint
CREATE INDEX `mgd_business_idx` ON `mission_governance_decisions` (`businessId`);
--> statement-breakpoint
CREATE INDEX `mgd_user_idx` ON `mission_governance_decisions` (`userId`);
--> statement-breakpoint
CREATE INDEX `mgd_mission_idx` ON `mission_governance_decisions` (`missionRef`);
--> statement-breakpoint
CREATE INDEX `mgd_decision_idx` ON `mission_governance_decisions` (`decision`);
--> statement-breakpoint
CREATE INDEX `mgd_evaluated_idx` ON `mission_governance_decisions` (`evaluatedAt`);
--> statement-breakpoint
ALTER TABLE `approval_requests` MODIFY COLUMN `approvalType` enum('campaign_launch','budget_increase','sensitive_reply','high_value_proposal','ad_spend','shutdown','brand_risk','strategy_review','marketing_action','sales_handoff','optimisation_action','strategic_recommendation','mission_action') NOT NULL;
