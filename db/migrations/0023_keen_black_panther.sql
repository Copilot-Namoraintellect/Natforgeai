CREATE TABLE `learning_records` (
        `id` serial AUTO_INCREMENT NOT NULL,
        `userId` bigint unsigned NOT NULL,
        `campaignId` bigint unsigned NOT NULL,
        `evaluationVersion` varchar(64) NOT NULL,
        `windowStart` date NOT NULL,
        `windowEnd` date NOT NULL,
        `idempotencyKey` varchar(255) NOT NULL,
        `objectiveSummary` text NOT NULL,
        `kpiAssessment` json NOT NULL,
        `performanceFacts` json NOT NULL,
        `positivePatterns` json NOT NULL,
        `negativePatterns` json NOT NULL,
        `confidence` enum('low','medium','high') NOT NULL,
        `evidence` json NOT NULL,
        `recommendedAdjustments` json NOT NULL,
        `governance` json NOT NULL,
        `sourceObservations` json NOT NULL,
        `provenance` json NOT NULL,
        `status` enum('recorded') NOT NULL DEFAULT 'recorded',
        `evaluatedAt` timestamp NOT NULL DEFAULT (now()),
        `createdAt` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT `learning_records_id` PRIMARY KEY(`id`),
        CONSTRAINT `lr_idempotency_key_idx` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `lr_campaign_idx` ON `learning_records` (`campaignId`);
--> statement-breakpoint
CREATE INDEX `lr_user_campaign_idx` ON `learning_records` (`userId`,`campaignId`);
