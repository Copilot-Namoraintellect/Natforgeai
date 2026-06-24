-- ============================================================================
-- Manual Cloud SQL MySQL 8.4 Patch
-- Combines all Phase 4 migrations (0002 through 0007) into a single
-- idempotent script that can be run safely multiple times in Cloud SQL Studio.
-- ============================================================================

-- ============================================================================
-- Helper Procedures
-- ============================================================================

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

DROP PROCEDURE IF EXISTS add_index_if_missing//
CREATE PROCEDURE add_index_if_missing(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns VARCHAR(512)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '`(', p_columns, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

DELIMITER ;

-- ============================================================================
-- 0002: Hardening Sprint
-- ============================================================================

-- Update publishing_queue status enum (naturally idempotent)
ALTER TABLE `publishing_queue` MODIFY COLUMN `status` enum('draft','pending_approval','approved','published','failed','safety_blocked','retrying') NOT NULL DEFAULT 'draft';

-- Add retry logic fields
CALL add_column_if_missing('publishing_queue', 'retryCount', 'int NOT NULL DEFAULT 0');
CALL add_column_if_missing('publishing_queue', 'maxRetries', 'int NOT NULL DEFAULT 3');
CALL add_column_if_missing('publishing_queue', 'nextRetryAt', 'timestamp NULL DEFAULT NULL');
CALL add_column_if_missing('publishing_queue', 'lastError', 'text');

-- Add content safety fields
CALL add_column_if_missing('publishing_queue', 'safetyStatus', "enum('pending','low','medium','high')");
CALL add_column_if_missing('publishing_queue', 'safetyReasons', 'json');

-- ============================================================================
-- 0003: Billing Engine
-- ============================================================================

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

-- Add monthlyCredits to subscription tiers
CALL add_column_if_missing('subscription_tiers', 'monthlyCredits', 'int NOT NULL DEFAULT 0');

-- Update tier credits
UPDATE `subscription_tiers` SET `monthlyCredits` = 50 WHERE `slug` = 'free';
UPDATE `subscription_tiers` SET `monthlyCredits` = 500 WHERE `slug` = 'startup';
UPDATE `subscription_tiers` SET `monthlyCredits` = 2500 WHERE `slug` = 'growth';
UPDATE `subscription_tiers` SET `monthlyCredits` = 10000 WHERE `slug` = 'enterprise';

-- ============================================================================
-- 0004: Database Indexes
-- ============================================================================

-- users
CALL add_index_if_missing('users', 'users_email_idx', '`email`');
CALL add_index_if_missing('users', 'users_firebaseUid_idx', '`firebaseUid`');
CALL add_index_if_missing('users', 'users_googleId_idx', '`googleId`');
CALL add_index_if_missing('users', 'users_unionId_idx', '`unionId`');
CALL add_index_if_missing('users', 'users_role_idx', '`role`');
CALL add_index_if_missing('users', 'users_createdAt_idx', '`createdAt`');

-- subscriptions
CALL add_index_if_missing('subscriptions', 'subscriptions_userId_idx', '`userId`');
CALL add_index_if_missing('subscriptions', 'subscriptions_tierId_idx', '`tierId`');
CALL add_index_if_missing('subscriptions', 'subscriptions_status_idx', '`status`');

-- payments
CALL add_index_if_missing('payments', 'payments_userId_idx', '`userId`');
CALL add_index_if_missing('payments', 'payments_subscriptionId_idx', '`subscriptionId`');
CALL add_index_if_missing('payments', 'payments_status_idx', '`status`');

-- businesses
CALL add_index_if_missing('businesses', 'businesses_userId_idx', '`userId`');

-- campaigns
CALL add_index_if_missing('campaigns', 'campaigns_userId_idx', '`userId`');
CALL add_index_if_missing('campaigns', 'campaigns_businessId_idx', '`businessId`');
CALL add_index_if_missing('campaigns', 'campaigns_status_idx', '`status`');
CALL add_index_if_missing('campaigns', 'campaigns_workflowState_idx', '`workflowState`');
CALL add_index_if_missing('campaigns', 'campaigns_createdAt_idx', '`createdAt`');

-- content_posts
CALL add_index_if_missing('content_posts', 'content_posts_userId_idx', '`userId`');
CALL add_index_if_missing('content_posts', 'content_posts_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('content_posts', 'content_posts_status_idx', '`status`');

-- leads
CALL add_index_if_missing('leads', 'leads_userId_idx', '`userId`');
CALL add_index_if_missing('leads', 'leads_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('leads', 'leads_status_idx', '`status`');
CALL add_index_if_missing('leads', 'leads_email_idx', '`email`');
CALL add_index_if_missing('leads', 'leads_nextFollowUp_idx', '`nextFollowUp`');

-- lead_activities
CALL add_index_if_missing('lead_activities', 'lead_activities_leadId_idx', '`leadId`');

-- schedules
CALL add_index_if_missing('schedules', 'schedules_userId_idx', '`userId`');
CALL add_index_if_missing('schedules', 'schedules_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('schedules', 'schedules_status_idx', '`status`');

-- automations
CALL add_index_if_missing('automations', 'automations_userId_idx', '`userId`');

-- analytics
CALL add_index_if_missing('analytics', 'analytics_userId_idx', '`userId`');
CALL add_index_if_missing('analytics', 'analytics_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('analytics', 'analytics_metricType_idx', '`metricType`');
CALL add_index_if_missing('analytics', 'analytics_date_idx', '`date`');

-- templates
CALL add_index_if_missing('templates', 'templates_userId_idx', '`userId`');
CALL add_index_if_missing('templates', 'templates_category_idx', '`category`');

-- generated_images
CALL add_index_if_missing('generated_images', 'generated_images_userId_idx', '`userId`');
CALL add_index_if_missing('generated_images', 'generated_images_campaignId_idx', '`campaignId`');

-- agent_runs
CALL add_index_if_missing('agent_runs', 'agent_runs_userId_idx', '`userId`');
CALL add_index_if_missing('agent_runs', 'agent_runs_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('agent_runs', 'agent_runs_agentType_idx', '`agentType`');
CALL add_index_if_missing('agent_runs', 'agent_runs_status_idx', '`status`');
CALL add_index_if_missing('agent_runs', 'agent_runs_createdAt_idx', '`createdAt`');

-- approval_requests
CALL add_index_if_missing('approval_requests', 'approval_requests_userId_idx', '`userId`');
CALL add_index_if_missing('approval_requests', 'approval_requests_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('approval_requests', 'approval_requests_status_idx', '`status`');

-- campaign_assets
CALL add_index_if_missing('campaign_assets', 'campaign_assets_userId_idx', '`userId`');
CALL add_index_if_missing('campaign_assets', 'campaign_assets_campaignId_idx', '`campaignId`');

-- publishing_queue
CALL add_index_if_missing('publishing_queue', 'publishing_queue_userId_idx', '`userId`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_status_idx', '`status`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_nextRetryAt_idx', '`nextRetryAt`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_scheduledAt_idx', '`scheduledAt`');

-- social_integrations
CALL add_index_if_missing('social_integrations', 'social_integrations_userId_idx', '`userId`');
CALL add_index_if_missing('social_integrations', 'social_integrations_platform_idx', '`platform`');
CALL add_index_if_missing('social_integrations', 'social_integrations_status_idx', '`status`');

-- conversation_threads
CALL add_index_if_missing('conversation_threads', 'conversation_threads_userId_idx', '`userId`');
CALL add_index_if_missing('conversation_threads', 'conversation_threads_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('conversation_threads', 'conversation_threads_leadId_idx', '`leadId`');

-- conversation_messages
CALL add_index_if_missing('conversation_messages', 'conversation_messages_threadId_idx', '`threadId`');

-- optimisation_logs
CALL add_index_if_missing('optimisation_logs', 'optimisation_logs_userId_idx', '`userId`');
CALL add_index_if_missing('optimisation_logs', 'optimisation_logs_campaignId_idx', '`campaignId`');

-- ============================================================================
-- 0005: User Usage Table
-- ============================================================================

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

-- ============================================================================
-- 0006: Credit Renewal Fields
-- ============================================================================

CALL add_column_if_missing('subscriptions', 'lastCreditAllocationAt', 'TIMESTAMP NULL DEFAULT NULL');
CALL add_column_if_missing('subscriptions', 'nextCreditAllocationAt', 'TIMESTAMP NULL DEFAULT NULL');
CALL add_index_if_missing('subscriptions', 'idx_subscriptions_next_credit_allocation', '`nextCreditAllocationAt`, `status`');

-- ============================================================================
-- 0007: System Alerts Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_alerts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  severity ENUM('critical', 'warning', 'info') NOT NULL,
  category ENUM('publishing', 'queue', 'worker', 'redis', 'openai', 'billing', 'system') NOT NULL,
  message TEXT NOT NULL,
  details JSON,
  resolvedAt TIMESTAMP NULL DEFAULT NULL,
  acknowledgedAt TIMESTAMP NULL DEFAULT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  INDEX idx_system_alerts_category (category, resolvedAt),
  INDEX idx_system_alerts_severity (severity, resolvedAt),
  INDEX idx_system_alerts_created_at (createdAt)
);

-- ============================================================================
-- Clean Up Helpers
-- ============================================================================

DROP PROCEDURE IF EXISTS add_column_if_missing;
DROP PROCEDURE IF EXISTS add_index_if_missing;
