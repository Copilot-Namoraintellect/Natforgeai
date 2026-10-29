CREATE TABLE `budget_portfolio_allocation_instructions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`instructionId` varchar(68) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`optimisationId` varchar(68) NOT NULL,
	`governanceDecisionId` varchar(69) NOT NULL,
	`approvalRequestId` bigint unsigned,
	`policyVersion` varchar(96) NOT NULL,
	`authorisedAt` varchar(32) NOT NULL,
	`expiresAt` varchar(32) NOT NULL,
	`allocations` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `budget_portfolio_allocation_instructions_id` PRIMARY KEY(`id`),
	CONSTRAINT `bpi_instruction_identity_uidx` UNIQUE(`instructionId`),
	CONSTRAINT `bpi_user_instruction_uidx` UNIQUE(`userId`,`instructionId`)
);
--> statement-breakpoint
CREATE TABLE `budget_portfolio_proposals` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`optimisationId` varchar(68) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`portfolioSnapshotId` varchar(69) NOT NULL,
	`budgetPeriod` varchar(7) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`currentTotalBudgetMinor` bigint NOT NULL,
	`currentAllocations` json NOT NULL,
	`proposedAllocations` json NOT NULL,
	`deltaAllocations` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`learningRefs` json NOT NULL,
	`attributionRefs` json NOT NULL,
	`outcomeRefs` json NOT NULL,
	`objective` varchar(48) NOT NULL,
	`algorithmVersion` varchar(48) NOT NULL,
	`constraintVersion` varchar(48) NOT NULL,
	`evidenceBundleHash` varchar(64) NOT NULL,
	`confidenceClass` varchar(16) NOT NULL,
	`reasonCodes` json NOT NULL,
	`governanceDecisionId` varchar(69),
	`governanceDecision` json,
	`approvalRequired` boolean NOT NULL,
	`status` varchar(24) NOT NULL,
	`proposalContentHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`validUntil` varchar(32),
	CONSTRAINT `budget_portfolio_proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `bpp_optimisation_identity_uidx` UNIQUE(`optimisationId`),
	CONSTRAINT `bpp_user_optimisation_uidx` UNIQUE(`userId`,`optimisationId`)
);
--> statement-breakpoint
CREATE TABLE `budget_portfolio_snapshots` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`portfolioSnapshotId` varchar(69) NOT NULL,
	`userId` bigint unsigned NOT NULL,
	`businessId` bigint unsigned NOT NULL,
	`budgetPeriod` varchar(7) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`approvedTotalBudgetMinor` bigint NOT NULL,
	`committedMinor` bigint NOT NULL,
	`reservedMinor` bigint NOT NULL,
	`availableReallocatableMinor` bigint NOT NULL,
	`currentAllocations` json NOT NULL,
	`supportedProviders` json NOT NULL,
	`lockedAllocationKeys` json NOT NULL,
	`disabledAllocationKeys` json NOT NULL,
	`capturedAt` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `budget_portfolio_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `bps_snapshot_identity_uidx` UNIQUE(`portfolioSnapshotId`),
	CONSTRAINT `bps_user_snapshot_uidx` UNIQUE(`userId`,`portfolioSnapshotId`)
);
--> statement-breakpoint
CREATE INDEX `bpi_user_optimisation_idx` ON `budget_portfolio_allocation_instructions` (`userId`,`optimisationId`);--> statement-breakpoint
CREATE INDEX `bpp_user_business_idx` ON `budget_portfolio_proposals` (`userId`,`businessId`);--> statement-breakpoint
CREATE INDEX `bpp_user_status_idx` ON `budget_portfolio_proposals` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `bps_user_business_idx` ON `budget_portfolio_snapshots` (`userId`,`businessId`);