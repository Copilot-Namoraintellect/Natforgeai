CREATE TABLE `creative_generation_claims` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`campaignId` bigint unsigned NOT NULL,
	`operationSource` varchar(32) NOT NULL,
	`operationReferenceId` bigint unsigned,
	`activeClaimKey` varchar(255),
	`ownerToken` varchar(64) NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`heartbeatAt` timestamp,
	`leaseExpiresAt` timestamp,
	`releasedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `creative_generation_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `cgc_active_claim_key_idx` UNIQUE(`activeClaimKey`),
	CONSTRAINT `cgc_op_source_reference_idx` UNIQUE(`operationSource`,`operationReferenceId`)
);
--> statement-breakpoint
CREATE INDEX `cgc_user_campaign_idx` ON `creative_generation_claims` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `cgc_status_lease_idx` ON `creative_generation_claims` (`status`,`leaseExpiresAt`);