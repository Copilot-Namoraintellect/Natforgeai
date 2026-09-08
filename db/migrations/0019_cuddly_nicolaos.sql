ALTER TABLE `image_render_claims` ADD `requestAttemptKey` varchar(64);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `intentFingerprint` varchar(64);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `deductionKey` varchar(191);--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD `deductionRecorded` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `image_render_claims` ADD CONSTRAINT `irc_request_attempt_key_idx` UNIQUE(`requestAttemptKey`);--> statement-breakpoint
CREATE INDEX `irc_deduction_key_idx` ON `image_render_claims` (`deductionKey`);