CREATE TABLE `social_listening_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`integrationId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`provider` varchar(32) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`providerAccountId` varchar(255) NOT NULL,
	`mechanism` enum('webhook','polling','unsupported') NOT NULL,
	`status` enum('active','blocked','unsupported','stale') NOT NULL DEFAULT 'active',
	`cursor` varchar(255),
	`cursorUpdatedAt` timestamp,
	`lastSuccessAt` timestamp,
	`lastFailureAt` timestamp,
	`lastFailureClass` enum('AUTO_RECOVER','OPERATOR_ACTION','FAIL_CLOSED'),
	`lastFailureCode` varchar(64),
	`lastFailureReason` varchar(255),
	`acceptedCount` int NOT NULL DEFAULT 0,
	`duplicateCount` int NOT NULL DEFAULT 0,
	`rejectedCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_listening_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `sls_integration_uidx` UNIQUE(`integrationId`)
);
--> statement-breakpoint
CREATE TABLE `social_signals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`signalKey` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`provider` varchar(32) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`integrationId` bigint unsigned NOT NULL,
	`providerAccountId` varchar(255) NOT NULL,
	`externalEventId` varchar(255) NOT NULL,
	`externalObjectId` varchar(255),
	`parentExternalObjectId` varchar(255),
	`signalType` enum('comment','reply','mention','reaction','direct_message','repost','follow','unfollow','campaign_response','inbound_message','unknown') NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`observedAt` timestamp NOT NULL,
	`sourceCampaignId` bigint unsigned,
	`sourcePublicationId` varchar(255),
	`sourcePublicationReceiptId` varchar(128),
	`actorReference` varchar(255),
	`actorDisplayName` varchar(255),
	`contentReference` varchar(255),
	`contentText` text,
	`providerEvidenceHash` varchar(64) NOT NULL,
	`attributionType` enum('direct','business','unattributed') NOT NULL DEFAULT 'unattributed',
	`status` enum('accepted') NOT NULL DEFAULT 'accepted',
	`ingestionVersion` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_signals_id` PRIMARY KEY(`id`),
	CONSTRAINT `ss_natural_key_uidx` UNIQUE(`provider`,`providerAccountId`,`externalEventId`),
	CONSTRAINT `ss_signal_key_uidx` UNIQUE(`signalKey`)
);
--> statement-breakpoint
CREATE INDEX `sls_user_idx` ON `social_listening_states` (`userId`);--> statement-breakpoint
CREATE INDEX `ss_user_observed_idx` ON `social_signals` (`userId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `ss_integration_occurred_idx` ON `social_signals` (`integrationId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `ss_campaign_idx` ON `social_signals` (`sourceCampaignId`);