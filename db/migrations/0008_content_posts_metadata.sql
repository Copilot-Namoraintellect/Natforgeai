-- Add metadata JSON column to content_posts for approval/publishing tracking
ALTER TABLE `content_posts` ADD COLUMN `metadata` json;
