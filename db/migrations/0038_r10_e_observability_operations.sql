-- R10-E Observability, Operations & Incident Control — PROVISIONAL 0038 migration.
--
-- Stream-local provisional migration for the observability plane
-- (operational_events / operational_incidents /
-- operational_incident_lifecycle_events / operational_alerts /
-- service_health_observations). Canonical source of truth is db/schema.ts.
--
-- ARTEFACT ONLY — NOT EXECUTED. MIGRATION_EXECUTION=False (R10 gate).
-- R10-X owns canonical R10 migration convergence/sequencing.
-- Canonical R9 0037 is preserved unchanged; no sibling R10 branch is merged.

CREATE TABLE `operational_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`eventId` varchar(70) NOT NULL,
	`schemaVersion` int NOT NULL,
	`contractVersion` varchar(48) NOT NULL,
	`eventType` varchar(48) NOT NULL,
	`environment` varchar(16) NOT NULL,
	`releaseVersion` varchar(64),
	`service` varchar(24) NOT NULL,
	`component` varchar(64) NOT NULL,
	`operation` varchar(64) NOT NULL,
	`severity` varchar(12) NOT NULL,
	`status` varchar(20) NOT NULL,
	`correlationId` varchar(64),
	`tenantId` bigint unsigned,
	`businessId` bigint unsigned,
	`missionId` varchar(69),
	`taskId` varchar(128),
	`executionAttemptId` varchar(69),
	`provider` varchar(24),
	`providerReference` varchar(128),
	`occurredAt` varchar(32) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`diagnosticCode` varchar(40) NOT NULL,
	`safeMetadata` json NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`createdAt` timestamp DEFAULT (now()) NOT NULL,
	CONSTRAINT `ope_identity_uidx` UNIQUE(`eventId`)
);
--> statement-breakpoint
CREATE INDEX `ope_tenant_idx` ON `operational_events` (`tenantId`);
--> statement-breakpoint
CREATE INDEX `ope_tenant_type_idx` ON `operational_events` (`tenantId`,`eventType`);
--> statement-breakpoint
CREATE INDEX `ope_event_type_idx` ON `operational_events` (`eventType`);
--> statement-breakpoint
CREATE INDEX `ope_occurred_at_idx` ON `operational_events` (`occurredAt`);
--> statement-breakpoint
CREATE INDEX `ope_correlation_idx` ON `operational_events` (`correlationId`);
--> statement-breakpoint

CREATE TABLE `operational_incidents` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`incidentId` varchar(69) NOT NULL,
	`environment` varchar(16) NOT NULL,
	`service` varchar(24) NOT NULL,
	`component` varchar(64) NOT NULL,
	`failureClass` varchar(40) NOT NULL,
	`scope` varchar(12) NOT NULL,
	`tenantId` bigint unsigned,
	`businessId` bigint unsigned,
	`severity` varchar(12) NOT NULL,
	`status` varchar(16) NOT NULL,
	`title` varchar(160) NOT NULL,
	`summary` varchar(512) NOT NULL,
	`safetyState` varchar(28) NOT NULL,
	`executionContinuing` boolean NOT NULL,
	`autonomousActionSuspended` boolean NOT NULL,
	`operatorAttentionRequired` boolean NOT NULL,
	`firstSeenAt` varchar(32) NOT NULL,
	`lastSeenAt` varchar(32) NOT NULL,
	`occurrenceCount` int NOT NULL,
	`evidenceEventIds` json NOT NULL,
	`correlationKey` varchar(160) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp DEFAULT (now()) NOT NULL,
	`updatedAt` timestamp DEFAULT (now()) NOT NULL,
	CONSTRAINT `opi_identity_uidx` UNIQUE(`incidentId`)
);
--> statement-breakpoint
CREATE INDEX `opi_tenant_idx` ON `operational_incidents` (`tenantId`);
--> statement-breakpoint
CREATE INDEX `opi_tenant_status_idx` ON `operational_incidents` (`tenantId`,`status`);
--> statement-breakpoint
CREATE INDEX `opi_status_idx` ON `operational_incidents` (`status`);
--> statement-breakpoint
CREATE INDEX `opi_failure_class_idx` ON `operational_incidents` (`failureClass`);
--> statement-breakpoint

CREATE TABLE `operational_incident_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`incidentId` varchar(69) NOT NULL,
	`tenantId` bigint unsigned,
	`fromStatus` varchar(16),
	`toStatus` varchar(16) NOT NULL,
	`actorType` varchar(12) NOT NULL,
	`actorUserId` int,
	`suppressionAuthority` varchar(160),
	`reason` varchar(320) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`createdAt` timestamp DEFAULT (now()) NOT NULL,
	CONSTRAINT `opil_identity_uidx` UNIQUE(`lifecycleEventId`)
);
--> statement-breakpoint
CREATE INDEX `opil_incident_idx` ON `operational_incident_lifecycle_events` (`incidentId`);
--> statement-breakpoint

CREATE TABLE `operational_alerts` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`alertId` varchar(69) NOT NULL,
	`environment` varchar(16) NOT NULL,
	`dedupKey` varchar(160) NOT NULL,
	`ruleId` varchar(48) NOT NULL,
	`severity` varchar(12) NOT NULL,
	`status` varchar(14) NOT NULL,
	`title` varchar(160) NOT NULL,
	`summary` varchar(512) NOT NULL,
	`affectedTarget` varchar(160) NOT NULL,
	`safetyState` varchar(28) NOT NULL,
	`executionContinuing` boolean NOT NULL,
	`autonomousActionSuspended` boolean NOT NULL,
	`operatorAttentionRequired` boolean NOT NULL,
	`incidentId` varchar(69),
	`firstSeenAt` varchar(32) NOT NULL,
	`lastSeenAt` varchar(32) NOT NULL,
	`occurrenceCount` int NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp DEFAULT (now()) NOT NULL,
	`updatedAt` timestamp DEFAULT (now()) NOT NULL,
	CONSTRAINT `opa_identity_uidx` UNIQUE(`alertId`),
	CONSTRAINT `opa_dedup_uidx` UNIQUE(`environment`,`dedupKey`)
);
--> statement-breakpoint
CREATE INDEX `opa_status_idx` ON `operational_alerts` (`status`);
--> statement-breakpoint
CREATE INDEX `opa_severity_idx` ON `operational_alerts` (`severity`);
--> statement-breakpoint

CREATE TABLE `service_health_observations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`observationId` varchar(70) NOT NULL,
	`environment` varchar(16) NOT NULL,
	`dimension` varchar(28) NOT NULL,
	`service` varchar(24) NOT NULL,
	`healthClass` varchar(12) NOT NULL,
	`evidenceSummary` json NOT NULL,
	`unknownInputs` json NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`observedAt` varchar(32) NOT NULL,
	`releaseVersion` varchar(64),
	`version` int NOT NULL,
	`createdAt` timestamp DEFAULT (now()) NOT NULL,
	CONSTRAINT `sho_identity_uidx` UNIQUE(`observationId`)
);
--> statement-breakpoint
CREATE INDEX `sho_dimension_idx` ON `service_health_observations` (`dimension`,`observedAt`);
--> statement-breakpoint
CREATE INDEX `sho_observed_at_idx` ON `service_health_observations` (`observedAt`);
