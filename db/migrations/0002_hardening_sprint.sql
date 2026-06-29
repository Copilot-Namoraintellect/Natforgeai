-- Phase 4 Hardening Sprint
-- Adds retry logic, content safety, and publishing state improvements
-- Cloud SQL MySQL 8.4 compatible (idempotent via helper procedures)

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

-- Update publishing_queue status enum (MODIFY is naturally idempotent)
ALTER TABLE `publishing_queue` MODIFY COLUMN `status` enum('draft','pending_approval','approved','published','failed','safety_blocked','retrying') NOT NULL DEFAULT 'draft';

-- Add retry logic fields
CALL add_column_if_missing('publishing_queue', 'retryCount', 'int NOT NULL DEFAULT 0');
CALL add_column_if_missing('publishing_queue', 'maxRetries', 'int NOT NULL DEFAULT 3');
CALL add_column_if_missing('publishing_queue', 'nextRetryAt', 'timestamp NULL DEFAULT NULL');
CALL add_column_if_missing('publishing_queue', 'lastError', 'text');

-- Add content safety fields
CALL add_column_if_missing('publishing_queue', 'safetyStatus', "enum('pending','low','medium','high')");
CALL add_column_if_missing('publishing_queue', 'safetyReasons', 'json');

-- Clean up helper
DROP PROCEDURE IF EXISTS add_column_if_missing;
