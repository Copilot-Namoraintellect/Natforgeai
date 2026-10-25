CREATE TABLE `lead_score_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadScoreId` varchar(69) NOT NULL,
	`evidenceSnapshotId` varchar(69) NOT NULL,
	`scoreContractVersion` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`leadId` bigint unsigned NOT NULL,
	`leadIdentityVersion` varchar(96) NOT NULL,
	`scoringVersion` varchar(64) NOT NULL,
	`featureVersion` varchar(64) NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`evidenceManifest` json NOT NULL,
	`overallScore` int NOT NULL,
	`scoreBand` enum('VERY_LOW','LOW','MEDIUM','HIGH','VERY_HIGH') NOT NULL,
	`scoreConfidence` enum('LOW','MEDIUM','HIGH','UNKNOWN') NOT NULL,
	`fitScore` int NOT NULL,
	`intentScore` int NOT NULL,
	`engagementScore` int NOT NULL,
	`recencyScore` int NOT NULL,
	`opportunityScore` int NOT NULL,
	`componentWeights` json NOT NULL,
	`reasonCodes` json NOT NULL,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_score_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `lss_convergence_uidx` UNIQUE(`userId`,`leadId`,`evidenceSnapshotHash`,`scoringVersion`),
	CONSTRAINT `lss_score_id_uidx` UNIQUE(`leadScoreId`)
);
--> statement-breakpoint
CREATE INDEX `lss_snapshot_id_idx` ON `lead_score_snapshots` (`evidenceSnapshotId`);--> statement-breakpoint
CREATE INDEX `lss_user_lead_idx` ON `lead_score_snapshots` (`userId`,`leadId`);