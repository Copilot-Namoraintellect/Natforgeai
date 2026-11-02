// ─── R10-D Provider & Integration Resilience — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the provider-resilience authority
// (docs/contracts/production-provider-adapter-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// Core authority rules (verbatim on every surface):
//
//   provider response != business truth without validation
//   timeout != failure
//   timeout != success
//   HTTP 200 != necessarily business success
//   provider health != provider-switch authority
//   fallback != authorization to widen scope
//   credential availability != permission
//   integration adapter != governance authority
//
// This stream owns the provider-adapter production contract: declarations,
// exact provider/account binding validation, deterministic request identity,
// conservative result classification, timeout semantics, callback/webhook
// validation + convergence, reconciliation, circuit-breaker state, bounded
// backoff, rate-limit semantics, degraded mode and the read-only health
// handoff for R10-E. It never owns mission objectives, planning, scheduling,
// governance, execution authorization (R9-F), credential administration,
// provider selection policy beyond the exact authorized binding, or any
// billing/CRM/campaign effect.
//
// z.strictObject everywhere: clients name bindings/requests and bounded
// material only — never identity, classifications, circuit state, rate-limit
// state, callback dispositions, reconciliation outcomes or authorization
// material.

import { z } from "zod";

// ─── Versions ───

export const PROVIDER_RESILIENCE_CONTRACT_VERSION =
  "provider-resilience/v1" as const;
export const PROVIDER_RESILIENCE_ENGINE_VERSION =
  "provider-resilience-engine/v1" as const;
export const PROVIDER_HEALTH_PROJECTION_VERSION = "provider-health/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §1). */
export const PROVIDER_RESILIENCE_BOUND_VERSIONS = Object.freeze({
  missionExecution: "mission-execution-coordination/v1",
});

// ─── Verbatim disclaimers preserved on every surface ───

export const PROVIDER_TRUTH_DISCLAIMER =
  "provider response != business truth without validation. Timeout != failure; " +
  "timeout != success; transport success is never automatically business success. " +
  "This surface authorizes nothing upstream and never widens scope.";

export const PROVIDER_HEALTH_DISCLAIMER =
  "provider health != provider-switch authority. Health signals are read-only " +
  "observability for R10-E; they grant no dispatch, fallback, switching or " +
  "reauthorization authority of any kind.";

export const PROVIDER_RESILIENCE_HISTORY_DISCLAIMER =
  "fallback != authorization to widen scope; credential availability != permission; " +
  "integration adapter != governance authority. R9-D execution history is " +
  "immutable input — no R9-D table is ever written by this stream.";

// ─── Identity patterns ───

export const PROVIDER_BINDING_ID_PATTERN = /^pbd1:[a-f0-9]{64}$/;
export const PROVIDER_REQUEST_ID_PATTERN = /^prq1:[a-f0-9]{64}$/;
export const PROVIDER_CALLBACK_ID_PATTERN = /^prcb1:[a-f0-9]{64}$/;
export const PROVIDER_RECONCILIATION_ID_PATTERN = /^prx1:[a-f0-9]{64}$/;
export const PROVIDER_CIRCUIT_ID_PATTERN = /^pcb1:[a-f0-9]{64}$/;
export const EXECUTION_ACTION_ID_PATTERN = /^exa1:[a-f0-9]{64}$/;
export const EXECUTION_ATTEMPT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const INPUT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_#/.-]{0,190}$/;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
export const PROVIDER_ACCOUNT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9:_#/.@-]{0,127}$/;
export const PROVIDER_EVENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9:_#/.@-]{0,190}$/;
export const SIGNATURE_PATTERN = /^[A-Fa-f0-9]{64}$/;

export const MAX_INPUT_REFS = 16;
export const MAX_PARAMETERS_CANONICAL_CHARS = 4096;
export const MAX_PARAMETER_DEPTH = 16;
export const MAX_CALLBACK_PAYLOAD_CHARS = 4096;
export const MAX_SIGNATURE_AGE_MS = 300_000;
export const MAX_HEALTH_SAMPLE_LIMIT = 500;
export const MAX_REASON_CODES = 8;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies ───

