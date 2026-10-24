/**
 * Canonical Marketing Action Request Contract (WBS-R5-E1).
 *
 * The typed identity of one marketing action that a downstream system
 * (R5-C autonomous engagement, future streams) asks policy to authorize.
 * This module is pure: no database access, no clock, no randomness, no I/O
 * and no outbound platform call. Every field is validated; unknown action
 * types and malformed identities fail closed at the boundary.
 *
 * Contract guarantees:
 * - Closed vocabularies for action types, platforms and cost classes; the
 *   decision engine fails closed on anything outside them.
 * - The request carries NO risk level, NO decision and NO approval state:
 *   risk is derived server-side from authoritative intelligence and any
 *   client-supplied risk/decision/approval field is rejected so a client can
 *   never self-authorize or self-downgrade risk.
 * - Deterministic request fingerprint: identical material input produces an
 *   identical fingerprint, which anchors the durable policy decision identity
 *   (one action request + one policy version -> one stable decision).
 * - estimateCostClass is caller-advisory only; the decision engine derives
 *   the authoritative cost class from the action type and records a
 *   declaration mismatch rather than trusting the client number.
 */

import { createHash } from "crypto";

/** Closed vocabulary of action types policy governs (R5-E owns this list). */
export const MARKETING_ACTION_TYPES = [
  "observe_only",
  "classify",
  "reply_publicly",
  "reply_privately",
  "react",
  "escalate_to_human",
  "create_opportunity_candidate",
  "schedule_follow_up",
  "nurture_candidate",
  "suppress_action",
] as const;

export type MarketingActionType = (typeof MARKETING_ACTION_TYPES)[number];

const MARKETING_ACTION_TYPE_SET: ReadonlySet<string> = new Set(MARKETING_ACTION_TYPES);

/**
 * Platforms align with the social_integrations platform enum. Policy never
 * widens this list; an unsupported platform fails closed.
 */
export const MARKETING_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "twitter",
  "whatsapp",
  "email",
] as const;

export type MarketingPlatform = (typeof MARKETING_PLATFORMS)[number];

const MARKETING_PLATFORM_SET: ReadonlySet<string> = new Set(MARKETING_PLATFORMS);

/** Advisory cost classes. The authoritative per-type credit map lives here. */
export const ESTIMATED_COST_CLASSES = ["none", "low", "standard", "high"] as const;

export type EstimatedCostClass = (typeof ESTIMATED_COST_CLASSES)[number];

const ESTIMATED_COST_CLASS_SET: ReadonlySet<string> = new Set(ESTIMATED_COST_CLASSES);

/**
 * Authoritative credit estimate per action type. Policy cost eligibility uses
 * this map — never a client-supplied number — so a forged estimate cannot
 * widen or narrow budget authority.
 */
export const ACTION_COST_CREDITS: Readonly<Record<MarketingActionType, number>> = {
  observe_only: 0,
  classify: 0,
  reply_publicly: 1,
  reply_privately: 1,
  react: 0,
  escalate_to_human: 0,
  create_opportunity_candidate: 0,
  schedule_follow_up: 0,
  nurture_candidate: 5,
  suppress_action: 0,
};

/** True when executing the action can incur a provider/AI charge. */
export function isBillableAction(actionType: MarketingActionType): boolean {
  return ACTION_COST_CREDITS[actionType] > 0;
}

/** True when the action requires a verified, capable provider binding. */
export function requiresProviderCapability(actionType: MarketingActionType): boolean {
  return (
    actionType === "reply_publicly" ||
    actionType === "reply_privately" ||
    actionType === "react" ||
    actionType === "nurture_candidate"
  );
}

/** Server-verified provider account binding reference. */
export interface ProviderAccountBindingRef {
  /** social_integrations row id, verified server-side for ownership+status. */
  integrationId: number;
  platform: MarketingPlatform;
  /** Optional provider-side account reference (page id, handle). Never a token. */
  externalAccountRef: string | null;
}

/**
 * Canonical marketing action request. `requestedAt` is caller-supplied and
 * explicit; this module never invents timestamps.
 */
