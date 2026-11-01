// ─── R10-E Observability — typed telemetry envelope ───
//
// PURE constructor/validator for the operational telemetry envelope
// (contract §3). No database access, no logging, no clock, no side effects;
// occurredAt/observedAt are caller-supplied explicit timestamps and are never
// invented. Metadata hygiene mirrors the canonical audit envelope: structured
// JSON-like values only, Error objects and class instances rejected,
// secret-shaped keys removed deterministically, keys sorted, depth bounded.
//
// Never stored: secret values, raw credentials, model chain-of-thought,
// unrestricted request/response bodies.

import { createHash } from "crypto";
import {
  DIAGNOSTIC_CODES,
  MAX_SAFE_METADATA_DEPTH,
  MAX_SAFE_METADATA_KEYS,
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_ENVIRONMENTS,
  OBSERVABILITY_PROVIDERS,
  OBSERVABILITY_SEVERITIES,
  OBSERVABILITY_SERVICES,
  OBSERVABILITY_STATUSES,
  OPERATIONAL_EVENT_TYPES,
  ObservabilityInputError,
} from "./observability-contract";

export const OPERATIONAL_EVENT_SCHEMA_VERSION = 1 as const;

export interface OperationalTelemetryEvent {
  readonly schemaVersion: typeof OPERATIONAL_EVENT_SCHEMA_VERSION;
  readonly contractVersion: typeof OBSERVABILITY_CONTRACT_VERSION;
  readonly eventType: (typeof OPERATIONAL_EVENT_TYPES)[number];
  readonly environment: (typeof OBSERVABILITY_ENVIRONMENTS)[number];
  /** Server-resolved release identity; null when unknown — never invented. */
  readonly releaseVersion: string | null;
  readonly service: (typeof OBSERVABILITY_SERVICES)[number];
  readonly component: string;
  readonly operation: string;
  readonly severity: (typeof OBSERVABILITY_SEVERITIES)[number];
  readonly status: (typeof OBSERVABILITY_STATUSES)[number];
  readonly correlationId: string | null;
  readonly tenantId: number | null;
  readonly businessId: number | null;
  readonly missionId: string | null;
  readonly taskId: string | null;
  readonly executionAttemptId: string | null;
  readonly provider: (typeof OBSERVABILITY_PROVIDERS)[number] | null;
  /** Only where safe: job/request id class. Never credentials or raw URLs. */
  readonly providerReference: string | null;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly diagnosticCode: (typeof DIAGNOSTIC_CODES)[number];
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface CreateOperationalTelemetryEventInput {
  eventType: (typeof OPERATIONAL_EVENT_TYPES)[number];
  environment: (typeof OBSERVABILITY_ENVIRONMENTS)[number];
  releaseVersion?: string | null;
  service: (typeof OBSERVABILITY_SERVICES)[number];
  component: string;
  operation: string;
  severity: (typeof OBSERVABILITY_SEVERITIES)[number];
  status: (typeof OBSERVABILITY_STATUSES)[number];
  correlationId?: string | null;
  tenantId?: number | null;
  businessId?: number | null;
  missionId?: string | null;
  taskId?: string | null;
  executionAttemptId?: string | null;
  provider?: (typeof OBSERVABILITY_PROVIDERS)[number] | null;
  providerReference?: string | null;
  occurredAt: string;
  observedAt: string;
  diagnosticCode: (typeof DIAGNOSTIC_CODES)[number];
  safeMetadata?: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") deepFreeze(nested);
    }
  }
  return value;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(OPERATIONAL_EVENT_TYPES);
const SERVICE_SET: ReadonlySet<string> = new Set(OBSERVABILITY_SERVICES);
const PROVIDER_SET: ReadonlySet<string> = new Set(OBSERVABILITY_PROVIDERS);
const SEVERITY_SET: ReadonlySet<string> = new Set(OBSERVABILITY_SEVERITIES);
const STATUS_SET: ReadonlySet<string> = new Set(OBSERVABILITY_STATUSES);
const DIAGNOSTIC_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);
const ENVIRONMENT_SET: ReadonlySet<string> = new Set(OBSERVABILITY_ENVIRONMENTS);

const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

const SECRET_SHAPED_VALUE =
  /sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function memberOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, field: string): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `${field} must be one of the closed vocabulary; got ${JSON.stringify(value)}.`
    );
  }
  return value as T;
}

function boundedLabel(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `${field} must be 1..${max} characters; got ${trimmed.length}.`
    );
  }
  if (SECRET_SHAPED_VALUE.test(trimmed)) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_SECRET_MATERIAL_REJECTED",
      `${field} carries a secret-shaped value and is rejected.`
    );
  }
  return trimmed;
}

function nullableBoundedLabel(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedLabel(value, field, max);
}

function nullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `${field} must be a positive integer or null; got ${String(value)}.`
    );
  }
  return value;
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `${field} must be an explicit ISO-8601 timestamp.`);
  }
  const trimmed = value.trim();
  if (!ISO_8601_STRICT.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `${field} must be an explicit valid ISO-8601 timestamp; got ${JSON.stringify(value)}. Timestamps are never invented.`
    );
  }
  return trimmed;
}