/**
 * Conservative provider result classifications (D4). Transport success is
 * never automatically business success; only an explicit, unambiguous
 * terminal success payload classifies SUCCEEDED.
 */
export const PROVIDER_RESULT_CLASSIFICATIONS = [
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "PENDING",
  "UNCERTAIN",
  "RATE_LIMITED",
  "AUTHENTICATION_FAILED",
] as const;
export type ProviderResultClassification =
  (typeof PROVIDER_RESULT_CLASSIFICATIONS)[number];

/** Closed failure classes for classified provider outcomes. */
export const PROVIDER_FAILURE_CLASSES = [
  "NONE",
  "TIMEOUT",
  "CONNECTION_RESET",
  "TRUNCATED_RESPONSE",
  "AMBIGUOUS_RESPONSE",
  "PROVIDER_REJECTED",
  "RATE_LIMITED",
  "AUTHENTICATION",
  "CIRCUIT_OPEN",
  "BINDING_MISMATCH",
  "VALIDATION",
  "INTERNAL",
] as const;
export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/** Circuit-breaker states (D11). The circuit may stop dispatch to an
 *  unhealthy provider/account scope; it may NEVER select a different
 *  provider or account — fallback is never circuit authority. */
export const PROVIDER_CIRCUIT_STATES = ["CLOSED", "OPEN", "HALF_OPEN"] as const;
export type ProviderCircuitState = (typeof PROVIDER_CIRCUIT_STATES)[number];

/** Safe degraded modes (D12). Never silently widen scope. */
export const PROVIDER_DEGRADED_MODES = [
  "NONE",
  "PAUSE_DISPATCH",
  "QUEUE_SAFELY",
  "REMAIN_PENDING",
  "REQUEST_OPERATOR_ATTENTION",
  "REQUIRE_REAUTHORIZATION",
] as const;
export type ProviderDegradedMode = (typeof PROVIDER_DEGRADED_MODES)[number];

/** Durable callback dispositions (D6/D7). */
export const PROVIDER_CALLBACK_DISPOSITIONS = [
  "ACCEPTED_NEW",
  "DUPLICATE_CONVERGED",
  "CONFLICT_QUARANTINED",
  "REJECTED_FORGED",
  "REJECTED_STALE",
  "REJECTED_IDENTITY_MISMATCH",
  "REJECTED_UNKNOWN_REFERENCE",
  "REJECTED_MALFORMED",
] as const;
export type ProviderCallbackDisposition =
  (typeof PROVIDER_CALLBACK_DISPOSITIONS)[number];

/** Reconciliation outcomes (D8). Reconciliation never fabricates provider
 *  evidence: CONFIRMED_* requires adapter-returned evidence; otherwise the
 *  outcome remains STILL_PENDING or UNKNOWN. */
export const PROVIDER_RECONCILIATION_OUTCOMES = [
  "CONFIRMED_SUCCEEDED",
  "CONFIRMED_FAILED",
  "STILL_PENDING",
  "UNKNOWN",
] as const;
export type ProviderReconciliationOutcome =
  (typeof PROVIDER_RECONCILIATION_OUTCOMES)[number];

/** Binding lifecycle (closed). */
export const PROVIDER_BINDING_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;
export type ProviderBindingStatus = (typeof PROVIDER_BINDING_STATUSES)[number];

/** Idempotency support declaration (D3/D1). `server_convergence_only` means
 *  the provider offers no reliable native key: effectively-once is achieved
 *  ONLY by this stream's server-side convergence anchors, and the limitation
 *  is explicit in the declaration + every dispatch receipt. */
export const PROVIDER_IDEMPOTENCY_SUPPORT = [
  "native_key",
  "server_convergence_only",
  "none",
] as const;
export type ProviderIdempotencySupport =
  (typeof PROVIDER_IDEMPOTENCY_SUPPORT)[number];