export interface MarketingActionRequest {
  /** Durable id supplied by the upstream system for this logical action. */
  actionRequestId: string;
  /** Owning business. Ownership is re-verified server-side on every use. */
  businessId: number;
  /** R5-A social listening signal reference (opaque id, may be null). */
  sourceSignalId: string | null;
  /** R5-B interpretation reference the risk classification is derived from. */
  sourceInterpretationId: string | null;
  actionType: MarketingActionType;
  platform: MarketingPlatform;
  providerAccountBinding: ProviderAccountBindingRef | null;
  /** Campaign/publication references where applicable. */
  campaignId: number | null;
  publicationId: number | null;
  /** Caller-advisory cost class; authoritative class is derived per type. */
  estimatedCostClass: EstimatedCostClass;
  /** Explicit ISO 8601 request time. */
  requestedAt: string;
  /**
   * Fingerprint of the content/context being acted on (e.g. hash of the
   * proposed reply + interpretation version). Approval bindings pin this so
   * changed content invalidates a stale authorization.
   */
  contextVersion: string;
}

export type MarketingActionRequestInput = MarketingActionRequest;

export class ActionRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionRequestError";
    this.code = code;
  }
}

const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

const ACTION_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function fail(code: string, message: string): never {
  throw new ActionRequestError(code, message);
}

