-- R6-F Lead Privacy Governance (stream-owned artefact — created, NOT executed).
-- Durable home for per-lead suppression / restriction / retention operational
-- state. Governance-mutated only; transitions CAS-guarded + audit-ledgered.
-- References and closed-vocabulary labels only — no PII columns.
-- See docs/recovery/r6-f-unexecuted-migrations.md before executing.
CREATE TABLE `lead_privacy_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadId` bigint unsigned NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`privacyState` enum('ACTIVE','SUPPRESSED','RESTRICTED','RETENTION_PENDING','RETENTION_EXPIRED','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`previousState` enum('ACTIVE','SUPPRESSED','RESTRICTED','RETENTION_PENDING','RETENTION_EXPIRED','ARCHIVED'),
	`reason` varchar(500),
	`retentionDeadlineAt` timestamp,
	`source` varchar(32) NOT NULL DEFAULT 'operator',
	`actorUserId` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_privacy_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `lps_lead_uidx` UNIQUE(`leadId`)
);
--> statement-breakpoint
CREATE INDEX `lps_user_idx` ON `lead_privacy_states` (`userId`);--> statement-breakpoint
CREATE INDEX `lps_business_idx` ON `lead_privacy_states` (`businessId`);--> statement-breakpoint
CREATE INDEX `lps_state_idx` ON `lead_privacy_states` (`privacyState`);
