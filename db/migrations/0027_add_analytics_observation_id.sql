ALTER TABLE `analytics` ADD `observationId` varchar(191);--> statement-breakpoint
ALTER TABLE `analytics` ADD CONSTRAINT `analytics_observation_id_idx` UNIQUE(`observationId`);