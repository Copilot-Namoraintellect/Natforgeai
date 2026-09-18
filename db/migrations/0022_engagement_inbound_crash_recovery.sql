-- 4F-C1A: Engagement inbound crash-recovery hardening.
-- Additive only: new nullable columns + one unique index + enum widening.
-- Existing rows keep their current status values (legacy 'accepted' rows
-- remain terminal-success and are never reprocessed).

ALTER TABLE `conversation_messages`
	ADD COLUMN `dedupKey` varchar(255),
	ADD UNIQUE INDEX `conversation_messages_thread_dedup_idx`(`threadId`,`dedupKey`);

ALTER TABLE `engagement_webhook_events`
	MODIFY COLUMN `status` enum('accepted','duplicate','rejected','escalated','error','received','processing','completed','failed') NOT NULL DEFAULT 'received',
	ADD COLUMN `claimedAt` timestamp NULL,
	ADD COLUMN `claimExpiresAt` timestamp NULL,
	ADD COLUMN `completedAt` timestamp NULL,
	ADD COLUMN `retryCount` int NOT NULL DEFAULT 0;
