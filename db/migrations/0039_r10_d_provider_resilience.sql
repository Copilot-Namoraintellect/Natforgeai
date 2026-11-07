-- R10-X canonical package. Generated offline; NOT EXECUTED. No activation data.
CREATE TABLE `provider_account_bindings` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`bindingId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`providerId` varchar(32) NOT NULL,
	`providerAccountId` varchar(128) NOT NULL,
	`capability` varchar(40) NOT NULL,
	`actionType` varchar(20) NOT NULL,
	`credentialFingerprint` varchar(64) NOT NULL,
	`status` varchar(12) NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_account_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `pab_binding_identity_uidx` UNIQUE(`bindingId`),
	CONSTRAINT `pab_user_binding_uidx` UNIQUE(`userId`,`bindingId`),
	CONSTRAINT `pab_binding_natural_uidx` UNIQUE(`userId`,`businessId`,`providerId`,`providerAccountId`,`capability`,`actionType`)
);

--> statement-breakpoint
CREATE TABLE `provider_dispatch_requests` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`requestId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`bindingId` varchar(69) NOT NULL,
	`executionActionId` varchar(69) NOT NULL,
	`attemptId` varchar(69) NOT NULL,
	`providerId` varchar(32) NOT NULL,
	`providerAccountId` varchar(128) NOT NULL,
	`capability` varchar(40) NOT NULL,
	`actionType` varchar(20) NOT NULL,
	`parametersHash` varchar(64) NOT NULL,
	`nativeIdempotencyKey` varchar(69),
	`state` varchar(22) NOT NULL,
	`classification` varchar(24),
	`failureClass` varchar(24),
	`providerReference` varchar(191),
	`retryAfterMs` bigint,
	`evidenceHash` varchar(64),
	`circuitStateAtDispatch` varchar(12),
	`dispatchedAt` varchar(32),
	`completedAt` varchar(32),
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_dispatch_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `pdr_request_identity_uidx` UNIQUE(`requestId`),
	CONSTRAINT `pdr_user_request_uidx` UNIQUE(`userId`,`requestId`),
	CONSTRAINT `pdr_request_natural_uidx` UNIQUE(`userId`,`executionActionId`,`attemptId`)
);

--> statement-breakpoint
CREATE TABLE `provider_callback_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`callbackId` varchar(70) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`requestId` varchar(69),
	`bindingId` varchar(69),
	`providerId` varchar(32) NOT NULL,
	`providerAccountId` varchar(128) NOT NULL,
	`providerEventId` varchar(191) NOT NULL,
	`disposition` varchar(28) NOT NULL,
	`classification` varchar(24),
	`payloadHash` varchar(64) NOT NULL,
	`occurredAt` varchar(32) NOT NULL,
	`receivedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_callback_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `pce_callback_identity_uidx` UNIQUE(`callbackId`),
	CONSTRAINT `pce_user_callback_uidx` UNIQUE(`userId`,`callbackId`),
	CONSTRAINT `pce_callback_natural_uidx` UNIQUE(`providerId`,`providerAccountId`,`providerEventId`,`payloadHash`)
);

--> statement-breakpoint
CREATE TABLE `provider_reconciliation_records` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`reconciliationId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`requestId` varchar(69) NOT NULL,
	`outcome` varchar(24) NOT NULL,
	`evidenceHash` varchar(64) NOT NULL,
	`providerReference` varchar(191),
	`reconciledAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_reconciliation_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `prr_reconciliation_identity_uidx` UNIQUE(`reconciliationId`),
	CONSTRAINT `prr_user_reconciliation_uidx` UNIQUE(`userId`,`reconciliationId`),
	CONSTRAINT `prr_reconciliation_natural_uidx` UNIQUE(`userId`,`requestId`,`evidenceHash`)
);

--> statement-breakpoint
CREATE TABLE `provider_circuit_breaker_states` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`circuitId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`providerId` varchar(32) NOT NULL,
	`providerAccountId` varchar(128) NOT NULL,
	`actionType` varchar(20) NOT NULL,
	`circuitState` varchar(12) NOT NULL,
	`failureCount` int NOT NULL,
	`successCount` int NOT NULL,
	`openedAtMs` bigint,
	`windowStartMs` bigint NOT NULL,
	`halfOpenProbesInFlight` int NOT NULL,
	`version` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_circuit_breaker_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `pcbs_circuit_identity_uidx` UNIQUE(`circuitId`),
	CONSTRAINT `pcbs_user_circuit_uidx` UNIQUE(`userId`,`circuitId`),
	CONSTRAINT `pcbs_circuit_natural_uidx` UNIQUE(`userId`,`providerId`,`providerAccountId`,`actionType`)
);

--> statement-breakpoint
CREATE INDEX `pab_user_provider_idx` ON `provider_account_bindings` (`userId`,`providerId`);
--> statement-breakpoint
CREATE INDEX `pdr_user_binding_idx` ON `provider_dispatch_requests` (`userId`,`bindingId`);
--> statement-breakpoint
CREATE INDEX `pdr_user_provider_idx` ON `provider_dispatch_requests` (`userId`,`providerId`);
--> statement-breakpoint
CREATE INDEX `pce_user_request_idx` ON `provider_callback_events` (`userId`,`requestId`);
--> statement-breakpoint
CREATE INDEX `prr_user_request_idx` ON `provider_reconciliation_records` (`userId`,`requestId`);
