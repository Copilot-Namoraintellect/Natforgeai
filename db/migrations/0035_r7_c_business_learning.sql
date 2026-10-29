CREATE TABLE `business_learning_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`learningLifecycleEventId` varchar(70) NOT NULL,
	`learningId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`lifecycleType` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL,
	`reasonCode` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_learning_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bll_event_id_uidx` UNIQUE(`learningLifecycleEventId`)
);
--> statement-breakpoint
CREATE TABLE `business_learning_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`learningId` varchar(69) NOT NULL,
	`evidenceBundleId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`learningType` varchar(32) NOT NULL,
	`subjectType` varchar(24) NOT NULL,
	`subjectId` varchar(191) NOT NULL,
	`outcomeTypeFamily` varchar(64) NOT NULL,
	`contextScope` json NOT NULL,
	`statement` json NOT NULL,
	`outcomeIds` json NOT NULL,
	`attributionIds` json NOT NULL,
	`upstreamStateFingerprint` varchar(64) NOT NULL,
	`supportCount` int NOT NULL,
	`contradictionCount` int NOT NULL,
	`confidenceClass` varchar(24) NOT NULL,
	`evidenceClass` varchar(24) NOT NULL,
	`noveltyClass` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'CANDIDATE',
	`limitations` json NOT NULL,
	`sourceVersions` json NOT NULL,
	`narrativeDraft` text,
	`validUntil` varchar(32),
	`supersedesLearningId` varchar(69),
	`recordHash` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`derivedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_learning_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `blr_learning_id_uidx` UNIQUE(`learningId`),
	CONSTRAINT `blr_natural_key_uidx` UNIQUE(`userId`,`evidenceBundleId`,`learningType`,`subjectType`,`subjectId`,`upstreamStateFingerprint`)
);
--> statement-breakpoint
CREATE INDEX `bll_user_learning_idx` ON `business_learning_lifecycle_events` (`userId`,`learningId`);--> statement-breakpoint
CREATE INDEX `blr_user_business_idx` ON `business_learning_records` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `blr_user_subject_idx` ON `business_learning_records` (`userId`,`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `blr_user_status_idx` ON `business_learning_records` (`userId`,`status`);