// ─── R7-D Experimentation Engine — frozen upstream consumption seams ───
//
// R7-D consumes ALL upstream authority EXCLUSIVELY through the frozen
// downstream projections defined by the upstream contracts, consumed from the
// frozen branches by reference — never merged, never imported:
//
//   R7-C  feature/r7-c-business-learning @ 53b2ff4
//         docs/contracts/business-learning-to-experiment-optimisation-contract.md
//         projection "business-learning-to-experiment-optimisation/v1" (23-key allowlist)
//   R7-A  feature/r7-a-conversion-outcome-intelligence @ 3e8aea8
//         projection "conversion-outcome/v1" (28-key allowlist)
//   R7-B  feature/r7-b-attribution-intelligence @ 6ff9eca
//         projection "attribution-to-learning/v1" (25-key allowlist)
//   R7-F  feature/r7-f-optimisation-governance @ 5e4ab95
//         decision record + approval ledger (optimisation-governance/v1)
//
// These seams validate the frozen shapes (exact key set, frozen version,
// verbatim disclaimers, identity patterns) and re-derive nothing. Any
// structural drift fails closed (EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH).
//
// Production reads run against the upstream durable tables behind guarded
// information-schema existence checks — all are stream-local provisional
// artefacts until R7-X convergence. When a table is absent the seam
// fail-closed degrades to "authority unavailable": experiments cannot be
// created/activated and evidence cannot be bound — never fabricated. Tenant
// scope is re-verified on every read (userId predicates), the security intent
// of every upstream handoff contract. R7-X may rewire any port to the
// upstream pure builders without touching this module's consumers.
//
// R7-D never evaluates governance itself: the decision content is consumed
// verbatim from R7-F's durable rows; the execution gate below only verifies
// the consumed decision + approval binding are intact, current and
// tenant-consistent (the same deterministic checks R7-F's
// assertOptimisationActionExecutable performs over its own rows).

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  ExperimentStateError,
  HEX_64,
  LEARNING_ID_PATTERN,
  OUTCOME_ID_PATTERN,
  ATTRIBUTION_ID_PATTERN,
  GOVERNANCE_DECISION_ID_PATTERN,
  EXPERIMENT_SOURCE_VERSION_KEYS,
} from "./experimentation-contract";

// ─── Frozen R7-C learning experiment projection (business-learning-to-experiment-optimisation/v1) ───

export const CONSUMED_LEARNING_PROJECTION_VERSION =
  "business-learning-to-experiment-optimisation/v1" as const;

export const CONSUMED_LEARNING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "learningId",
  "businessId",
  "learningType",
  "subjectType",
  "subjectId",
  "outcomeTypeFamily",
  "contextScope",
  "confidenceClass",
  "evidenceClass",
  "supportCount",
  "contradictionCount",
  "noveltyClass",
  "status",
  "outcomeIds",
  "attributionIds",
  "limitations",
  "derivedAt",
  "validUntil",
  "freshness",
  "governanceAuthorityRequired",
  "causationClaimed",
  "causationDisclaimer",
] as const;

export const CONSUMED_LEARNING_CAUSATION_DISCLAIMER =
  "Learning records are association evidence derived from governed outcomes and attributed journey activity. This projection does not assert that any subject caused any business outcome." as const;

export interface ConsumedLearningFreshness {
  readonly stale: boolean;
  readonly provisional: boolean;
  readonly contradictionUnresolved: boolean;
}

export interface ConsumedLearningProjection {
  readonly contractVersion: typeof CONSUMED_LEARNING_PROJECTION_VERSION;
  readonly learningId: string;
  readonly businessId: number;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcomeTypeFamily: string;
  readonly contextScope: Record<string, unknown>;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly noveltyClass: string;
  readonly status: string;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly limitations: readonly string[];
  readonly derivedAt: string;
  readonly validUntil: string | null;
  readonly freshness: ConsumedLearningFreshness;
  readonly governanceAuthorityRequired: "R7-F";
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
}

