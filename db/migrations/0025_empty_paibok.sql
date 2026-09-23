CREATE TABLE `strategy_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`snapshotId` varchar(128) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`strategyRunId` bigint unsigned NOT NULL,
	`businessDnaSnapshotId` varchar(128) NOT NULL,
	`version` int NOT NULL,
	`creativeBriefFingerprint` varchar(128) NOT NULL,
	`strategyHashSha256` varchar(64) NOT NULL,
	`snapshot` json NOT NULL,
	`capturedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategy_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `strategy_snapshots_snapshotId_unique` UNIQUE(`snapshotId`),
	CONSTRAINT `strategy_snapshots_strategyRunId_unique` UNIQUE(`strategyRunId`),
	CONSTRAINT `strategy_snapshot_campaign_version_uidx` UNIQUE(`campaignId`,`version`)
);
--> statement-breakpoint
CREATE INDEX `strategy_snapshot_campaign_id_idx` ON `strategy_snapshots` (`campaignId`);
--> statement-breakpoint
CREATE INDEX `strategy_snapshot_business_id_idx` ON `strategy_snapshots` (`businessId`);
--> statement-breakpoint
CREATE INDEX `strategy_snapshot_bdna_snapshot_id_idx` ON `strategy_snapshots` (`businessDnaSnapshotId`);
--> statement-breakpoint
CREATE INDEX `strategy_snapshot_hash_idx` ON `strategy_snapshots` (`strategyHashSha256`);
