// ─── R8-B Business Change Intelligence — downstream reasoning projection ───
//
// PURE module. Builds the frozen read-only projection through which R8-D/E
// consume business change evidence (`business-change-to-reasoning/v1`, see
// docs/contracts/business-change-to-strategic-reasoning-contract.md).
// Downstream may read and must never mutate; this projection carries no
// execution authority, asserts the verbatim causation disclaimer, emits a
// labelled reference-only memory candidate, and surfaces an advisory
// governance eligibility hint (R8-F remains the sole governance authority).

import type { BusinessChangeStateRef } from "./business-change-identity";
import type {
  BusinessChangeConfidenceClass,
  BusinessChangeDomain,
  BusinessChangeSignificanceClass,
  BusinessChangeStatus,
  BusinessChangeSubjectType,
  BusinessChangeType,
} from "./business-change-contract";
import { deriveGovernanceEligibilityHint } from "./business-change-significance";

export const BUSINESS_CHANGE_PROJECTION_VERSION = "business-change-to-reasoning/v1" as const;

export const BUSINESS_CHANGE_CAUSATION_DISCLAIMER =
  "Business change evidence records that an internal state comparison detected a change between two authoritative states. It does not assert that any marketing activity, attribution credit or optimisation caused the change, and it is not a recommendation to act." as const;

/** Exact top-level key allowlist of the frozen downstream projection. */
export const BUSINESS_CHANGE_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "changeId",
  "businessId",
  "changeDomain",
  "changeType",
  "subjectType",
  "subjectId",
  "previousStateRef",
  "currentStateRef",
  "evidenceRefs",
  "sourceAuthority",
  "sourceVersion",
  "significanceClass",
  "confidenceClass",
  "status",
  "detectedAt",
  "effectiveAt",
  "recordedAt",
  "validUntil",
  "supersedesChangeId",
  "limitations",
  "lifecycle",
  "memoryCandidate",
  "governanceEligibilityHint",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export type BusinessChangeProjectionKey = (typeof BUSINESS_CHANGE_PROJECTION_FIELD_KEYS)[number];

export interface BusinessChangeMemoryCandidate {
  readonly candidateType: "strategic_memory_ingest_candidate";
  readonly suggestedMemoryType: string;
  readonly suggestedSubjectType: string;
  readonly suggestedSubjectId: string;
  readonly statementSummary: string;
  readonly basis: { basisType: string; summary: string } | null;
}

/** Server-derived, advisory only — R8-F remains the governance authority. */
export type GovernanceEligibilityHint =
  | "CONTEXT_ONLY"
  | "REVIEW_ORIENTED"
  | "ELIGIBLE_FOR_GOVERNED_REASONING";

