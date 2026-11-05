/**
 * Minimal structured logger for the backend.
 * Emits single-line JSON-ish objects so PM2 / systemd logs are easy to grep
 * and ship without pulling in a heavy logging library.
 *
 * Rules:
 * - Never log secrets, tokens, passwords, or full request bodies.
 * - Prefer explicit fields (campaignId, userId, stage, provider, error) over
 *   interpolated strings.
 * - Keep message short and put details in fields.
 *
 * R10-F: sanitization delegates to the shared production-security redaction
 * module so log, error, callback and diagnostics surfaces cannot drift
 * apart from the audit taxonomy.
 */

import { redactForLog } from "./production-security";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

function sanitize(fields: LogFields): LogFields {
  return redactForLog(fields);
}

export function log(level: LogLevel, message: string, fields: LogFields = {}) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitize(fields),
  };
  if (level === "error") {
    console.error(JSON.stringify(line));
  } else if (level === "warn") {
    console.warn(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export function logDebug(message: string, fields?: LogFields) {
  log("debug", message, fields);
}

export function logInfo(message: string, fields?: LogFields) {
  log("info", message, fields);
}

export function logWarn(message: string, fields?: LogFields) {
  log("warn", message, fields);
}

export function logError(message: string, fields?: LogFields) {
  log("error", message, fields);
}