// ─── Frozen R7-A outcome projection (conversion-outcome/v1) ───

export const CONSUMED_OUTCOME_PROJECTION_VERSION = "conversion-outcome/v1" as const;

export const CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "outcomeId",
  "businessId",
  "leadId",
  "leadIdentityVersion",
  "conversionId",
  "outcomeType",
  "outcomeStatus",
  "valueType",
  "amountMinor",
  "currency",
  "currencyExponent",
  "quantity",
  "metricUnit",
  "evidenceSource",
  "evidenceAuthority",
  "evidenceIdentity",
  "evidenceHash",
  "occurredAt",
  "recordedAt",
  "reversesOutcomeId",
  "renewsOutcomeId",
  "supersedesOutcomeId",
  "lifecycle",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

export const CONSUMED_OUTCOME_CAUSATION_DISCLAIMER =
  "Outcome evidence only. This projection does not assert that any campaign, publication, opportunity, engagement or marketing activity caused this business outcome." as const;
export const CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER =
  "Outcome evidence does not imply attribution. Credit allocation, causal scores and channel weights are R7-B derivations on their own authority, never derived from this projection's fields." as const;

export interface ConsumedOutcomeProjection {
  readonly contractVersion: typeof CONSUMED_OUTCOME_PROJECTION_VERSION;
  readonly outcomeId: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly leadIdentityVersion: string | null;
  readonly conversionId: string;
  readonly outcomeType: string;
  readonly outcomeStatus: string;
  readonly valueType: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly currencyExponent: number | null;
  readonly quantity: number | null;
  readonly metricUnit: string | null;
  readonly evidenceSource: string;
  readonly evidenceAuthority: string;
  readonly evidenceIdentity: string;
  readonly evidenceHash: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reversesOutcomeId: string | null;
  readonly renewsOutcomeId: string | null;
  readonly supersedesOutcomeId: string | null;
  readonly lifecycle: { readonly statuses: readonly string[]; readonly currentStatus: string };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

// ─── Frozen R7-B attribution learning projection (attribution-to-learning/v1) ───

export const CONSUMED_ATTRIBUTION_PROJECTION_VERSION = "attribution-to-learning/v1" as const;

export const CONSUMED_ATTRIBUTION_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "attributionId",
  "outcomeId",
  "outcomeStatus",
  "outcomeType",
  "businessId",
  "leadId",
  "conversionId",
  "modelType",
  "modelVersion",
  "windowStart",
  "windowEnd",
  "touchpoints",
  "excludedTouchpoints",
  "totalCreditBps",
  "confidenceClass",
  "evidenceClass",
  "policyVersion",
  "sourceVersions",
  "supersedesAttributionId",
  "journeyHash",
  "calculatedAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
] as const;

export const CONSUMED_ATTRIBUTION_CAUSATION_DISCLAIMER =
  "Allocated credit is association evidence, not causal proof. This projection does not assert that any touchpoint caused the business outcome." as const;

export interface ConsumedAttributionProjection {
  readonly contractVersion: typeof CONSUMED_ATTRIBUTION_PROJECTION_VERSION;
  readonly attributionId: string;
  readonly outcomeId: string;
  readonly outcomeStatus: string;
  readonly outcomeType: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly conversionId: string;
  readonly modelType: string;
  readonly modelVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly touchpoints: readonly unknown[];
  readonly excludedTouchpoints: readonly unknown[];
  readonly totalCreditBps: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly policyVersion: string;
  readonly sourceVersions: unknown;
  readonly supersedesAttributionId: string | null;
  readonly journeyHash: string;
  readonly calculatedAt: string;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: true;
}

// ─── Frozen R7-F governance decision + approval shapes (optimisation-governance/v1) ───

export const CONSUMED_GOVERNANCE_CONTRACT_VERSION = "optimisation-governance/v1" as const;