export interface BusinessChangeProjection {
  readonly contractVersion: typeof BUSINESS_CHANGE_PROJECTION_VERSION;
  readonly changeId: string;
  readonly businessId: number;
  readonly changeDomain: BusinessChangeDomain;
  readonly changeType: BusinessChangeType;
  readonly subjectType: BusinessChangeSubjectType;
  readonly subjectId: string;
  readonly previousStateRef: BusinessChangeStateRef;
  readonly currentStateRef: BusinessChangeStateRef;
  readonly evidenceRefs: readonly string[];
  readonly sourceAuthority: string;
  readonly sourceVersion: string;
  readonly significanceClass: BusinessChangeSignificanceClass;
  readonly confidenceClass: BusinessChangeConfidenceClass;
  readonly status: BusinessChangeStatus;
  readonly detectedAt: string;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly validUntil: string | null;
  readonly supersedesChangeId: string | null;
  readonly limitations: readonly string[];
  readonly lifecycle: {
    readonly statuses: readonly string[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly memoryCandidate: BusinessChangeMemoryCandidate | null;
  readonly governanceEligibilityHint: GovernanceEligibilityHint;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
}

export interface ChangeRowLike {
  changeId: string;
  businessId: number | string;
  changeDomain: string;
  changeType: string;
  subjectType: string;
  subjectId: string;
  previousStateRef: unknown;
  currentStateRef: unknown;
  evidenceRefs: unknown;
  sourceAuthority: string;
  sourceVersion: string;
  significanceClass: string;
  confidenceClass: string;
  status: string;
  detectedAt: string;
  effectiveAt: string;
  recordedAt: string;
  validUntil: string | null;
  supersedesChangeId: string | null;
  limitations: unknown;
}

export interface ChangeLifecycleRowLike {
  lifecycleType: string;
  targetStatus: string;
}

/** Server-derived suggested memory type per change domain (candidate only). */
const DOMAIN_MEMORY_CANDIDATE_TYPE: Record<string, string> = {
  BUSINESS_OBJECTIVE: "STRATEGIC_OBJECTIVE",
  PRODUCT_SERVICE: "BUSINESS_FACT",
  AUDIENCE: "BUSINESS_FACT",
  BUDGET: "OPTIMISATION_DECISION",
  CAPABILITY: "BUSINESS_FACT",
  PORTFOLIO_PERFORMANCE: "LEARNING_PATTERN",
  STRATEGIC_CONSTRAINT: "CONSTRAINT",
  RISK_POSTURE: "CONSTRAINT",
};

function buildMemoryCandidate(row: ChangeRowLike): BusinessChangeMemoryCandidate | null {
  const suggestedMemoryType = DOMAIN_MEMORY_CANDIDATE_TYPE[row.changeDomain];
  if (!suggestedMemoryType) return null;
  return Object.freeze({
    candidateType: "strategic_memory_ingest_candidate",
    suggestedMemoryType,
    suggestedSubjectType: row.subjectType,
    suggestedSubjectId: row.subjectId,
    statementSummary: `Change ${row.changeId} (${row.changeType}) on ${row.subjectType}:${row.subjectId}: ${row.changeDomain} — candidate for R8-A ingest; reference-only, never authority.`,
    basis: null,
  });
}

/** Pure projection builder — a deterministic function of the durable row. */
export function buildBusinessChangeProjection(
  row: ChangeRowLike,
  lifecycleRows: readonly ChangeLifecycleRowLike[] = []
): BusinessChangeProjection {
  const statuses = lifecycleRows.map((f) => f.targetStatus);
  const significanceClass = row.significanceClass as BusinessChangeSignificanceClass;
  const confidenceClass = row.confidenceClass as BusinessChangeConfidenceClass;
  return Object.freeze({
    contractVersion: BUSINESS_CHANGE_PROJECTION_VERSION,
    changeId: row.changeId,
    businessId: Number(row.businessId),
    changeDomain: row.changeDomain as BusinessChangeDomain,
    changeType: row.changeType as BusinessChangeType,
    subjectType: row.subjectType as BusinessChangeSubjectType,
    subjectId: row.subjectId,
    previousStateRef: Object.freeze({ ...(row.previousStateRef as BusinessChangeStateRef) }),
    currentStateRef: Object.freeze({ ...(row.currentStateRef as BusinessChangeStateRef) }),
    evidenceRefs: Object.freeze([...(row.evidenceRefs as string[])]),
    sourceAuthority: row.sourceAuthority,
    sourceVersion: row.sourceVersion,
    significanceClass,
    confidenceClass,
    status: row.status as BusinessChangeStatus,
    detectedAt: row.detectedAt,
    effectiveAt: row.effectiveAt,
    recordedAt: row.recordedAt,
    validUntil: row.validUntil ?? null,
    supersedesChangeId: row.supersedesChangeId ?? null,
    limitations: Object.freeze([...(row.limitations as string[])]),
    lifecycle: Object.freeze({
      statuses: Object.freeze(statuses),
      currentStatus: row.status,
      eventCount: lifecycleRows.length,
    }),
    memoryCandidate: buildMemoryCandidate(row),
    governanceEligibilityHint: deriveGovernanceEligibilityHint({ significanceClass, confidenceClass }),
    causationClaimed: false,
    causationDisclaimer: BUSINESS_CHANGE_CAUSATION_DISCLAIMER,
  } satisfies BusinessChangeProjection);
}
