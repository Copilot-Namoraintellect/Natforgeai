-- Phase 4.7: user_usage table migration
-- This table was previously created only in db/fix.ts
-- Cloud SQL MySQL 8.4 compatible (CREATE TABLE IF NOT EXISTS is supported)

CREATE TABLE IF NOT EXISTS `user_usage` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userId` bigint unsigned NOT NULL UNIQUE,
  `campaignsCreated` int DEFAULT 0,
  `successfulResults` int DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_usage_userId_idx` (`userId`)
);
