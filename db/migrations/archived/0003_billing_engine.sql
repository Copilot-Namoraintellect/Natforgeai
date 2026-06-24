-- Phase 4.6: AI Usage Billing Engine
-- Adds credit-based billing, cost tracking, and spend limits
-- Cloud SQL MySQL 8.4 compatible

-- AI Usage tracking
CREATE TABLE IF NOT EXISTS `ai_usage` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userId` bigint unsigned NOT NULL,
  `campaignId` bigint unsigned,
  `agentType` enum('strategy','creative','audience','distribution','engagement','sales','optimisation','safety_check','image_generation','video_generation') NOT NULL,
  `model` varchar(50) NOT NULL,
  `promptTokens` int NOT NULL DEFAULT 0,
  `completionTokens` int NOT NULL DEFAULT 0,
  `totalTokens` int NOT NULL DEFAULT 0,
  `actualCostUsd` int NOT NULL DEFAULT 0,
  `estimatedCostUsd` int NOT NULL DEFAULT 0,
  `creditsDeducted` int NOT NULL DEFAULT 0,
  `metadata` json,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ai_usage_userId_idx` (`userId`),
  KEY `ai_usage_campaignId_idx` (`campaignId`),
  KEY `ai_usage_agentType_idx` (`agentType`),
  KEY `ai_usage_createdAt_idx` (`createdAt`)
);

-- Credit Wallets (per-user)
CREATE TABLE IF NOT EXISTS `credit_wallets` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userId` bigint unsigned NOT NULL,
  `balance` int NOT NULL DEFAULT 0,
  `lifetimeEarned` int NOT NULL DEFAULT 0,
  `lifetimeSpent` int NOT NULL DEFAULT 0,
  `monthlyAllocation` int NOT NULL DEFAULT 0,
  `monthlyResetAt` timestamp,
  `spendLimit` int,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `credit_wallets_userId_unique` (`userId`),
  KEY `credit_wallets_userId_idx` (`userId`)
);

-- Credit Transactions (immutable ledger)
CREATE TABLE IF NOT EXISTS `credit_transactions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userId` bigint unsigned NOT NULL,
  `walletId` bigint unsigned NOT NULL,
  `type` enum('subscription_allocation','purchase','agent_deduction','publishing_deduction','image_generation','video_generation','refund','admin_adjustment','rollover') NOT NULL,
  `amount` int NOT NULL,
  `balanceAfter` int NOT NULL,
  `description` text,
  `metadata` json,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `credit_transactions_userId_idx` (`userId`),
  KEY `credit_transactions_walletId_idx` (`walletId`),
  KEY `credit_transactions_type_idx` (`type`),
  KEY `credit_transactions_createdAt_idx` (`createdAt`)
);

-- Add monthlyCredits to subscription tiers (idempotent)
DELIMITER //

DROP PROCEDURE IF EXISTS add_column_if_missing//
CREATE PROCEDURE add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition VARCHAR(512)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

DELIMITER ;

CALL add_column_if_missing('subscription_tiers', 'monthlyCredits', 'int NOT NULL DEFAULT 0');

-- Update tier credits
UPDATE `subscription_tiers` SET `monthlyCredits` = 50 WHERE `slug` = 'free';
UPDATE `subscription_tiers` SET `monthlyCredits` = 500 WHERE `slug` = 'startup';
UPDATE `subscription_tiers` SET `monthlyCredits` = 2500 WHERE `slug` = 'growth';
UPDATE `subscription_tiers` SET `monthlyCredits` = 10000 WHERE `slug` = 'enterprise';

-- Clean up helper
DROP PROCEDURE IF EXISTS add_column_if_missing;
