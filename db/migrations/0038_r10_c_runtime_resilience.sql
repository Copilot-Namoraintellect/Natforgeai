-- R10-X canonical package. Generated offline; NOT EXECUTED. No activation data.
CREATE TABLE `runtime_workers` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`workerInstanceId` varchar(69) NOT NULL,
	`workerId` varchar(64) NOT NULL,
	`service` varchar(64) NOT NULL,
	`capabilities` json NOT NULL,
	`runtimeVersion` varchar(64) NOT NULL,
	`releaseVersion` varchar(64) NOT NULL,
	`runtimeState` varchar(16) NOT NULL,
	`startedAt` varchar(32) NOT NULL,
	`heartbeatAt` varchar(32) NOT NULL,
	`stoppedAt` varchar(32),
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_workers_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtw_instance_uidx` UNIQUE(`workerInstanceId`)
);

--> statement-breakpoint
CREATE TABLE `runtime_jobs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`jobId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`jobType` varchar(32) NOT NULL,
	`authorityRef` varchar(69) NOT NULL,
	`missionId` varchar(69),
	`planId` varchar(128),
	`scheduleId` varchar(69),
	`taskId` varchar(128),
	`attemptRef` varchar(69),
	`parametersFingerprint` varchar(64) NOT NULL,
	`jobFingerprint` varchar(64) NOT NULL,
	`runtimeVersion` varchar(64) NOT NULL,
	`releaseVersion` varchar(64) NOT NULL,
	`notBefore` varchar(32) NOT NULL,
	`state` varchar(16) NOT NULL,
	`leaseId` varchar(69),
	`leaseOwnerInstanceId` varchar(69),
	`leaseEpoch` int,
	`leaseExpiresAt` varchar(32),
	`resultStatus` varchar(20),
	`failureClass` varchar(24) NOT NULL,
	`uncertaintyClass` varchar(28) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtj_job_uidx` UNIQUE(`jobId`),
	CONSTRAINT `rtj_user_job_uidx` UNIQUE(`userId`,`jobId`)
);

--> statement-breakpoint
CREATE TABLE `runtime_leases` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leaseId` varchar(69) NOT NULL,
	`jobId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`workerInstanceId` varchar(69) NOT NULL,
	`authorityRef` varchar(69) NOT NULL,
	`attemptRef` varchar(69),
	`leaseState` varchar(12) NOT NULL,
	`leaseEpoch` int NOT NULL,
	`acquiredAt` varchar(32) NOT NULL,
	`heartbeatAt` varchar(32) NOT NULL,
	`leaseExpiresAt` varchar(32) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_leases_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtl_lease_uidx` UNIQUE(`leaseId`)
);

--> statement-breakpoint
CREATE TABLE `runtime_dead_letters` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`deadLetterId` varchar(69) NOT NULL,
	`jobId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`jobType` varchar(32) NOT NULL,
	`authorityRef` varchar(69) NOT NULL,
	`attemptRef` varchar(69),
	`reason` varchar(32) NOT NULL,
	`failureClass` varchar(24) NOT NULL,
	`uncertaintyClass` varchar(28) NOT NULL,
	`diagnostic` json NOT NULL,
	`deadLetterFingerprint` varchar(64) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_dead_letters_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtdl_identity_uidx` UNIQUE(`deadLetterId`)
);

--> statement-breakpoint
CREATE TABLE `runtime_lifecycle_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`lifecycleEventId` varchar(70) NOT NULL,
	`userId` bigint unsigned,
	`jobId` varchar(69),
	`workerInstanceId` varchar(69),
	`leaseId` varchar(69),
	`lifecycleType` varchar(28) NOT NULL,
	`fromState` varchar(20),
	`toState` varchar(20) NOT NULL,
	`reasonCode` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runtime_lifecycle_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtlf_identity_uidx` UNIQUE(`lifecycleEventId`)
);

--> statement-breakpoint
CREATE INDEX `rtw_worker_role_idx` ON `runtime_workers` (`workerId`);
--> statement-breakpoint
CREATE INDEX `rtw_worker_state_idx` ON `runtime_workers` (`runtimeState`);
--> statement-breakpoint
CREATE INDEX `rtj_user_state_idx` ON `runtime_jobs` (`userId`,`state`);
--> statement-breakpoint
CREATE INDEX `rtj_user_authority_idx` ON `runtime_jobs` (`userId`,`authorityRef`);
--> statement-breakpoint
CREATE INDEX `rtl_job_idx` ON `runtime_leases` (`jobId`);
--> statement-breakpoint
CREATE INDEX `rtl_worker_idx` ON `runtime_leases` (`workerInstanceId`);
--> statement-breakpoint
CREATE INDEX `rtdl_user_job_idx` ON `runtime_dead_letters` (`userId`,`jobId`);
--> statement-breakpoint
CREATE INDEX `rtlf_job_idx` ON `runtime_lifecycle_events` (`jobId`);
--> statement-breakpoint
CREATE INDEX `rtlf_worker_idx` ON `runtime_lifecycle_events` (`workerInstanceId`);