/** Callback support declaration (D1/D6). */
export const PROVIDER_CALLBACK_SUPPORT = [
  "signed_webhook",
  "unsigned_webhook",
  "polling",
  "none",
] as const;
export type ProviderCallbackSupport =
  (typeof PROVIDER_CALLBACK_SUPPORT)[number];

/** Reconciliation support declaration (D1/D8). */
export const PROVIDER_RECONCILIATION_SUPPORT = [
  "query_api",
  "status_polling",
  "none",
] as const;
export type ProviderReconciliationSupport =
  (typeof PROVIDER_RECONCILIATION_SUPPORT)[number];

/** Rate-limit model declaration (D1/D9). */
export const PROVIDER_RATE_LIMIT_MODEL = [
  "token_bucket",
  "request_window",
  "none",
] as const;
export type ProviderRateLimitModel = (typeof PROVIDER_RATE_LIMIT_MODEL)[number];

/** Timeout model declaration (D1/D5). */
export const PROVIDER_TIMEOUT_MODEL = [
  "connect_and_read",
  "whole_request",
  "none",
] as const;
export type ProviderTimeoutModel = (typeof PROVIDER_TIMEOUT_MODEL)[number];

/** Credential binding type declaration (D1/D13). */
export const PROVIDER_CREDENTIAL_BINDING_TYPE = [
  "server_secret_ref",
  "oauth_binding",
  "mtls_identity",
] as const;
export type ProviderCredentialBindingType =
  (typeof PROVIDER_CREDENTIAL_BINDING_TYPE)[number];

/** Account binding type declaration (D1/D2). */
export const PROVIDER_ACCOUNT_BINDING_TYPE = [
  "account_id",
  "account_handle",
  "workspace_id",
] as const;
export type ProviderAccountBindingType =
  (typeof PROVIDER_ACCOUNT_BINDING_TYPE)[number];

/** Closed health capability vocabulary (D1/D14). */
export const PROVIDER_HEALTH_CAPABILITIES = [
  "availability",
  "latency",
  "timeout_rate",
  "rate_limit_state",
  "authentication_failures",
  "callback_lag",
  "reconciliation_backlog",
  "circuit_state",
] as const;
export type ProviderHealthCapability =
  (typeof PROVIDER_HEALTH_CAPABILITIES)[number];

/** R9-D execution action types admissible for provider binding (closed). */
export const PROVIDER_BOUND_ACTION_TYPES = [
  "EXECUTE_TASK",
  "EXECUTE_STEP",
  "RETRY_STEP",
] as const;
export type ProviderBoundActionType =
  (typeof PROVIDER_BOUND_ACTION_TYPES)[number];

/** Closed execution capabilities a binding may carry (R9-D vocabulary). */
export const PROVIDER_BINDING_CAPABILITIES = [
  "campaign.activate",
  "content.dispatch",
  "social.publish",
  "crm.record",
  "notification.send",
  "analytics.record",
  "workflow.run",
] as const;
export type ProviderBindingCapability =
  (typeof PROVIDER_BINDING_CAPABILITIES)[number];

/** Dispatch request lifecycle states (closed, insert-first + CAS). */
export const PROVIDER_DISPATCH_STATES = [
  "PREPARED",
  "DISPATCHED",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
  "RATE_LIMITED",
  "AUTHENTICATION_FAILED",
  "CIRCUIT_BLOCKED",
  "PENDING",
] as const;
export type ProviderDispatchState = (typeof PROVIDER_DISPATCH_STATES)[number];

/** Circuit outcomes counted as provider-scope failures (D11, closed). */
export const PROVIDER_CIRCUIT_FAILURE_CLASSES = [
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "AUTHENTICATION_FAILED",
  "TIMEOUT",
  "CONNECTION_RESET",
  "UNCERTAIN",
] as const;

/** Circuit outcomes that are neutral (never open a circuit). */
export const PROVIDER_CIRCUIT_NEUTRAL_CLASSES = [
  "RATE_LIMITED",
  "PENDING",
] as const;

// ─── Typed error taxonomy (closed codes) ───

