CREATE TABLE `engagement_webhook_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`provider` varchar(50) NOT NULL,
	`externalEventId` varchar(255) NOT NULL,
	`eventType` varchar(50) NOT NULL,
	`status` enum('accepted','duplicate','rejected','escalated','error') NOT NULL DEFAULT 'accepted',
	`userId` bigint unsigned,
	`integrationId` bigint unsigned,
	`campaignId` bigint unsigned,
	`threadId` bigint unsigned,
	`actorId` varchar(255),
	`payloadSummary` json,
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp,
	CONSTRAINT `engagement_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `engagement_webhook_events_provider_event_idx` UNIQUE(`provider`,`externalEventId`)
);