function assertActionRequestId(value: unknown): string {
  if (typeof value !== "string") {
    fail("INVALID_ACTION_REQUEST_ID", `actionRequestId must be a string, got ${String(value)}.`);
  }
  const trimmed = value.trim();
  if (!ACTION_REQUEST_ID_PATTERN.test(trimmed)) {
    fail(
      "INVALID_ACTION_REQUEST_ID",
      `actionRequestId must match ${ACTION_REQUEST_ID_PATTERN}; got ${JSON.stringify(value)}.`
    );
  }
  return trimmed;
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail("INVALID_ACTION_REQUEST_FIELD", `${field} must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

function assertNullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return assertPositiveInt(value, field);
}

function assertNullableIdString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
    fail("INVALID_ACTION_REQUEST_FIELD", `${field} must be a non-blank string <= 128 chars or null.`);
  }
  return value.trim();
}

function assertIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail("INVALID_ACTION_REQUEST_FIELD", `${field} must be an explicit ISO 8601 timestamp.`);
  }
  const trimmed = value.trim();
  if (!ISO_8601_STRICT.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    fail("INVALID_ACTION_REQUEST_FIELD", `${field} must be a valid ISO 8601 timestamp; got ${JSON.stringify(value)}.`);
  }
  return trimmed;
}

function assertMember<K extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): K {
  if (typeof value !== "string" || !allowed.has(value.trim())) {
    fail(
      "INVALID_ACTION_REQUEST_FIELD",
      `${field} must be one of ${Array.from(allowed).join(", ")}; got ${JSON.stringify(value)}.`
    );
  }
  return value.trim() as K;
}

function assertContextVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
    fail(
      "INVALID_ACTION_REQUEST_FIELD",
      "contextVersion must be a non-blank fingerprint string <= 128 chars."
    );
  }
  return value.trim();
}

function assertProviderBinding(value: unknown): ProviderAccountBindingRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_PROVIDER_BINDING", "providerAccountBinding must be an object or null.");
  }
  const binding = value as Record<string, unknown>;
  const integrationId = assertPositiveInt(binding.integrationId, "providerAccountBinding.integrationId");
  const platform = assertMember<MarketingPlatform>(
    binding.platform,
    MARKETING_PLATFORM_SET,
    "providerAccountBinding.platform"
  );
  const externalAccountRef =
    binding.externalAccountRef === null || binding.externalAccountRef === undefined
      ? null
      : assertNullableIdString(binding.externalAccountRef, "providerAccountBinding.externalAccountRef");
  return { integrationId, platform, externalAccountRef };
}

function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  // Fail closed: any attempt to smuggle decision authority is rejected, never
  // silently ignored — silent ignoring would hide an attacker's probe.
  const forbidden = ["riskClass", "risk", "riskLevel", "decision", "approvalRequired", "approvalStatus", "approved", "authorized", "policyVersion", "costEligible", "rateEligible"];
  for (const key of forbidden) {
    if (key in input) {
      fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", `Field "${key}" is server-side authority and must never be client-supplied.`);
    }
  }
}

/**
 * Validate and normalize an action request. Throws ActionRequestError on any
 * malformed, unknown-vocabulary or authority-smuggling input (fail closed).
 */
export function buildMarketingActionRequest(input: MarketingActionRequestInput): MarketingActionRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_ACTION_REQUEST", "Action request must be a structured object.");
  }
  const raw = input as unknown as Record<string, unknown>;
  assertNoClientAuthorityFields(raw);

  const actionType = assertMember<MarketingActionType>(raw.actionType, MARKETING_ACTION_TYPE_SET, "actionType");
  const platform = assertMember<MarketingPlatform>(raw.platform, MARKETING_PLATFORM_SET, "platform");
  const estimatedCostClass = assertMember<EstimatedCostClass>(
    raw.estimatedCostClass,
    ESTIMATED_COST_CLASS_SET,
    "estimatedCostClass"
  );

  const binding = assertProviderBinding(raw.providerAccountBinding);
  if (requiresProviderCapability(actionType) && binding === null) {
    fail(
      "INVALID_PROVIDER_BINDING",
      `Action type "${actionType}" requires a providerAccountBinding; null binding fails closed.`
    );
  }
  if (binding !== null && binding.platform !== platform) {
    fail(
      "INVALID_PROVIDER_BINDING",
      `providerAccountBinding.platform (${binding.platform}) must match the request platform (${platform}).`
    );
  }

  return {
    actionRequestId: assertActionRequestId(raw.actionRequestId),
    businessId: assertPositiveInt(raw.businessId, "businessId"),
    sourceSignalId: assertNullableIdString(raw.sourceSignalId, "sourceSignalId"),
    sourceInterpretationId: assertNullableIdString(raw.sourceInterpretationId, "sourceInterpretationId"),
    actionType,
    platform,
    providerAccountBinding: binding,
    campaignId: assertNullablePositiveInt(raw.campaignId, "campaignId"),
    publicationId: assertNullablePositiveInt(raw.publicationId, "publicationId"),
    estimatedCostClass,
    requestedAt: assertIsoTimestamp(raw.requestedAt, "requestedAt"),
    contextVersion: assertContextVersion(raw.contextVersion),
  };
}

/** The derived (authoritative) cost class for an action type. */
export function deriveCostClass(actionType: MarketingActionType): EstimatedCostClass {
  const credits = ACTION_COST_CREDITS[actionType];
  if (credits === 0) return "none";
  if (credits <= 1) return "low";
  if (credits <= 5) return "standard";
  return "high";
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Deterministic fingerprint of the material request fields. Identity excludes
 * requestedAt (a retry may legitimately re-stamp time) so a replayed logical
 * action converges on the same decision identity.
 */
export function buildActionRequestFingerprint(request: MarketingActionRequest): string {
  return createHash("sha256")
    .update(
      canonicalize({
        actionRequestId: request.actionRequestId,
        businessId: request.businessId,
        sourceSignalId: request.sourceSignalId,
        sourceInterpretationId: request.sourceInterpretationId,
        actionType: request.actionType,
        platform: request.platform,
        providerAccountBinding: request.providerAccountBinding,
        campaignId: request.campaignId,
        publicationId: request.publicationId,
        contextVersion: request.contextVersion,
      }),
      "utf8"
    )
    .digest("hex");
}

/**
 * True when two requests share an actionRequestId but differ in material
 * identity — a tampered replay. The decision engine fails closed on this.
 */
export function isActionRequestIdentityConflict(
  a: MarketingActionRequest,
  b: MarketingActionRequest
): boolean {
  return a.actionRequestId === b.actionRequestId && buildActionRequestFingerprint(a) !== buildActionRequestFingerprint(b);
}
