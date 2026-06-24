-- Migration: System alerts table for production monitoring
-- Created: 2026-06-01
-- Cloud SQL MySQL 8.4 compatible (CREATE TABLE IF NOT EXISTS is supported)

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
