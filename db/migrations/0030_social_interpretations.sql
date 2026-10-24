CREATE TABLE `social_interpretations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`signalId` varchar(128) NOT NULL,
	`signalVersion` int NOT NULL,
	`signalContentHash` varchar(64) NOT NULL,
	`classifierVersion` varchar(64) NOT NULL,
	`interpretationId` varchar(64) NOT NULL,
	`modelOrRuleSource` enum('RULE','MODEL') NOT NULL,
	`intent` varchar(48) NOT NULL,
	`sentiment` varchar(24) NOT NULL,
	`urgency` varchar(16) NOT NULL,
	`relevance` varchar(24) NOT NULL,
	`overallConfidence` varchar(16) NOT NULL,
	`recommendedHandling` varchar(48) NOT NULL,
	`billingIdentity` varchar(80),
	`record` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_interpretations_id` PRIMARY KEY(`id`),
	CONSTRAINT `social_interpretation_identity_uidx` UNIQUE(`interpretationId`),
	CONSTRAINT `social_interpretation_signal_classifier_uidx` UNIQUE(`businessId`,`signalId`,`signalVersion`,`classifierVersion`)
);
--> statement-breakpoint
ALTER TABLE `agent_runs` MODIFY COLUMN `agentType` enum('strategy','creative','audience','distribution','engagement','sales','optimisation','interpretation') NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage` MODIFY COLUMN `agentType` enum('strategy','creative','audience','distribution','engagement','sales','optimisation','interpretation','safety_check','image_generation','video_generation') NOT NULL;--> statement-breakpoint
CREATE INDEX `social_interpretation_user_idx` ON `social_interpretations` (`userId`);--> statement-breakpoint
CREATE INDEX `social_interpretation_signal_idx` ON `social_interpretations` (`signalId`);