/** Consumed verbatim from optimisation_governance_decisions (R7-F authority). */
export interface ConsumedGovernanceDecision {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  readonly proposalType: string;
  readonly policyVersion: string | null;
  readonly decision: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK";
  readonly reasonCodes: readonly string[];
  readonly riskClass: string;
  readonly financialImpactClass: string;
  readonly financialDeltaMinor: number;
  readonly approvalRequired: boolean;
  readonly approvalBinding: {
    readonly approvalBindingHash: string;
    readonly expiresAt: string;
  } | null;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly createdAt: unknown;
}

/** Consumed approval-row view (approval_requests, approvalType optimisation_action). */
export interface ConsumedApprovalView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: {
    readonly optimisationGovernanceBinding?: {
      readonly governanceDecisionId: string;
      readonly policyVersion: string;
      readonly proposalFingerprint: string;
      readonly approvalBindingHash: string;
      readonly expiresAt: string;
    };
  } | null;
}

export interface ConsumedExecutionVerdict {
  readonly executable: boolean;
  readonly denialReasonCode: string | null;
  readonly authorization: {
    readonly governanceDecisionId: string;
    readonly decision: string;
    readonly approvalRequestId: number | null;
    readonly policyVersion: string;
    readonly authorizedAt: string;
    readonly expiresAt: string;
  } | null;
}

// ─── Strict frozen-shape validators (fail closed on any drift) ───

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeySet(
  raw: Record<string, unknown>,
  allowlist: readonly string[],
  what: string
): void {
  const expected = new Set<string>(allowlist);
  const keys = Object.keys(raw);
  if (keys.length !== allowlist.length || keys.some((k) => !expected.has(k))) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      `${what} key set does not match the frozen allowlist.`
    );
  }
}

const ISO_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

export function validateConsumedLearningProjection(raw: unknown): ConsumedLearningProjection {
  if (!isPlainObject(raw)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Learning projection is not a structured object."
    );
  }
  assertExactKeySet(raw, CONSUMED_LEARNING_PROJECTION_FIELD_KEYS, "Learning projection");
  const p = raw as unknown as ConsumedLearningProjection;
  if (p.contractVersion !== CONSUMED_LEARNING_PROJECTION_VERSION) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      `Learning projection version ${String(p.contractVersion)} is not ${CONSUMED_LEARNING_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.causationDisclaimer !== CONSUMED_LEARNING_CAUSATION_DISCLAIMER) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Learning projection must disclaim causation verbatim."
    );
  }
  if (!LEARNING_ID_PATTERN.test(p.learningId)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Learning projection learningId is not an lrn1: identity."
    );
  }
  if (!Number.isInteger(p.businessId) || p.businessId <= 0) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Learning projection businessId is not a positive integer."
    );
  }
  if (!isPlainObject(p.freshness)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Learning projection freshness metadata is missing."
    );
  }
  return p;
}

export function validateConsumedOutcomeProjection(raw: unknown): ConsumedOutcomeProjection {
  if (!isPlainObject(raw)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection is not a structured object."
    );
  }
  assertExactKeySet(raw, CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS, "Outcome projection");
  const p = raw as unknown as ConsumedOutcomeProjection;
  if (p.contractVersion !== CONSUMED_OUTCOME_PROJECTION_VERSION) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      `Outcome projection version ${String(p.contractVersion)} is not ${CONSUMED_OUTCOME_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== false) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection must disclaim causation and attribution."
    );
  }
  if (p.causationDisclaimer !== CONSUMED_OUTCOME_CAUSATION_DISCLAIMER) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection causation disclaimer does not match the frozen verbatim text."
    );
  }
  if (!OUTCOME_ID_PATTERN.test(p.outcomeId)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection outcomeId is not an out1: identity."
    );
  }
  if (!Number.isInteger(p.businessId) || p.businessId <= 0) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection businessId is not a positive integer."
    );
  }
  if (!HEX_64.test(p.evidenceHash)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection evidenceHash is not a 64-hex sha256."
    );
  }
  if (!ISO_PARSEABLE(p.occurredAt)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection occurredAt must be parseable ISO 8601."
    );
  }
  return p;
}

