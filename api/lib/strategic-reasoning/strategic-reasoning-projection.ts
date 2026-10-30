// ─── R8-D Strategic Reasoning — downstream projection ───
//
// Frozen read-only projection for R8-E opportunity/risk intelligence
// (docs/contracts/strategic-reasoning-to-opportunity-risk-contract.md).
// 34-key allowlist — asserted exact in acceptance. Verbatim causation /
// attribution / execution disclaimers travel with every projection.
// R8-E may read and must never mutate.

import {
  STRATEGIC_REASONING_ACTIVE_STATUSES,
  STRATEGIC_REASONING_PROJECTION_VERSION,
  type StrategicReasoningStatus,
} from "./strategic-reasoning-contract";
import type { StrategicReasoningRecordRow } from "./strategic-reasoning-store";

export const STRATEGIC_REASONING_CAUSATION_DISCLAIMER =
  "A strategic conclusion is evidence-preserving synthesis, not causal proof. " +
  "This projection does not assert that any marketing activity, attribution credit, " +
  "optimisation, market event or source claim caused any business outcome.";

export const STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER =
  "Attribution-derived evidence is association evidence, not causal proof. " +
  "Credit allocation and channel weights remain R7-B derivations on their own authority.";

export const STRATEGIC_REASONING_EXECUTION_DISCLAIMER =
  "A strategic conclusion recommends attention only. It is never an instruction to " +
  "execute: no campaign, strategy, budget, Business DNA, provider, payment, billing " +
  "or mission state may be mutated from this projection.";

export const STRATEGIC_REASONING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "reasoningId",
  "businessId",
  "evidenceBundleId",
  "hypothesisId",
  "hypothesisType",
  "implicationType",
  "supportingEvidence",
  "contradictingEvidence",
  "missingEvidence",
  "confidenceClass",
  "uncertaintyClasses",
  "strategicRiskClass",
  "status",
  "governanceDecisionId",
  "governanceDecision",
  "approvalStatus",
  "policyVersion",
  "freshness",
  "limitations",
  "sourceVersions",
  "validUntil",
  "supersedesReasoningId",
  "createdAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
] as const;

export type StrategicReasoningProjectionKey = (typeof STRATEGIC_REASONING_PROJECTION_FIELD_KEYS)[number];

export interface StrategicReasoningProjection {
  readonly contractVersion: typeof STRATEGIC_REASONING_PROJECTION_VERSION;
  readonly reasoningId: string;
  readonly businessId: number;
  readonly evidenceBundleId: string;
  readonly hypothesisId: string;
  readonly hypothesisType: string;
  readonly implicationType: string;
  readonly supportingEvidence: unknown;
  readonly contradictingEvidence: unknown;
  readonly missingEvidence: unknown;
  readonly confidenceClass: string;
  readonly uncertaintyClasses: unknown;
  readonly strategicRiskClass: string | null;
  readonly status: StrategicReasoningStatus;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly approvalStatus: "none" | "pending" | "approved" | "rejected";
  readonly policyVersion: string | null;
  readonly freshness: "current" | "stale";
  readonly limitations: unknown;
  readonly sourceVersions: unknown;
  readonly validUntil: string | null;
  readonly supersedesReasoningId: string | null;
  readonly createdAt: string;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
}

export function isActiveReasoningStatus(status: string): boolean {
  return (STRATEGIC_REASONING_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function buildStrategicReasoningProjection(input: {
  row: StrategicReasoningRecordRow;
  approvalStatus: "none" | "pending" | "approved" | "rejected";
  nowMs: number;
}): StrategicReasoningProjection {
  const { row, approvalStatus, nowMs } = input;
  // Approval-derived display state: a REVIEW_REQUIRED conclusion with a valid
  // bound approval reads as APPROVED_RECOMMENDATION (derived, never stored).
  const status: StrategicReasoningStatus =
    row.status === "REVIEW_REQUIRED" && approvalStatus === "approved"
      ? "APPROVED_RECOMMENDATION"
      : (row.status as StrategicReasoningStatus);
  const expired =
    row.validUntil !== null && row.validUntil !== undefined && Date.parse(row.validUntil) < nowMs;
  const freshness = expired ? "stale" : "current";
  const createdAt = (row as { createdAt?: string }).createdAt ?? "";
  return {
    contractVersion: STRATEGIC_REASONING_PROJECTION_VERSION,
    reasoningId: row.reasoningId,
    businessId: row.businessId,
    evidenceBundleId: row.bundleId,
    hypothesisId: row.hypothesisId,
    hypothesisType: row.hypothesisType,
    implicationType: row.implicationType,
    supportingEvidence: row.supportingEvidence,
    contradictingEvidence: row.contradictingEvidence,
    missingEvidence: row.missingEvidence,
    confidenceClass: row.confidenceClass,
    uncertaintyClasses: row.uncertaintyClasses,
    strategicRiskClass: row.strategicRiskClass,
    status,
    governanceDecisionId: row.governanceDecisionId,
    governanceDecision: row.governanceDecision,
    approvalStatus,
    policyVersion: row.policyVersion,
    freshness,
    limitations: row.limitations,
    sourceVersions: row.sourceVersions,
    validUntil: row.validUntil,
    supersedesReasoningId: row.supersedesReasoningId,
    createdAt,
    causationClaimed: false,
    causationDisclaimer: STRATEGIC_REASONING_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: STRATEGIC_REASONING_EXECUTION_DISCLAIMER,
  };
}

/** Seam validator: exact key allowlist + frozen version + disclaimers verbatim. */
export function validateStrategicReasoningProjection(raw: unknown): StrategicReasoningProjection {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("strategic reasoning projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...STRATEGIC_REASONING_PROJECTION_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("strategic reasoning projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== STRATEGIC_REASONING_PROJECTION_VERSION) {
    throw new Error("strategic reasoning projection version mismatch");
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== false || p.executionClaimed !== false) {
    throw new Error("strategic reasoning projection must never claim causation/attribution/execution");
  }
  if (
    p.causationDisclaimer !== STRATEGIC_REASONING_CAUSATION_DISCLAIMER ||
    p.attributionDisclaimer !== STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER ||
    p.executionDisclaimer !== STRATEGIC_REASONING_EXECUTION_DISCLAIMER
  ) {
    throw new Error("strategic reasoning projection disclaimers must be verbatim");
  }
  return raw as unknown as StrategicReasoningProjection;
}