export type ProviderErrorCode =
  | "PROVIDER_INPUT_MALFORMED"
  | "PROVIDER_CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "SECRET_MATERIAL_REJECTED"
  | "PROVIDER_UNDECLARED"
  | "PROVIDER_CAPABILITY_UNDECLARED"
  | "PROVIDER_CAPABILITY_UNSUPPORTED"
  | "PROVIDER_DECLARATION_INVALID"
  | "CREDENTIAL_UNAVAILABLE"
  | "BINDING_NOT_FOUND"
  | "BINDING_NOT_ACTIVE"
  | "CROSS_TENANT_BINDING"
  | "CROSS_BUSINESS_BINDING"
  | "BINDING_MISMATCH"
  | "EXECUTION_AUTHORITY_UNAVAILABLE"
  | "EXECUTION_ACTION_NOT_FOUND"
  | "EXECUTION_ATTEMPT_NOT_FOUND"
  | "EXECUTION_ACTION_NOT_DISPATCHABLE"
  | "PROVIDER_REPLAY_CONFLICT"
  | "PROVIDER_TAMPER"
  | "PROVIDER_REQUEST_NOT_FOUND"
  | "PROVIDER_CIRCUIT_OPEN"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_RECONCILIATION_UNAVAILABLE"
  | "PROVIDER_RECONCILIATION_CONFLICT"
  | "CALLBACK_VALIDATION_FAILED"
  | "DEGRADED_MODE_REQUIRED";

// ─── Exported code constants (stable references for store/service modules) ───

export const PROVIDER_INPUT_MALFORMED = "PROVIDER_INPUT_MALFORMED" as const;
export const PROVIDER_CLIENT_AUTHORITY_FIELD_FORBIDDEN =
  "PROVIDER_CLIENT_AUTHORITY_FIELD_FORBIDDEN" as const;
export const SECRET_MATERIAL_REJECTED = "SECRET_MATERIAL_REJECTED" as const;
export const PROVIDER_UNDECLARED = "PROVIDER_UNDECLARED" as const;
export const PROVIDER_CAPABILITY_UNDECLARED =
  "PROVIDER_CAPABILITY_UNDECLARED" as const;
export const PROVIDER_CAPABILITY_UNSUPPORTED =
  "PROVIDER_CAPABILITY_UNSUPPORTED" as const;
export const PROVIDER_DECLARATION_INVALID =
  "PROVIDER_DECLARATION_INVALID" as const;
export const CREDENTIAL_UNAVAILABLE = "CREDENTIAL_UNAVAILABLE" as const;
export const BINDING_NOT_FOUND = "BINDING_NOT_FOUND" as const;
export const BINDING_NOT_ACTIVE = "BINDING_NOT_ACTIVE" as const;
export const CROSS_TENANT_BINDING = "CROSS_TENANT_BINDING" as const;
export const CROSS_BUSINESS_BINDING = "CROSS_BUSINESS_BINDING" as const;
export const BINDING_MISMATCH = "BINDING_MISMATCH" as const;
export const EXECUTION_AUTHORITY_UNAVAILABLE =
  "EXECUTION_AUTHORITY_UNAVAILABLE" as const;
export const EXECUTION_ACTION_NOT_FOUND = "EXECUTION_ACTION_NOT_FOUND" as const;
export const EXECUTION_ATTEMPT_NOT_FOUND =
  "EXECUTION_ATTEMPT_NOT_FOUND" as const;
export const EXECUTION_ACTION_NOT_DISPATCHABLE =
  "EXECUTION_ACTION_NOT_DISPATCHABLE" as const;
export const PROVIDER_REPLAY_CONFLICT = "PROVIDER_REPLAY_CONFLICT" as const;
export const PROVIDER_TAMPER = "PROVIDER_TAMPER" as const;
export const PROVIDER_REQUEST_NOT_FOUND = "PROVIDER_REQUEST_NOT_FOUND" as const;
export const PROVIDER_CIRCUIT_OPEN = "PROVIDER_CIRCUIT_OPEN" as const;
export const PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED" as const;
export const PROVIDER_RECONCILIATION_UNAVAILABLE =
  "PROVIDER_RECONCILIATION_UNAVAILABLE" as const;