export function validateConsumedAttributionProjection(raw: unknown): ConsumedAttributionProjection {
  if (!isPlainObject(raw)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection is not a structured object."
    );
  }
  assertExactKeySet(raw, CONSUMED_ATTRIBUTION_PROJECTION_FIELD_KEYS, "Attribution projection");
  const p = raw as unknown as ConsumedAttributionProjection;
  if (p.contractVersion !== CONSUMED_ATTRIBUTION_PROJECTION_VERSION) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      `Attribution projection version ${String(p.contractVersion)} is not ${CONSUMED_ATTRIBUTION_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== true) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection must disclaim causation and claim attribution."
    );
  }
  if (p.causationDisclaimer !== CONSUMED_ATTRIBUTION_CAUSATION_DISCLAIMER) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection disclaimer does not match the frozen verbatim text."
    );
  }
  if (!ATTRIBUTION_ID_PATTERN.test(p.attributionId) || !OUTCOME_ID_PATTERN.test(p.outcomeId)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection ids are not atr1:/out1: identities."
    );
  }
  return p;
}

/**
 * Verify a consumed decision + approval are executable — the deterministic
 * execution gate over consumed R7-F shapes. Mirrors the checks R7-F's
 * assertOptimisationActionExecutable performs over its own durable rows;
 * R7-D never widens or narrows the decision itself.
 */
export function verifyExecutionGate(input: {
  decision: ConsumedGovernanceDecision;
  approval: ConsumedApprovalView | null;
  currentPolicyVersion: string | null;
  now: string;
}): ConsumedExecutionVerdict {
  const { decision, approval, currentPolicyVersion } = input;
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new ExperimentStateError("INVALID_EVALUATION_CLOCK", "now must be a valid ISO timestamp.");
  }
  const deny = (reason: string): ConsumedExecutionVerdict => ({
    executable: false,
    denialReasonCode: reason,
    authorization: null,
  });

  if (decision.decision === "BLOCK") {
    return deny(decision.reasonCodes[0] ?? "ACTION_PROHIBITED_BY_POLICY");
  }
  if (currentPolicyVersion === null || decision.policyVersion === null) {
    return deny("STALE_POLICY_VERSION");
  }
  if (currentPolicyVersion !== decision.policyVersion) {
    return deny("STALE_POLICY_VERSION");
  }
  if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
    return deny("EXPIRED_DECISION");
  }

  if (decision.decision === "ALLOW") {
    return {
      executable: true,
      denialReasonCode: null,
      authorization: {
        governanceDecisionId: decision.governanceDecisionId,
        decision: "ALLOW",
        approvalRequestId: null,
        policyVersion: decision.policyVersion,
        authorizedAt: input.now,
        expiresAt: decision.validUntil ?? "",
      },
    };
  }

  // REVIEW_REQUIRED
  if (approval === null) return deny("APPROVAL_NOT_FOUND");
  if (approval.status === "pending") return deny("APPROVAL_PENDING");
  if (approval.status === "rejected") return deny("APPROVAL_REJECTED_BY_HUMAN");
  if (approval.status === "edited") return deny("APPROVAL_BINDING_MISMATCH");
  if (approval.userId !== decision.userId) return deny("APPROVAL_BINDING_MISMATCH");
  const binding = approval.context?.optimisationGovernanceBinding;
  if (binding === null || binding === undefined) return deny("APPROVAL_BINDING_MISMATCH");
  if (binding.governanceDecisionId !== decision.governanceDecisionId) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (binding.policyVersion !== decision.policyVersion) return deny("APPROVAL_BINDING_MISMATCH");
  if (binding.proposalFingerprint !== decision.proposalFingerprint) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (decision.approvalBinding === null) return deny("APPROVAL_BINDING_MISMATCH");
  if (binding.approvalBindingHash !== decision.approvalBinding.approvalBindingHash) {
    return deny("APPROVAL_BINDING_MISMATCH");
  }
  if (Date.parse(binding.expiresAt) <= nowMs) return deny("EXPIRED_APPROVAL");

  return {
    executable: true,
    denialReasonCode: null,
    authorization: {
      governanceDecisionId: decision.governanceDecisionId,
      decision: "REVIEW_REQUIRED",
      approvalRequestId: approval.id,
      policyVersion: decision.policyVersion,
      authorizedAt: input.now,
      expiresAt: binding.expiresAt,
    },
  };
}

// ─── Upstream authority ports (production reads upstream tables; tests inject fakes) ───

export interface LearningAuthorityPort {
  /** Tenant-scoped frozen learning projection (or null when unknown). */
  getLearningForExperiment(
    userId: number,
    learningId: string
  ): Promise<ConsumedLearningProjection | null>;
}

export interface OutcomeAuthorityPort {
  getOutcomeForExperiment(
    userId: number,
    outcomeId: string
  ): Promise<ConsumedOutcomeProjection | null>;
}

export interface AttributionAuthorityPort {
  getAttributionForExperiment(
    userId: number,
    attributionId: string
  ): Promise<ConsumedAttributionProjection | null>;
}

export interface GovernanceAuthorityPort {
  /** Evaluate one governance proposal (R7-F decides; R7-D only consumes). */
  evaluateProposal(userId: number, proposal: unknown): Promise<ConsumedGovernanceDecision>;
  /** Tenant-scoped read of one durable decision (or null). */
  getDecision(userId: number, governanceDecisionId: string): Promise<ConsumedGovernanceDecision | null>;
  /** Tenant-scoped read of the approval bound to a decision (or null). */
  getApprovalForDecision(
    userId: number,
    governanceDecisionId: string
  ): Promise<ConsumedApprovalView | null>;
  /** Current policy version for revalidation, or null when unavailable. */
  getCurrentPolicyVersion(): Promise<string | null>;
  /** Verify a consumed decision + approval are executable (see gate above). */
  assertExecutable(input: {
    decision: ConsumedGovernanceDecision;
    approval: ConsumedApprovalView | null;
    currentPolicyVersion: string | null;
    now: string;
  }): Promise<ConsumedExecutionVerdict>;
}

export interface ExperimentationUpstreamPorts {
  readonly learning: LearningAuthorityPort;
  readonly outcomes: OutcomeAuthorityPort;
  readonly attributions: AttributionAuthorityPort;
  readonly governance: GovernanceAuthorityPort;
}

// ─── Production port implementation (guarded information-schema reads; fail closed) ───

type DbExecutor = ReturnType<typeof getDb>;

const tableExistsCache = new Map<string, boolean>();

async function tableExists(db: DbExecutor, tableName: string): Promise<boolean> {
  const cached = tableExistsCache.get(tableName);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
    `)) as unknown;
    const rows = Array.isArray(result)
      ? (result as unknown[][])
      : Array.isArray((result as { rows?: unknown[] }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
    const first = rows[0] as unknown;
    const count =
      first && typeof first === "object"
        ? Number((first as Record<string, unknown>).c ?? (first as unknown[])[0])
        : 0;
    exists = Number.isInteger(count) && count > 0;
  } catch {
    exists = false;
  }
  tableExistsCache.set(tableName, exists);
  return exists;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function unavailable(what: string): ExperimentStateError {
  return new ExperimentStateError(
    "EXPERIMENT_AUTHORITY_UNAVAILABLE",
    `${what} is unavailable: the upstream R7 table is not materialised (R7-X owns convergence). Failing closed.`
  );
}

function mapOutcomeRow(row: Record<string, unknown>): ConsumedOutcomeProjection {
  const currency = (row.currency as string | null) ?? null;
  return validateConsumedOutcomeProjection({
    contractVersion: CONSUMED_OUTCOME_PROJECTION_VERSION,
    outcomeId: row.outcomeId,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionId: row.conversionId,
    outcomeType: row.outcomeType,
    outcomeStatus: row.outcomeStatus,
    valueType: row.valueType,
    amountMinor: row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor),
    currency,
    currencyExponent: currency === null ? null : currency === "JPY" ? 0 : 2,
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    metricUnit: row.metricUnit ?? null,
    evidenceSource: row.evidenceSource,
    evidenceAuthority: row.evidenceAuthority,
    evidenceIdentity: row.evidenceIdentity,
    evidenceHash: row.evidenceHash,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    reversesOutcomeId: row.reversesOutcomeId ?? null,
    renewsOutcomeId: row.renewsOutcomeId ?? null,
    supersedesOutcomeId: row.supersedesOutcomeId ?? null,
    lifecycle: {
      statuses: [row.outcomeStatus],
      currentStatus: row.outcomeStatus,
    },
    causationClaimed: false,
    causationDisclaimer: CONSUMED_OUTCOME_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER,
  });
}

