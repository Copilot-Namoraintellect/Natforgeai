CREATE TABLE `queue_terminal_failures` (
        `id` serial AUTO_INCREMENT NOT NULL,
        `failureKey` varchar(255) NOT NULL,
        `queueName` enum('publishing','content_generation') NOT NULL,
        `bullmqJobId` varchar(191) NOT NULL,
        `terminalReason` enum('unrecoverable','retries_exhausted') NOT NULL,
        `attemptsMade` int NOT NULL,
        `attemptsConfigured` int NOT NULL,
        `userId` bigint unsigned NOT NULL,
        `campaignId` bigint unsigned,
        `publishingQueueItemId` bigint unsigned,
        `agentRunId` bigint unsigned,
        `errorName` varchar(128),
        `errorCode` varchar(64),
        `errorSummary` text,
        `failedAt` timestamp NOT NULL,
        `status` enum('open') NOT NULL DEFAULT 'open',
        `createdAt` timestamp NOT NULL DEFAULT (now()),
        `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT `queue_terminal_failures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qtf_failure_key_idx`
        ON `queue_terminal_failures` (`failureKey`);
--> statement-breakpoint
CREATE INDEX `qtf_queue_job_idx`
        ON `queue_terminal_failures` (`queueName`,`bullmqJobId`);
--> statement-breakpoint
CREATE INDEX `qtf_user_id_idx`
        ON `queue_terminal_failures` (`userId`);
--> statement-breakpoint
CREATE INDEX `qtf_campaign_id_idx`
        ON `queue_terminal_failures` (`campaignId`);
--> statement-breakpoint
CREATE INDEX `qtf_status_idx`
        ON `queue_terminal_failures` (`status`);
--> statement-breakpoint
CREATE INDEX `qtf_failed_at_idx`
        ON `queue_terminal_failures` (`failedAt`);
--> statement-breakpoint

CREATE TABLE `queue_replay_requests` (
        `id` serial AUTO_INCREMENT NOT NULL,
        `replayKey` varchar(255) NOT NULL,
        `terminalFailureId` bigint unsigned NOT NULL,
        `failureKey` varchar(255) NOT NULL,
        `queueName` enum('publishing','content_generation') NOT NULL,
        `originalBullmqJobId` varchar(191) NOT NULL,
        `requestedByUserId` bigint unsigned NOT NULL,
        `reason` text,
        `status` enum('requested','claimed','enqueued','resolved','failed') NOT NULL DEFAULT 'requested',
        `replayMode` enum('publishing_requeue','content_domain_recovery') NOT NULL,
        `replayBullmqJobId` varchar(191),
        `contentRecoveryClaimId` bigint unsigned,
        `contentRecoveryOwnerTokenHash` varchar(64),
        `contentRecoveryPreparedAt` timestamp,
        `claimedAt` timestamp,
        `enqueuedAt` timestamp,
        `resolvedAt` timestamp,
        `failedAt` timestamp,
        `lastErrorSummary` text,
        `createdAt` timestamp NOT NULL DEFAULT (now()),
        `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT `queue_replay_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qrr_replay_key_idx`
        ON `queue_replay_requests` (`replayKey`);
--> statement-breakpoint
CREATE INDEX `qrr_terminal_failure_idx`
        ON `queue_replay_requests` (`terminalFailureId`);
--> statement-breakpoint
CREATE INDEX `qrr_failure_key_idx`
        ON `queue_replay_requests` (`failureKey`);
--> statement-breakpoint
CREATE INDEX `qrr_queue_name_idx`
        ON `queue_replay_requests` (`queueName`);
--> statement-breakpoint
CREATE INDEX `qrr_status_idx`
        ON `queue_replay_requests` (`status`);
--> statement-breakpoint
CREATE INDEX `qrr_requested_by_idx`
        ON `queue_replay_requests` (`requestedByUserId`);
--> statement-breakpoint

CREATE TABLE `queue_replay_active_claims` (
        `terminalFailureId` bigint unsigned NOT NULL,
        `replayRequestId` bigint unsigned NOT NULL,
        `createdAt` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT `queue_replay_active_claims_terminalFailureId`
                PRIMARY KEY(`terminalFailureId`)
);