export const PROVIDER_RECONCILIATION_CONFLICT =
  "PROVIDER_RECONCILIATION_CONFLICT" as const;
export const CALLBACK_VALIDATION_FAILED = "CALLBACK_VALIDATION_FAILED" as const;
export const DEGRADED_MODE_REQUIRED = "DEGRADED_MODE_REQUIRED" as const;

export class ProviderResilienceError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderResilienceError";
    this.code = code;
  }
}

/** Malformed/unknown input at the strict boundary (mapped BAD_REQUEST). */
export class ProviderInputError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderInputError";
  }
}

/** Cross-tenant / cross-business scope (mapped FORBIDDEN). */
export class ProviderOwnershipError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderOwnershipError";
  }
}

/** Upstream (R9-D) seam validation failure (mapped BAD_REQUEST). */
export class ProviderUpstreamError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderUpstreamError";
  }
}

/** Same convergence anchor replayed with conflicting material (CONFLICT). */
export class ProviderIdentityConflictError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderIdentityConflictError";
  }
}

/** Optimistic-CAS stale write (CONFLICT). */
export class ProviderStateConflictError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderStateConflictError";
  }
}

/** Immutable-row hash drift = tampering (CONFLICT). */
export class ProviderTamperError extends ProviderResilienceError {
  constructor(code: ProviderErrorCode, message: string) {
    super(code, message);
    this.name = "ProviderTamperError";
  }
}

export function failProvider(code: ProviderErrorCode, message: string): never {
  throw new ProviderInputError(code, message);
}

// ─── Client-authority smuggling rejection (D16) ───

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "requestId",
  "requestIdentity",
  "callbackId",
  "reconciliationId",
  "circuitId",
  "circuitState",
  "classification",
  "classifiedResult",
  "resultClassification",
  "failureClass",
  "degradedMode",
  "disposition",
  "reconciliationOutcome",
  "state",
  "status",
  "bindingStatus",
  "version",
  "fingerprint",
  "evidenceHash",
  "payloadHash",
  "signatureValid",
  "nativeIdempotencyKey",
  "credentialFingerprint",
  "authorization",
  "authority",
  "authorized",
  "approval",
  "approved",
  "decision",
  "override",
  "force",
  "forceDispatch",
  "execute",
  "run",
  "dispatch",
  "fallback",
  "fallbackProvider",
  "switchProvider",
  "switchAccount",
  "bypass",
  "bypassCircuitBreaker",
  "bypassRateLimit",
  "retry",
  "retryNow",
  "provider",
  "providerId",
  "providerAccount",
  "providerAccountId",
  "account",
  "accountId",
  "url",
  "endpoint",
  "baseUrl",
  "webhook",
  "callbackUrl",
  "command",
  "shell",
  "exec",
  "sudo",
  "sql",
  "query",
  "statement",
  "database",
  "module",
  "tool",
  "toolName",
  "function",
  "credentials",
  "credential",
  "credentialRef",
  "apiKey",
  "apiKeyV2",
  "secret",
  "secretKey",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "clientSecret",
  "privateKey",
  "session",
  "certificate",
  "privateKeyPem",
] as const;

const SECRET_KEY_PATTERN =
  /^(api[_-]?key|apikeyv?\d*|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|credential(s)?|certificate|session|bearer|authorization)$/i;

/** First forbidden client-authority field present in a raw input object. */
export function findForbiddenField(
  input: Record<string, unknown>
): string | null {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) return key;
  }
  return null;
}

