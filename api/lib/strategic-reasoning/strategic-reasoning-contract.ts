// ─── R8-D Strategic Reasoning — contract ───
//
// Closed vocabularies, identity patterns, error taxonomy and zod router-input
// schemas for the strategic-reasoning capability. Canonical contract:
// docs/contracts/strategic-reasoning-contract.md. Frozen upstream authorities
// (consumed by branch ref only): R8-A strategic memory (23d0f22), R8-B
// business change (055eece), R8-C external signals (b366c5e), R8-F strategic
// governance (44118e3), R7 business optimisation (a2c084a).
//
// z.strictObject everywhere: clients supply evidence reference ids and
// business scope only — never decisions, confidence, risk, trust, status,
// approvals, fingerprints, policy or graph material.

import { createHash } from "crypto";
import { z } from "zod";

// ─── Versions ───

export const STRATEGIC_REASONING_CONTRACT_VERSION = "strategic-reasoning/v1" as const;
export const STRATEGIC_REASONING_ENGINE_VERSION = "strategic-reasoning-engine/v1" as const;
export const STRATEGIC_REASONING_PROJECTION_VERSION =
  "strategic-reasoning-to-opportunity-risk/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §14). */
export const STRATEGIC_REASONING_BOUND_VERSIONS = Object.freeze({
  strategicMemory: "strategic-memory-to-reasoning/v1",
  businessChange: "business-change-to-reasoning/v1",
  externalSignal: "external-signal/v1",
  strategicGovernance: "strategic-governance/v1",
});

// ─── Identity patterns ───

export const REASONING_ID_PATTERN = /^rsn1:[a-f0-9]{64}$/;
export const EVIDENCE_BUNDLE_ID_PATTERN = /^evb1:[a-f0-9]{64}$/;
export const HYPOTHESIS_ID_PATTERN = /^hyp1:[a-f0-9]{64}$/;
export const LIFECYCLE_EVENT_ID_PATTERN = /^srl1:[a-f0-9]{64}$/;

export const MEMORY_REF_PATTERN = /^mem1:[a-f0-9]{64}$/;
export const CHANGE_REF_PATTERN = /^chg1:[a-f0-9]{64}$/;
export const SIGNAL_REF_PATTERN = /^xsig1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^sgd1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

// ─── Closed vocabularies ───

export const STRATEGIC_HYPOTHESIS_TYPES = [
  "MARKET_SHIFT",
  "DEMAND_CHANGE",
  "COMPETITIVE_PRESSURE",
  "BUSINESS_CAPABILITY_GAP",
  "STRATEGIC_ALIGNMENT",
  "RESOURCE_MISMATCH",
  "GROWTH_SIGNAL",
  "DECLINE_SIGNAL",
  "POSITIONING_SIGNAL",
  "REGULATORY_IMPLICATION",
  "TECHNOLOGY_IMPLICATION",
  "NO_ACTIONABLE_CONCLUSION",
] as const;
export type StrategicHypothesisType = (typeof STRATEGIC_HYPOTHESIS_TYPES)[number];

export const STRATEGIC_IMPLICATION_TYPES = [
  "MONITOR",
  "INVESTIGATE",
  "VALIDATE_ASSUMPTION",
  "REVIEW_POSITIONING",
  "REVIEW_RESOURCE_PRIORITY",
  "REVIEW_CHANNEL_STRATEGY",
  "REVIEW_PRODUCT_MARKETING",
  "REVIEW_MARKET_RESPONSE",
  "NO_ACTION",
] as const;
export type StrategicImplicationType = (typeof STRATEGIC_IMPLICATION_TYPES)[number];

export const STRATEGIC_CONFIDENCE_CLASSES = [
  "INSUFFICIENT",
  "LOW",
  "MODERATE",
  "HIGH",
] as const;
export type StrategicConfidenceClass = (typeof STRATEGIC_CONFIDENCE_CLASSES)[number];

export const STRATEGIC_UNCERTAINTY_CLASSES = [
  "WEAK_EVIDENCE",
  "STALE_EVIDENCE",
  "CONFLICTING_EVIDENCE",
  "SINGLE_EXTERNAL_SOURCE",
  "ASSUMPTION_HEAVY",
  "MISSING_INTERNAL_STATE",
] as const;
export type StrategicUncertaintyClass = (typeof STRATEGIC_UNCERTAINTY_CLASSES)[number];

export const STRATEGIC_MISSING_EVIDENCE_CLASSES = [
  "INTERNAL_PERFORMANCE_STATE",
  "ATTRIBUTION_QUALITY",
  "CORROBORATION",
  "CONFLICT_RESOLUTION",
  "FRESH_INTERNAL_STATE",
] as const;
export type StrategicMissingEvidenceClass = (typeof STRATEGIC_MISSING_EVIDENCE_CLASSES)[number];

