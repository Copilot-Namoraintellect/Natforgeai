-- Auto-generated migration for website evidence storage + schema sync

ALTER TABLE `businesses` ADD COLUMN `email` varchar(255);
--> statement-breakpoint
ALTER TABLE `businesses` ADD COLUMN `websiteEvidence` json;
