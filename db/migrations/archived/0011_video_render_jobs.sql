-- Safe migration: create video_render_jobs table if it does not already exist
-- This table tracks MP4 render jobs created by the local ffmpeg renderer
-- All video status fields on content_posts are stored in the existing JSON metadata column (added in 0008)

CREATE TABLE IF NOT EXISTS `video_render_jobs` (
  `id` int unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `userId` int unsigned NOT NULL,
  `campaignId` int unsigned NOT NULL,
  `contentPostId` int unsigned,
  `provider` varchar(50) NOT NULL DEFAULT 'placeholder',
  `renderJobId` varchar(255),
  `renderStatus` enum('queued','rendering','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  `videoUrl` text,
  `thumbnailUrl` text,
  `errorMessage` text,
  `creditCost` int NOT NULL DEFAULT 0,
  `requestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt` timestamp,
  `createdBy` int unsigned NOT NULL,
  `metadata` json,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