const SENSITIVE_METADATA_KEY =
  /token|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie|private[-_]?key|access[-_]?key/i;

function normalizeMetadataValue(value: unknown, depth: number, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string": {
      if (SECRET_SHAPED_VALUE.test(value)) {
        throw new ObservabilityInputError(
          "OBSERVABILITY_SECRET_MATERIAL_REJECTED",
          `safeMetadata at ${path} carries a secret-shaped value and is rejected.`
        );
      }
      return value;
    }
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `safeMetadata number at ${path} must be finite.`);
      }
      return value;
    case "undefined":
      throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `safeMetadata value at ${path} is undefined.`);
    case "bigint":
    case "symbol":
    case "function":
      throw new ObservabilityInputError(
        "OBSERVABILITY_INVALID_INPUT",
        `safeMetadata value at ${path} has non-structured type "${typeof value}".`
      );
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", `safeMetadata array at ${path} exceeds the bound of 50.`);
    }
    return value.map((item, index) => normalizeMetadataValue(item, depth + 1, `${path}[${index}]`));
  }
  if (value instanceof Error) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `Error objects are not permitted in safeMetadata at ${path}; pass a structured diagnosticCode instead.`
    );
  }
  if (!isPlainObject(value)) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `safeMetadata value at ${path} must be a plain structured object, not a class instance.`
    );
  }
  return normalizeMetadataLevel(value, depth + 1, path);
}

function normalizeMetadataLevel(
  value: Record<string, unknown>,
  depth: number,
  path: string
): Record<string, unknown> {
  if (depth > MAX_SAFE_METADATA_DEPTH) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `safeMetadata exceeds maximum depth of ${MAX_SAFE_METADATA_DEPTH}.`
    );
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_SAFE_METADATA_KEYS) {
    throw new ObservabilityInputError(
      "OBSERVABILITY_INVALID_INPUT",
      `safeMetadata exceeds maximum of ${MAX_SAFE_METADATA_KEYS} keys at ${path}.`
    );
  }
  const sanitized: Record<string, unknown> = {};
  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (key.length === 0) {
      throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", "safeMetadata keys must be non-blank strings.");
    }
    if (SENSITIVE_METADATA_KEY.test(key)) continue; // removed deterministically
    sanitized[key] = normalizeMetadataValue(value[rawKey], depth, path ? `${path}.${key}` : key);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized).sort()) sorted[key] = sanitized[key];
  return sorted;
}

/** Deterministically sanitize safeMetadata: same rules as the audit envelope. */
export function sanitizeSafeMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null || metadata === undefined) return {};
  if (!isPlainObject(metadata)) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", "safeMetadata must be a structured object.");
  }
  return normalizeMetadataLevel(metadata, 1, "");
}

/**
 * Pure constructor/validator for the operational telemetry envelope. Deeply
 * freezes the result; no I/O, no clock, no logging.
 */
export function createOperationalTelemetryEvent(
  input: CreateOperationalTelemetryEventInput
): OperationalTelemetryEvent {
  if (!isPlainObject(input)) {
    throw new ObservabilityInputError("OBSERVABILITY_INVALID_INPUT", "createOperationalTelemetryEvent requires a structured input object.");
  }
  const event: OperationalTelemetryEvent = {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    eventType: memberOf(input.eventType, EVENT_TYPE_SET, "eventType"),
    environment: memberOf(input.environment, ENVIRONMENT_SET, "environment"),
    releaseVersion: nullableBoundedLabel(input.releaseVersion, "releaseVersion", 64),
    service: memberOf(input.service, SERVICE_SET, "service"),
    component: boundedLabel(input.component, "component", 64),
    operation: boundedLabel(input.operation, "operation", 64),
    severity: memberOf(input.severity, SEVERITY_SET, "severity"),
    status: memberOf(input.status, STATUS_SET, "status"),
    correlationId: nullableBoundedLabel(input.correlationId, "correlationId", 64),
    tenantId: nullablePositiveInt(input.tenantId, "tenantId"),
    businessId: nullablePositiveInt(input.businessId, "businessId"),
    missionId: nullableBoundedLabel(input.missionId, "missionId", 69),
    taskId: nullableBoundedLabel(input.taskId, "taskId", 128),
    executionAttemptId: nullableBoundedLabel(input.executionAttemptId, "executionAttemptId", 69),
    provider:
      input.provider === null || input.provider === undefined
        ? null
        : memberOf<(typeof OBSERVABILITY_PROVIDERS)[number]>(input.provider, PROVIDER_SET, "provider"),
    providerReference: nullableBoundedLabel(input.providerReference, "providerReference", 128),
    occurredAt: requireIso(input.occurredAt, "occurredAt"),
    observedAt: requireIso(input.observedAt, "observedAt"),
    diagnosticCode: memberOf(input.diagnosticCode, DIAGNOSTIC_SET, "diagnosticCode"),
    safeMetadata: sanitizeSafeMetadata(input.safeMetadata),
  };
  return deepFreeze(event);
}

/** Deterministic SHA-256 fingerprint of the canonical envelope. */
export function buildOperationalEventFingerprint(event: OperationalTelemetryEvent): string {
  const sorted = Object.fromEntries(
    Object.entries(event).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}