/** Carried verbatim from the bound R8-F decision — never derived here. */
export const STRATEGIC_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type StrategicRiskClass = (typeof STRATEGIC_RISK_CLASSES)[number];

export const STRATEGIC_REASONING_STATUSES = [
  "CANDIDATE",
  "SUPPORTED",
  "REVIEW_REQUIRED",
  "APPROVED_RECOMMENDATION",
  "BLOCKED",
  "SUPERSEDED",
  "CONTRADICTED",
  "STALE",
  "INVALIDATED",
] as const;
export type StrategicReasoningStatus = (typeof STRATEGIC_REASONING_STATUSES)[number];

/** Active / voiceable conclusions in the downstream handoff projection. */
export const STRATEGIC_REASONING_ACTIVE_STATUSES = [
  "SUPPORTED",
  "APPROVED_RECOMMENDATION",
  "REVIEW_REQUIRED",
] as const;

export const STRATEGIC_REASONING_LIFECYCLE_TYPES = [
  "governance_binding",
  "supersession",
  "contradiction",
  "staleness",
  "invalidation",
] as const;
export type StrategicReasoningLifecycleType = (typeof STRATEGIC_REASONING_LIFECYCLE_TYPES)[number];

export const REASONING_GRAPH_EDGE_TYPES = [
  "SUPPORTS",
  "CONTRADICTS",
  "CONTEXTUALISES",
  "LIMITS",
] as const;
export type ReasoningGraphEdgeType = (typeof REASONING_GRAPH_EDGE_TYPES)[number];

export const STRATEGIC_EVIDENCE_CLASSES = [
  "INTERNAL_MEMORY",
  "INTERNAL_CHANGE",
  "EXTERNAL_SIGNAL",
] as const;
export type StrategicEvidenceClass = (typeof STRATEGIC_EVIDENCE_CLASSES)[number];

export const STRATEGIC_EVIDENCE_ROLES = ["ANCHOR", "SUPPORT", "CONTEXT"] as const;
export type StrategicEvidenceRole = (typeof STRATEGIC_EVIDENCE_ROLES)[number];

/** Closed R8-F decision labels (strategic-governance/v1). */
export const STRATEGIC_GOVERNANCE_DECISIONS = [
  "ALLOW_RECOMMENDATION",
  "REVIEW_REQUIRED",
  "BLOCK",
] as const;
export type StrategicGovernanceDecisionLabel = (typeof STRATEGIC_GOVERNANCE_DECISIONS)[number];

/** Deterministic mapping implication → R8-F closed recommendation taxonomy. */
export const IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE: Record<
  StrategicImplicationType,
  | "STRATEGIC_OBSERVATION"
  | "STRATEGIC_HYPOTHESIS"
  | "MARKET_RESPONSE_RECOMMENDATION"
  | "RESOURCE_PRIORITY_RECOMMENDATION"
  | "CHANNEL_STRATEGY_RECOMMENDATION"
  | "PRODUCT_MARKETING_RECOMMENDATION"
  | null
> = Object.freeze({
  MONITOR: "STRATEGIC_OBSERVATION",
  INVESTIGATE: "STRATEGIC_HYPOTHESIS",
  VALIDATE_ASSUMPTION: "STRATEGIC_HYPOTHESIS",
  REVIEW_POSITIONING: "MARKET_RESPONSE_RECOMMENDATION",
  REVIEW_RESOURCE_PRIORITY: "RESOURCE_PRIORITY_RECOMMENDATION",
  REVIEW_CHANNEL_STRATEGY: "CHANNEL_STRATEGY_RECOMMENDATION",
  REVIEW_PRODUCT_MARKETING: "PRODUCT_MARKETING_RECOMMENDATION",
  REVIEW_MARKET_RESPONSE: "MARKET_RESPONSE_RECOMMENDATION",
  NO_ACTION: null,
});

/** Deterministic R8-D confidence → R8-F claimed-confidence scale. */
export const CONFIDENCE_TO_GOVERNANCE_SCALE: Record<
  StrategicConfidenceClass,
  "NONE" | "LOW" | "MEDIUM" | "HIGH"
> = Object.freeze({
  INSUFFICIENT: "NONE",
  LOW: "LOW",
  MODERATE: "MEDIUM",
  HIGH: "HIGH",
});

// ─── Bounds ───

export const MAX_EVIDENCE_PER_BUNDLE = 64;
export const MAX_GRAPH_EDGES = 256;
export const MAX_GRAPH_DEPTH = 3;
export const MAX_REASON_CODES = 8;
export const MAX_LIMITATIONS = 8;
export const MAX_REFS_PER_CLASS = 32;

// ─── Error taxonomy (fail closed) ───

