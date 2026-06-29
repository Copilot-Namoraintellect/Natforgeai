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
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

function redact(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // Redact obvious secrets / tokens / URLs with credentials
  return value
    .replace(/([?&])(api[_-]?key|token|password|secret|authorization)=([^&]+)/gi, "$1$2=***")
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, "***")
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, "$1***");
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("credential")
    ) {
      out[key] = "***";
    } else if (typeof value === "string") {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
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
