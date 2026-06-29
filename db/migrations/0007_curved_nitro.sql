-- Auto-generated migration for website evidence storage + schema sync

ALTER TABLE `businesses` ADD COLUMN IF NOT EXISTS `email` varchar(255);
ALTER TABLE `businesses` ADD COLUMN IF NOT EXISTS `websiteEvidence` json;
