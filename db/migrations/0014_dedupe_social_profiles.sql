-- Deduplicate social_profiles by (userId, platform, externalId), keeping the earliest row.
DELETE t1 FROM `social_profiles` t1
INNER JOIN `social_profiles` t2
  ON t1.`userId` = t2.`userId`
  AND t1.`platform` = t2.`platform`
  AND t1.`externalId` = t2.`externalId`
  AND t1.`id` > t2.`id`;
--> statement-breakpoint
DROP INDEX `user_platform_external_idx` ON `social_profiles`;
--> statement-breakpoint
ALTER TABLE `social_profiles` ADD CONSTRAINT `user_platform_external_idx` UNIQUE(`userId`,`platform`,`externalId`);
