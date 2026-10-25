CREATE TABLE `lead_identities` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadId` varchar(69) NOT NULL,
	`identityKey` varchar(64) NOT NULL,
	`contractVersion` varchar(40) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned,
	`primaryIdentityType` enum('provider_actor','email_hash','phone_hash','authenticated_customer_reference','crm_external_reference','anonymous_thread','unknown') NOT NULL,
	`identityStatus` enum('active','anonymous','partially_identified','resolved','conflicting','suppressed','merged','archived') NOT NULL,
	`identityConfidence` enum('unknown','low','medium','high') NOT NULL,
	`externalActorReferenceHash` varchar(64),
	`provider` enum('meta','linkedin','twitter','tiktok'),
	`emailIdentityHash` varchar(64),
	`phoneIdentityHash` varchar(64),
	`customerReferenceHash` varchar(64),
	`sourceOpportunityId` varchar(69) NOT NULL,
	`sourceHandoffId` varchar(69) NOT NULL,
	`canonicalLeadId` varchar(69),
	`firstObservedAt` varchar(32) NOT NULL,
	`lastObservedAt` varchar(32) NOT NULL,
	`provenanceCount` int NOT NULL DEFAULT 1,
	`identityEvidenceCount` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`statusChangedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `li_user_identity_uidx` UNIQUE(`userId`,`identityKey`),
	CONSTRAINT `li_user_lead_uidx` UNIQUE(`userId`,`leadId`),
	CONSTRAINT `li_user_email_uidx` UNIQUE(`userId`,`emailIdentityHash`),
	CONSTRAINT `li_user_phone_uidx` UNIQUE(`userId`,`phoneIdentityHash`),
	CONSTRAINT `li_user_custref_uidx` UNIQUE(`userId`,`customerReferenceHash`)
);
--> statement-breakpoint
CREATE TABLE `lead_identity_merges` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`mergeId` varchar(69) NOT NULL,
	`mergeHash` varchar(64) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`canonicalLeadId` varchar(69) NOT NULL,
	`absorbedLeadId` varchar(69) NOT NULL,
	`linkingEvidenceType` enum('email_hash','phone_hash','authenticated_customer_reference','crm_external_reference') NOT NULL,
	`linkingEvidenceHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identity_merges_id` PRIMARY KEY(`id`),
	CONSTRAINT `lim_user_merge_uidx` UNIQUE(`userId`,`mergeId`),
	CONSTRAINT `lim_user_pair_uidx` UNIQUE(`userId`,`canonicalLeadId`,`absorbedLeadId`),
	CONSTRAINT `lim_user_hash_uidx` UNIQUE(`userId`,`mergeHash`)
);
--> statement-breakpoint
CREATE TABLE `lead_identity_provenance` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`leadRowId` bigint unsigned NOT NULL,
	`leadId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`kind` enum('opportunity_handoff','identity_evidence','merge','conflict') NOT NULL,
	`handoffId` varchar(69),
	`opportunityId` varchar(69),
	`provider` enum('meta','linkedin','twitter','tiktok'),
	`campaignId` bigint unsigned,
	`publicationId` varchar(128),
	`evidenceType` varchar(40),
	`evidenceHash` varchar(64) NOT NULL,
	`envelopeHash` varchar(64),
	`occurredAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_identity_provenance_id` PRIMARY KEY(`id`),
	CONSTRAINT `lip_user_handoff_uidx` UNIQUE(`userId`,`handoffId`),
	CONSTRAINT `lip_user_kind_hash_uidx` UNIQUE(`userId`,`kind`,`evidenceHash`)
);
--> statement-breakpoint
CREATE INDEX `li_user_status_idx` ON `lead_identities` (`userId`,`identityStatus`);--> statement-breakpoint
CREATE INDEX `lip_lead_row_idx` ON `lead_identity_provenance` (`leadRowId`);