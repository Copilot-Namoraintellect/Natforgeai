-- ============================================================================
-- Cloud SQL Studio Manual Patch
-- ============================================================================
-- For: Google Cloud SQL Studio (web UI)
-- Constraints: No DELIMITER, no stored procedures, no IF NOT EXISTS on
--              ALTER TABLE or CREATE INDEX.
-- Usage: Run each SELECT first. If it returns 0 rows, run the DDL below it.
--        If it returns rows, skip that DDL block.
-- ============================================================================

-- ============================================================================
-- 1. VALIDATION CHECKS
--    Run these first to see what is missing.
-- ============================================================================

-- Missing publishing_queue columns?
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'publishing_queue'
  AND COLUMN_NAME IN ('retryCount','maxRetries','nextRetryAt','lastError','safetyStatus','safetyReasons');

-- Missing subscription renewal columns?
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'subscriptions'
  AND COLUMN_NAME IN ('lastCreditAllocationAt','nextCreditAllocationAt');

-- Missing monthlyCredits column?
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'subscription_tiers'
  AND COLUMN_NAME = 'monthlyCredits';

-- Missing tables?
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('ai_usage','credit_wallets','credit_transactions','user_usage','system_alerts');

-- Missing indexes (sample — full list in section 6)?
SELECT INDEX_NAME, TABLE_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND INDEX_NAME IN (
    'users_email_idx',
    'subscriptions_userId_idx',
    'campaigns_status_idx',
    'publishing_queue_status_idx',
    'idx_subscriptions_next_credit_allocation'
  );

-- ============================================================================
-- 2. PUBLISHING_QUEUE COLUMNS
--    Run each ALTER only if the matching SELECT above returned 0 rows.
-- ============================================================================

-- Safe to run even if already set; harmless redefinition
ALTER TABLE `publishing_queue` MODIFY COLUMN `status` enum('draft','pending_approval','approved','published','failed','safety_blocked','retrying') NOT NULL DEFAULT 'draft';

-- Run only if retryCount is missing
ALTER TABLE `publishing_queue` ADD `retryCount` int NOT NULL DEFAULT 0;

-- Run only if maxRetries is missing
ALTER TABLE `publishing_queue` ADD `maxRetries` int NOT NULL DEFAULT 3;

-- Run only if nextRetryAt is missing
ALTER TABLE `publishing_queue` ADD `nextRetryAt` timestamp NULL DEFAULT NULL;

-- Run only if lastError is missing
ALTER TABLE `publishing_queue` ADD `lastError` text;

-- Run only if safetyStatus is missing
ALTER TABLE `publishing_queue` ADD `safetyStatus` enum('pending','low','medium','high');

-- Run only if safetyReasons is missing
ALTER TABLE `publishing_queue` ADD `safetyReasons` json;

-- ============================================================================
-- 3. SUBSCRIPTION RENEWAL COLUMNS
--    Run each ALTER only if the matching SELECT above returned 0 rows.
-- ============================================================================

-- Run only if lastCreditAllocationAt is missing
ALTER TABLE `subscriptions` ADD COLUMN `lastCreditAllocationAt` TIMESTAMP NULL DEFAULT NULL;

-- Run only if nextCreditAllocationAt is missing
ALTER TABLE `subscriptions` ADD COLUMN `nextCreditAllocationAt` TIMESTAMP NULL DEFAULT NULL;

-- ============================================================================
-- 4. MONTHLYCREDITS COLUMN
--    Run only if the matching SELECT above returned 0 rows.
-- ============================================================================

ALTER TABLE `subscription_tiers` ADD COLUMN `monthlyCredits` int NOT NULL DEFAULT 0;

-- Update tier credit allocations (idempotent — safe to rerun)
UPDATE `subscription_tiers` SET `monthlyCredits` = 50 WHERE `slug` = 'free';
UPDATE `subscription_tiers` SET `monthlyCredits` = 500 WHERE `slug` = 'startup';
UPDATE `subscription_tiers` SET `monthlyCredits` = 2500 WHERE `slug` = 'growth';
UPDATE `subscription_tiers` SET `monthlyCredits` = 10000 WHERE `slug` = 'enterprise';