export const STRATEGIC_REASONING_ERROR_CODES = [
  "OWNERSHIP_MISMATCH",
  "UNKNOWN_EVIDENCE_REFERENCE",
  "EVIDENCE_AUTHORITY_UNAVAILABLE",
  "EVIDENCE_CONTRACT_VERSION_UNSUPPORTED",
  "EVIDENCE_SCOPE_MISMATCH",
  "EVIDENCE_FINGERPRINT_MISMATCH",
  "MALFORMED_EVIDENCE",
  "ZERO_USABLE_EVIDENCE",
  "REASONING_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "REASONING_REPLAY_CONFLICT",
  "REASONING_NOT_FOUND",
  "STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE",
  "GOVERNANCE_DECISION_MALFORMED",
  "APPROVAL_BINDING_MISMATCH",
  "LIFECYCLE_CONFLICT",
  "PROTECTED_TRAIT_MATERIAL_REJECTED",
] as const;
export type StrategicReasoningErrorCode = (typeof STRATEGIC_REASONING_ERROR_CODES)[number];

export class StrategicReasoningError extends Error {
  readonly code: StrategicReasoningErrorCode;
  constructor(code: StrategicReasoningErrorCode, message: string) {
    super(message);
    this.name = "StrategicReasoningError";
    this.code = code;
  }
}

export function fail(code: StrategicReasoningErrorCode, message: string): never {
  throw new StrategicReasoningError(code, message);
}

/** Canonical JSON (key-sorted) for deterministic fingerprints. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

// ─── Client-authority field rejection (contract §9) ───

const CLIENT_AUTHORITY_FIELDS = new Set([
  "decision",
  "reasonCodes",
  "confidenceClass",
  "confidence",
  "uncertaintyClass",
  "uncertaintyClasses",
  "strategicRiskClass",
  "riskClass",
  "sourceTrustClass",
  "trustClass",
  "status",
  "approvalStatus",
  "approved",
  "executable",
  "governanceDecisionId",
  "evidenceFingerprint",
  "reasoningFingerprint",
  "policyVersion",
  "evidenceBundle",
  "reasoningGraph",
  "graph",
  "edges",
  "forceAllow",
  "forceApprove",
  "raiseConfidence",
  "lowerRisk",
  "promoteTrust",
  "setTrusted",
  "suppressContradiction",
  "hideContradiction",
  "overrideDecision",
  "overridePolicy",
]);

/** Reject any client-supplied authority field at the boundary (fail closed). */
export function assertNoClientAuthorityFields(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (CLIENT_AUTHORITY_FIELDS.has(key)) {
      fail(
        "REASONING_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `client-supplied authority field "${key}" is forbidden`
      );
    }
  }
}

// ─── zod router-input schemas ───

export const EvaluateStrategicReasoningInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  memoryRefs: z.array(z.string().regex(MEMORY_REF_PATTERN)).max(MAX_REFS_PER_CLASS).default([]),
  changeRefs: z.array(z.string().regex(CHANGE_REF_PATTERN)).max(MAX_REFS_PER_CLASS).default([]),
  externalSignalRefs: z.array(z.string().regex(SIGNAL_REF_PATTERN)).max(MAX_REFS_PER_CLASS).default([]),
  modelAssistance: z
    .strictObject({
      // Untrusted candidate material only — bounded, revalidated, never
      // authority. Narrative/free text is rejected by construction.
      candidateHypothesisTypes: z.array(z.enum(STRATEGIC_HYPOTHESIS_TYPES)).max(4).optional(),
    })
    .optional(),
});
export type EvaluateStrategicReasoningInput = z.infer<typeof EvaluateStrategicReasoningInputSchema>;

export const GetStrategicReasoningInputSchema = z.strictObject({
  reasoningId: z.string().regex(REASONING_ID_PATTERN),
});
export type GetStrategicReasoningInput = z.infer<typeof GetStrategicReasoningInputSchema>;

export const ListStrategicReasoningInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  status: z.enum(STRATEGIC_REASONING_STATUSES).optional(),
  hypothesisType: z.enum(STRATEGIC_HYPOTHESIS_TYPES).optional(),
});
export type ListStrategicReasoningInput = z.infer<typeof ListStrategicReasoningInputSchema>;

export const ListStrategicReasoningLifecycleInputSchema = z.strictObject({
  reasoningId: z.string().regex(REASONING_ID_PATTERN),
});
export type ListStrategicReasoningLifecycleInput = z.infer<
  typeof ListStrategicReasoningLifecycleInputSchema
>;

export const ReevaluateStrategicReasoningInputSchema = z.strictObject({
  reasoningId: z.string().regex(REASONING_ID_PATTERN),
});
export type ReevaluateStrategicReasoningInput = z.infer<
  typeof ReevaluateStrategicReasoningInputSchema
>;

export const GetStrategicReasoningHandoffInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  includeNonActive: z.boolean().default(false),
});
export type GetStrategicReasoningHandoffInput = z.infer<
  typeof GetStrategicReasoningHandoffInputSchema
>;
