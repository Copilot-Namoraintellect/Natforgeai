-- Phase 4.7: Database Index Audit
-- Adds missing indexes for query performance
-- Cloud SQL MySQL 8.4 compatible (idempotent via helper procedure)

DELIMITER //

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

-- users: lookup by email, firebase, google, unionId
CALL add_index_if_missing('users', 'users_email_idx', '`email`');
CALL add_index_if_missing('users', 'users_firebaseUid_idx', '`firebaseUid`');
CALL add_index_if_missing('users', 'users_googleId_idx', '`googleId`');
CALL add_index_if_missing('users', 'users_unionId_idx', '`unionId`');
CALL add_index_if_missing('users', 'users_role_idx', '`role`');
CALL add_index_if_missing('users', 'users_createdAt_idx', '`createdAt`');

-- subscriptions: filter by user + status
CALL add_index_if_missing('subscriptions', 'subscriptions_userId_idx', '`userId`');
CALL add_index_if_missing('subscriptions', 'subscriptions_tierId_idx', '`tierId`');
CALL add_index_if_missing('subscriptions', 'subscriptions_status_idx', '`status`');

-- payments: filter by user, subscription, status
CALL add_index_if_missing('payments', 'payments_userId_idx', '`userId`');
CALL add_index_if_missing('payments', 'payments_subscriptionId_idx', '`subscriptionId`');
CALL add_index_if_missing('payments', 'payments_status_idx', '`status`');

-- businesses: filter by user
CALL add_index_if_missing('businesses', 'businesses_userId_idx', '`userId`');

-- campaigns: filter by user, business, status, workflowState
CALL add_index_if_missing('campaigns', 'campaigns_userId_idx', '`userId`');
CALL add_index_if_missing('campaigns', 'campaigns_businessId_idx', '`businessId`');
CALL add_index_if_missing('campaigns', 'campaigns_status_idx', '`status`');
CALL add_index_if_missing('campaigns', 'campaigns_workflowState_idx', '`workflowState`');
CALL add_index_if_missing('campaigns', 'campaigns_createdAt_idx', '`createdAt`');

-- content_posts: filter by user, campaign, status
CALL add_index_if_missing('content_posts', 'content_posts_userId_idx', '`userId`');
CALL add_index_if_missing('content_posts', 'content_posts_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('content_posts', 'content_posts_status_idx', '`status`');

-- leads: filter by user, campaign, status, email
CALL add_index_if_missing('leads', 'leads_userId_idx', '`userId`');
CALL add_index_if_missing('leads', 'leads_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('leads', 'leads_status_idx', '`status`');
CALL add_index_if_missing('leads', 'leads_email_idx', '`email`');
CALL add_index_if_missing('leads', 'leads_nextFollowUp_idx', '`nextFollowUp`');

-- lead_activities: filter by lead
CALL add_index_if_missing('lead_activities', 'lead_activities_leadId_idx', '`leadId`');

-- schedules: filter by user, campaign, status
CALL add_index_if_missing('schedules', 'schedules_userId_idx', '`userId`');
CALL add_index_if_missing('schedules', 'schedules_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('schedules', 'schedules_status_idx', '`status`');

-- automations: filter by user
CALL add_index_if_missing('automations', 'automations_userId_idx', '`userId`');

-- analytics: filter by user, campaign, metricType, date
CALL add_index_if_missing('analytics', 'analytics_userId_idx', '`userId`');
CALL add_index_if_missing('analytics', 'analytics_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('analytics', 'analytics_metricType_idx', '`metricType`');
CALL add_index_if_missing('analytics', 'analytics_date_idx', '`date`');

-- templates: filter by user, category
CALL add_index_if_missing('templates', 'templates_userId_idx', '`userId`');
CALL add_index_if_missing('templates', 'templates_category_idx', '`category`');

-- generated_images: filter by user, campaign
CALL add_index_if_missing('generated_images', 'generated_images_userId_idx', '`userId`');
CALL add_index_if_missing('generated_images', 'generated_images_campaignId_idx', '`campaignId`');

-- agent_runs: filter by user, campaign, agentType, status
CALL add_index_if_missing('agent_runs', 'agent_runs_userId_idx', '`userId`');
CALL add_index_if_missing('agent_runs', 'agent_runs_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('agent_runs', 'agent_runs_agentType_idx', '`agentType`');
CALL add_index_if_missing('agent_runs', 'agent_runs_status_idx', '`status`');
CALL add_index_if_missing('agent_runs', 'agent_runs_createdAt_idx', '`createdAt`');

-- approval_requests: filter by user, campaign, status
CALL add_index_if_missing('approval_requests', 'approval_requests_userId_idx', '`userId`');
CALL add_index_if_missing('approval_requests', 'approval_requests_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('approval_requests', 'approval_requests_status_idx', '`status`');

-- campaign_assets: filter by user, campaign
CALL add_index_if_missing('campaign_assets', 'campaign_assets_userId_idx', '`userId`');
CALL add_index_if_missing('campaign_assets', 'campaign_assets_campaignId_idx', '`campaignId`');

-- publishing_queue: filter by user, campaign, status, nextRetryAt
CALL add_index_if_missing('publishing_queue', 'publishing_queue_userId_idx', '`userId`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_status_idx', '`status`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_nextRetryAt_idx', '`nextRetryAt`');
CALL add_index_if_missing('publishing_queue', 'publishing_queue_scheduledAt_idx', '`scheduledAt`');

-- social_integrations: filter by user, platform, status
CALL add_index_if_missing('social_integrations', 'social_integrations_userId_idx', '`userId`');
CALL add_index_if_missing('social_integrations', 'social_integrations_platform_idx', '`platform`');
CALL add_index_if_missing('social_integrations', 'social_integrations_status_idx', '`status`');

-- conversation_threads: filter by user, campaign, lead
CALL add_index_if_missing('conversation_threads', 'conversation_threads_userId_idx', '`userId`');
CALL add_index_if_missing('conversation_threads', 'conversation_threads_campaignId_idx', '`campaignId`');
CALL add_index_if_missing('conversation_threads', 'conversation_threads_leadId_idx', '`leadId`');

-- conversation_messages: filter by thread
CALL add_index_if_missing('conversation_messages', 'conversation_messages_threadId_idx', '`threadId`');

-- optimisation_logs: filter by user, campaign
CALL add_index_if_missing('optimisation_logs', 'optimisation_logs_userId_idx', '`userId`');
CALL add_index_if_missing('optimisation_logs', 'optimisation_logs_campaignId_idx', '`campaignId`');

-- Clean up helper
DROP PROCEDURE IF EXISTS add_index_if_missing;
