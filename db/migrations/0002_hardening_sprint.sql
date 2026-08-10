-- Phase 4 Hardening Sprint
-- Adds retry logic, content safety, and publishing state improvements

ALTER TABLE `publishing_queue` MODIFY COLUMN `status` enum('draft','pending_approval','approved','published','failed','safety_blocked','retrying') NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `retryCount` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `maxRetries` int NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `nextRetryAt` timestamp NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `lastError` text;
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `safetyStatus` enum('pending','low','medium','high');
--> statement-breakpoint
ALTER TABLE `publishing_queue` ADD COLUMN `safetyReasons` json;
