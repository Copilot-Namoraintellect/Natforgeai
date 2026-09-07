CREATE TABLE `image_render_claims` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`contentPostId` bigint unsigned NOT NULL,
	`activeClaimKey` varchar(191),
	`ownerToken` varchar(64) NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`leaseExpiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `image_render_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `irc_active_claim_key_idx` UNIQUE(`activeClaimKey`)
);
--> statement-breakpoint
CREATE INDEX `irc_user_post_idx` ON `image_render_claims` (`userId`,`contentPostId`);