function mapAttributionRow(row: Record<string, unknown>): ConsumedAttributionProjection {
  return validateConsumedAttributionProjection({
    contractVersion: CONSUMED_ATTRIBUTION_PROJECTION_VERSION,
    attributionId: row.attributionId,
    outcomeId: row.outcomeId,
    outcomeStatus: row.outcomeStatus,
    outcomeType: row.outcomeType,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    conversionId: row.conversionId,
    modelType: row.modelType,
    modelVersion: row.modelVersion,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    touchpoints: jsonColumn(row.touchpoints, [] as unknown[]),
    excludedTouchpoints: jsonColumn(row.excludedTouchpoints, [] as unknown[]),
    totalCreditBps: Number(row.totalCreditBps),
    confidenceClass: row.confidenceClass,
    evidenceClass: row.evidenceClass,
    policyVersion: row.policyVersion,
    sourceVersions: jsonColumn(row.sourceVersions, {}),
    supersedesAttributionId: row.supersedesAttributionId ?? null,
    journeyHash: row.journeyHash,
    calculatedAt: row.calculatedAt,
    causationClaimed: false,
    causationDisclaimer: CONSUMED_ATTRIBUTION_CAUSATION_DISCLAIMER,
    attributionClaimed: true,
  });
}

function mapDecisionRow(row: Record<string, unknown>): ConsumedGovernanceDecision {
  const decision = row.decision as string;
  if (decision !== "ALLOW" && decision !== "REVIEW_REQUIRED" && decision !== "BLOCK") {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      `Governance decision ${decision} is outside the frozen vocabulary.`
    );
  }
  if (!GOVERNANCE_DECISION_ID_PATTERN.test(row.governanceDecisionId as string)) {
    throw new ExperimentStateError(
      "EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH",
      "Governance decision id is not an ogd1: identity."
    );
  }
  const approvalBinding = jsonColumn(row.approvalBinding, null as Record<string, unknown> | null);
  return {
    governanceDecisionId: row.governanceDecisionId as string,
    contractVersion: (row.contractVersion as string) ?? CONSUMED_GOVERNANCE_CONTRACT_VERSION,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    proposalId: row.proposalId as string,
    proposalType: row.proposalType as string,
    policyVersion: (row.policyVersion as string | null) ?? null,
    decision,
    reasonCodes: jsonColumn(row.reasonCodes, [] as string[]),
    riskClass: row.riskClass as string,
    financialImpactClass: row.financialImpactClass as string,
    financialDeltaMinor: Number(row.financialDeltaMinor),
    approvalRequired: Boolean(row.approvalRequired),
    approvalBinding:
      approvalBinding &&
      typeof approvalBinding.approvalBindingHash === "string" &&
      typeof approvalBinding.expiresAt === "string"
        ? {
            approvalBindingHash: approvalBinding.approvalBindingHash,
            expiresAt: approvalBinding.expiresAt,
          }
        : null,
    proposalFingerprint: row.proposalFingerprint as string,
    validUntil: (row.validUntil as string | null) ?? null,
    evaluatedAt: row.evaluatedAt as string,
    createdAt: row.createdAt,
  };
}

