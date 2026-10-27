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
CREATE INDEX `lqr_user_lead_idx` ON `lead_qualification_reviews` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `lqd_user_lead_idx` ON `lead_qualifications` (`userId`,`leadId`);--> statement-breakpoint
CREATE INDEX `lqd_user_business_idx` ON `lead_qualifications` (`userId`,`businessId`);