/** Deep secret-key scan over bounded JSON material (D13/D16). */
export function findSecretKey(value: unknown, depth = 0): string | null {
  if (
    value === null ||
    typeof value !== "object" ||
    depth > MAX_PARAMETER_DEPTH
  )
    return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (SECRET_KEY_PATTERN.test(key)) return key;
    const hit = findSecretKey(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ─── zod input schemas (strictObject — clients never supply authority) ───

/** Bounded, JSON-safe, secret-free dispatch material. Validated strictly. */
export const providerParametersSchema = z.unknown().transform((value, ctxx) => {
  if (value === undefined) return {};
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (typeof v === "number") return Number.isFinite(v);
    if (v === null || typeof v === "boolean" || typeof v === "string") {
      return true;
    }
    if (
      typeof v !== "object" ||
      depth > MAX_PARAMETER_DEPTH ||
      seen.has(v as object)
    )
      return false;
    seen.add(v as object);
    if (Array.isArray(v)) return v.every(item => walk(item, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype) return false;
    return Object.entries(v as Record<string, unknown>).every(
      ([key, item]) =>
        !SECRET_KEY_PATTERN.test(key) &&
        !["__proto__", "constructor", "prototype"].includes(key) &&
        !FORBIDDEN_CLIENT_AUTHORITY_FIELDS.includes(key as any) &&
        walk(item, depth + 1)
    );
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !walk(value, 0) ||
    JSON.stringify(value).length > MAX_PARAMETERS_CANONICAL_CHARS
  ) {
    ctxx.addIssue({
      code: "custom",
      message: "parameters must be bounded acyclic JSON material",
    });
    return z.NEVER;
  }
  return value as Record<string, unknown>;
});

export const registerProviderBindingSchema = z.strictObject({
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
  providerAccountId: z.string().regex(PROVIDER_ACCOUNT_ID_PATTERN),
  capability: z.enum(PROVIDER_BINDING_CAPABILITIES),
  actionType: z.enum(PROVIDER_BOUND_ACTION_TYPES),
  /** Optional bounded non-secret display label; never credential material. */
  label: z.string().min(1).max(64).optional(),
});

export type RegisterProviderBindingInput = z.infer<
  typeof registerProviderBindingSchema
>;

export const getProviderBindingSchema = z.strictObject({
  bindingId: z.string().regex(PROVIDER_BINDING_ID_PATTERN),
});

export const listProviderBindingsSchema = z.strictObject({
  providerId: z.string().regex(PROVIDER_ID_PATTERN).optional(),
  status: z.enum(PROVIDER_BINDING_STATUSES).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const revokeProviderBindingSchema = z.strictObject({
  bindingId: z.string().regex(PROVIDER_BINDING_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
});

export const dispatchProviderRequestSchema = z.strictObject({
  bindingId: z.string().regex(PROVIDER_BINDING_ID_PATTERN),
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
  attemptId: z.string().regex(EXECUTION_ATTEMPT_ID_PATTERN),
  parameters: providerParametersSchema,
  inputRefs: z
    .array(z.string().regex(INPUT_REF_PATTERN))
    .max(MAX_INPUT_REFS)
    .optional(),
});

export type DispatchProviderRequestInput = z.infer<
  typeof dispatchProviderRequestSchema
>;

export const getProviderDispatchSchema = z.strictObject({
  requestId: z.string().regex(PROVIDER_REQUEST_ID_PATTERN),
});

export const listProviderDispatchesSchema = z.strictObject({
  bindingId: z.string().regex(PROVIDER_BINDING_ID_PATTERN).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const ingestProviderCallbackSchema = z.strictObject({
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
  providerAccountId: z.string().regex(PROVIDER_ACCOUNT_ID_PATTERN),
  providerEventId: z.string().regex(PROVIDER_EVENT_ID_PATTERN),
  occurredAt: z.string().regex(ISO_UTC_PATTERN),
  /** HMAC-SHA256(providerId|providerAccountId|providerEventId|occurredAt|payload). */
  signature: z.string().regex(SIGNATURE_PATTERN),
  /** Bounded, JSON-safe, secret-free callback payload. */
  payload: z.unknown(),
});

export type IngestProviderCallbackInput = z.infer<
  typeof ingestProviderCallbackSchema
>;

export const reconcileProviderRequestSchema = z.strictObject({
  requestId: z.string().regex(PROVIDER_REQUEST_ID_PATTERN),
});

export const getProviderHealthSchema = z.strictObject({
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
  providerAccountId: z.string().regex(PROVIDER_ACCOUNT_ID_PATTERN).optional(),
});