/** Production ports: guarded upstream table reads; fail closed when absent. */
export function createUpstreamPorts(executor?: DbExecutor): ExperimentationUpstreamPorts {
  const db = executor ?? getDb();

  // R7-C handoff contract §2 forbids direct learning-table reads: learning is
  // consumed ONLY through R7-C's tenant-scoped projection surface. Until R7-X
  // wires R7-C's projection builder in-process, learning authority is
  // unavailable and experiment creation fails closed — never fabricated.
  const learning: LearningAuthorityPort = {
    async getLearningForExperiment() {
      throw new ExperimentStateError(
        "EXPERIMENT_AUTHORITY_UNAVAILABLE",
        "Learning authority is unavailable until R7-X wires the R7-C experiment projection in-process. Failing closed."
      );
    },
  };

  const outcomes: OutcomeAuthorityPort = {
    async getOutcomeForExperiment(userId, outcomeId) {
      if (!(await tableExists(db, "business_outcomes"))) throw unavailable("Outcome authority");
      const result = await db.execute(sql`
        SELECT * FROM business_outcomes WHERE userId = ${userId} AND outcomeId = ${outcomeId} LIMIT 1
      `);
      const row = rowsOf(result)[0];
      return row ? mapOutcomeRow(row) : null;
    },
  };

  const attributions: AttributionAuthorityPort = {
    async getAttributionForExperiment(userId, attributionId) {
      if (!(await tableExists(db, "attribution_results"))) throw unavailable("Attribution authority");
      const result = await db.execute(sql`
        SELECT * FROM attribution_results WHERE userId = ${userId} AND attributionId = ${attributionId} LIMIT 1
      `);
      const row = rowsOf(result)[0];
      return row ? mapAttributionRow(row) : null;
    },
  };

  const governance: GovernanceAuthorityPort = {
    async evaluateProposal() {
      // R7-F owns evaluation. Until R7-X wires the R7-F module in-process,
      // governance-dependent paths fail closed rather than fabricating
      // authority.
      throw new ExperimentStateError(
        "EXPERIMENT_AUTHORITY_UNAVAILABLE",
        "Governance evaluation is unavailable until R7-X wires the R7-F authority in-process. Failing closed."
      );
    },
    async getDecision(userId, governanceDecisionId) {
      if (!(await tableExists(db, "optimisation_governance_decisions"))) {
        throw unavailable("Governance authority");
      }
      const result = await db.execute(sql`
        SELECT * FROM optimisation_governance_decisions
        WHERE userId = ${userId} AND governanceDecisionId = ${governanceDecisionId} LIMIT 1
      `);
      const row = rowsOf(result)[0];
      return row ? mapDecisionRow(row) : null;
    },
    async getApprovalForDecision(userId, governanceDecisionId) {
      if (!(await tableExists(db, "approval_requests"))) throw unavailable("Approval authority");
      const result = await db.execute(sql`
        SELECT id, userId, status, context FROM approval_requests
        WHERE userId = ${userId} AND approvalType = 'optimisation_action'
        ORDER BY id ASC
      `);
      const rows = rowsOf(result);
      for (const row of rows) {
        const context = jsonColumn(row.context, null as Record<string, unknown> | null);
        const binding = context?.optimisationGovernanceBinding as
          | { governanceDecisionId?: string }
          | undefined;
        if (binding && binding.governanceDecisionId === governanceDecisionId) {
          return {
            id: Number(row.id),
            userId: Number(row.userId),
            status: row.status as ConsumedApprovalView["status"],
            context: context as ConsumedApprovalView["context"],
          };
        }
      }
      return null;
    },
    async getCurrentPolicyVersion() {
      // Policy registry is R7-F code; until wired in-process, report
      // unavailable (null) so the execution gate fails closed on
      // STALE_POLICY_VERSION.
      return null;
    },
    async assertExecutable(input) {
      return verifyExecutionGate(input);
    },
  };

  return { learning, outcomes, attributions, governance };
}

export { EXPERIMENT_SOURCE_VERSION_KEYS };