-- ============================================================================
-- 5. MISSING TABLES
--    CREATE TABLE IF NOT EXISTS is valid in Cloud SQL MySQL 8.4.
--    Safe to run even if tables already exist.
-- ============================================================================

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

CREATE TABLE IF NOT EXISTS `system_alerts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `severity` enum('critical','warning','info') NOT NULL,
  `category` enum('publishing','queue','worker','redis','openai','billing','system') NOT NULL,
  `message` text NOT NULL,
  `details` json,
  `resolvedAt` timestamp NULL DEFAULT NULL,
  `acknowledgedAt` timestamp NULL DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_system_alerts_category` (`category`,`resolvedAt`),
  INDEX `idx_system_alerts_severity` (`severity`,`resolvedAt`),
  INDEX `idx_system_alerts_created_at` (`createdAt`)
);

-- ============================================================================
-- 6. INDEXES
--    Run each CREATE INDEX only if the matching SELECT below returns 0 rows.
--    Each index has a guard query you can run first.
-- ============================================================================

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_email_idx';
CREATE INDEX `users_email_idx` ON `users`(`email`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_firebaseUid_idx';
CREATE INDEX `users_firebaseUid_idx` ON `users`(`firebaseUid`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_googleId_idx';
CREATE INDEX `users_googleId_idx` ON `users`(`googleId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_unionId_idx';
CREATE INDEX `users_unionId_idx` ON `users`(`unionId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_role_idx';
CREATE INDEX `users_role_idx` ON `users`(`role`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_createdAt_idx';
CREATE INDEX `users_createdAt_idx` ON `users`(`createdAt`);

-- subscriptions
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND INDEX_NAME = 'subscriptions_userId_idx';
CREATE INDEX `subscriptions_userId_idx` ON `subscriptions`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND INDEX_NAME = 'subscriptions_tierId_idx';
CREATE INDEX `subscriptions_tierId_idx` ON `subscriptions`(`tierId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND INDEX_NAME = 'subscriptions_status_idx';
CREATE INDEX `subscriptions_status_idx` ON `subscriptions`(`status`);

-- payments
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'payments_userId_idx';
CREATE INDEX `payments_userId_idx` ON `payments`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'payments_subscriptionId_idx';
CREATE INDEX `payments_subscriptionId_idx` ON `payments`(`subscriptionId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'payments_status_idx';
CREATE INDEX `payments_status_idx` ON `payments`(`status`);

-- businesses
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND INDEX_NAME = 'businesses_userId_idx';
CREATE INDEX `businesses_userId_idx` ON `businesses`(`userId`);

-- campaigns
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND INDEX_NAME = 'campaigns_userId_idx';
CREATE INDEX `campaigns_userId_idx` ON `campaigns`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND INDEX_NAME = 'campaigns_businessId_idx';
CREATE INDEX `campaigns_businessId_idx` ON `campaigns`(`businessId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND INDEX_NAME = 'campaigns_status_idx';
CREATE INDEX `campaigns_status_idx` ON `campaigns`(`status`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND INDEX_NAME = 'campaigns_workflowState_idx';
CREATE INDEX `campaigns_workflowState_idx` ON `campaigns`(`workflowState`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND INDEX_NAME = 'campaigns_createdAt_idx';
CREATE INDEX `campaigns_createdAt_idx` ON `campaigns`(`createdAt`);

-- content_posts
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_posts' AND INDEX_NAME = 'content_posts_userId_idx';
CREATE INDEX `content_posts_userId_idx` ON `content_posts`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_posts' AND INDEX_NAME = 'content_posts_campaignId_idx';
CREATE INDEX `content_posts_campaignId_idx` ON `content_posts`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_posts' AND INDEX_NAME = 'content_posts_status_idx';
CREATE INDEX `content_posts_status_idx` ON `content_posts`(`status`);

-- leads
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'leads_userId_idx';
CREATE INDEX `leads_userId_idx` ON `leads`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'leads_campaignId_idx';
CREATE INDEX `leads_campaignId_idx` ON `leads`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'leads_status_idx';
CREATE INDEX `leads_status_idx` ON `leads`(`status`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'leads_email_idx';
CREATE INDEX `leads_email_idx` ON `leads`(`email`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'leads_nextFollowUp_idx';
CREATE INDEX `leads_nextFollowUp_idx` ON `leads`(`nextFollowUp`);

-- lead_activities
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lead_activities' AND INDEX_NAME = 'lead_activities_leadId_idx';
CREATE INDEX `lead_activities_leadId_idx` ON `lead_activities`(`leadId`);

-- schedules
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules' AND INDEX_NAME = 'schedules_userId_idx';
CREATE INDEX `schedules_userId_idx` ON `schedules`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules' AND INDEX_NAME = 'schedules_campaignId_idx';
CREATE INDEX `schedules_campaignId_idx` ON `schedules`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules' AND INDEX_NAME = 'schedules_status_idx';
CREATE INDEX `schedules_status_idx` ON `schedules`(`status`);

-- automations
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automations' AND INDEX_NAME = 'automations_userId_idx';
CREATE INDEX `automations_userId_idx` ON `automations`(`userId`);

-- analytics
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'analytics' AND INDEX_NAME = 'analytics_userId_idx';
CREATE INDEX `analytics_userId_idx` ON `analytics`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'analytics' AND INDEX_NAME = 'analytics_campaignId_idx';
CREATE INDEX `analytics_campaignId_idx` ON `analytics`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'analytics' AND INDEX_NAME = 'analytics_metricType_idx';
CREATE INDEX `analytics_metricType_idx` ON `analytics`(`metricType`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'analytics' AND INDEX_NAME = 'analytics_date_idx';
CREATE INDEX `analytics_date_idx` ON `analytics`(`date`);

-- templates
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'templates' AND INDEX_NAME = 'templates_userId_idx';
CREATE INDEX `templates_userId_idx` ON `templates`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'templates' AND INDEX_NAME = 'templates_category_idx';
CREATE INDEX `templates_category_idx` ON `templates`(`category`);

-- generated_images
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_images' AND INDEX_NAME = 'generated_images_userId_idx';
CREATE INDEX `generated_images_userId_idx` ON `generated_images`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generated_images' AND INDEX_NAME = 'generated_images_campaignId_idx';
CREATE INDEX `generated_images_campaignId_idx` ON `generated_images`(`campaignId`);

-- agent_runs
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_runs' AND INDEX_NAME = 'agent_runs_userId_idx';
CREATE INDEX `agent_runs_userId_idx` ON `agent_runs`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_runs' AND INDEX_NAME = 'agent_runs_campaignId_idx';
CREATE INDEX `agent_runs_campaignId_idx` ON `agent_runs`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_runs' AND INDEX_NAME = 'agent_runs_agentType_idx';
CREATE INDEX `agent_runs_agentType_idx` ON `agent_runs`(`agentType`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_runs' AND INDEX_NAME = 'agent_runs_status_idx';
CREATE INDEX `agent_runs_status_idx` ON `agent_runs`(`status`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_runs' AND INDEX_NAME = 'agent_runs_createdAt_idx';
CREATE INDEX `agent_runs_createdAt_idx` ON `agent_runs`(`createdAt`);

-- approval_requests
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND INDEX_NAME = 'approval_requests_userId_idx';
CREATE INDEX `approval_requests_userId_idx` ON `approval_requests`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND INDEX_NAME = 'approval_requests_campaignId_idx';
CREATE INDEX `approval_requests_campaignId_idx` ON `approval_requests`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND INDEX_NAME = 'approval_requests_status_idx';
CREATE INDEX `approval_requests_status_idx` ON `approval_requests`(`status`);

-- campaign_assets
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_assets' AND INDEX_NAME = 'campaign_assets_userId_idx';
CREATE INDEX `campaign_assets_userId_idx` ON `campaign_assets`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_assets' AND INDEX_NAME = 'campaign_assets_campaignId_idx';
CREATE INDEX `campaign_assets_campaignId_idx` ON `campaign_assets`(`campaignId`);

-- publishing_queue
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publishing_queue' AND INDEX_NAME = 'publishing_queue_userId_idx';
CREATE INDEX `publishing_queue_userId_idx` ON `publishing_queue`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publishing_queue' AND INDEX_NAME = 'publishing_queue_campaignId_idx';
CREATE INDEX `publishing_queue_campaignId_idx` ON `publishing_queue`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publishing_queue' AND INDEX_NAME = 'publishing_queue_status_idx';
CREATE INDEX `publishing_queue_status_idx` ON `publishing_queue`(`status`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publishing_queue' AND INDEX_NAME = 'publishing_queue_nextRetryAt_idx';
CREATE INDEX `publishing_queue_nextRetryAt_idx` ON `publishing_queue`(`nextRetryAt`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publishing_queue' AND INDEX_NAME = 'publishing_queue_scheduledAt_idx';
CREATE INDEX `publishing_queue_scheduledAt_idx` ON `publishing_queue`(`scheduledAt`);

-- social_integrations
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'social_integrations' AND INDEX_NAME = 'social_integrations_userId_idx';
CREATE INDEX `social_integrations_userId_idx` ON `social_integrations`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'social_integrations' AND INDEX_NAME = 'social_integrations_platform_idx';
CREATE INDEX `social_integrations_platform_idx` ON `social_integrations`(`platform`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'social_integrations' AND INDEX_NAME = 'social_integrations_status_idx';
CREATE INDEX `social_integrations_status_idx` ON `social_integrations`(`status`);

-- conversation_threads
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_threads' AND INDEX_NAME = 'conversation_threads_userId_idx';
CREATE INDEX `conversation_threads_userId_idx` ON `conversation_threads`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_threads' AND INDEX_NAME = 'conversation_threads_campaignId_idx';
CREATE INDEX `conversation_threads_campaignId_idx` ON `conversation_threads`(`campaignId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_threads' AND INDEX_NAME = 'conversation_threads_leadId_idx';
CREATE INDEX `conversation_threads_leadId_idx` ON `conversation_threads`(`leadId`);

-- conversation_messages
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_messages' AND INDEX_NAME = 'conversation_messages_threadId_idx';
CREATE INDEX `conversation_messages_threadId_idx` ON `conversation_messages`(`threadId`);

-- optimisation_logs
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'optimisation_logs' AND INDEX_NAME = 'optimisation_logs_userId_idx';
CREATE INDEX `optimisation_logs_userId_idx` ON `optimisation_logs`(`userId`);

-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'optimisation_logs' AND INDEX_NAME = 'optimisation_logs_campaignId_idx';
CREATE INDEX `optimisation_logs_campaignId_idx` ON `optimisation_logs`(`campaignId`);

-- credit renewal index
-- Guard: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND INDEX_NAME = 'idx_subscriptions_next_credit_allocation';
CREATE INDEX `idx_subscriptions_next_credit_allocation` ON `subscriptions`(`nextCreditAllocationAt`,`status`);

-- ============================================================================
-- 7. FINAL VALIDATION
--    Run these after all DDL to confirm everything is in place.
-- ============================================================================

-- Verify all publishing_queue columns
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'publishing_queue'
  AND COLUMN_NAME IN ('retryCount','maxRetries','nextRetryAt','lastError','safetyStatus','safetyReasons');

-- Verify subscription renewal columns
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'subscriptions'
  AND COLUMN_NAME IN ('lastCreditAllocationAt','nextCreditAllocationAt');

-- Verify monthlyCredits
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'subscription_tiers'
  AND COLUMN_NAME = 'monthlyCredits';

-- Verify tier values
SELECT slug, monthlyCredits FROM subscription_tiers WHERE slug IN ('free','startup','growth','enterprise');

-- Verify tables
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('ai_usage','credit_wallets','credit_transactions','user_usage','system_alerts');

-- Verify index count (should be >= 48 + existing indexes)
SELECT COUNT(*) AS total_indexes FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME != 'PRIMARY';
