// ─── R8-E Strategic Opportunity & Risk — service authority ───
//
// Orchestrates one governed candidate derivation end to end: verify business
// ownership, read + revalidate the frozen R8-D projections, run the
// deterministic rule-first derivation and integer classification, analyse
// portfolio overlap, bind the mandatory R8-F governance decision, persist
// the immutable candidate exactly once under its convergence anchor, and
// emit exactly one audit event per inserted candidate (convergence paths
// emit zero). Re-evaluation records append-only sorl1: facts; material
// change mints a NEW superseding candidate — history is never edited.
//
// This stream never writes any upstream authority table, never executes
// candidates, and never becomes a governance engine (contract §1, §7).

import { and, eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import {
  CANDIDATE_ACTIVE_STATUSES,
  CONFIDENCE_TO_GOVERNANCE_SCALE,
  IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE,
  MAX_LIMITATIONS,
  STRATEGIC_OPPORTUNITY_RISK_BOUND_VERSIONS,
  STRATEGIC_OPPORTUNITY_RISK_CONTRACT_VERSION,
  STRATEGIC_OPPORTUNITY_RISK_ENGINE_VERSION,
  STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION,
  fail,
  type CandidateKind,
  type CandidateStatus,
  type CandidateType,
  type ConfidenceClass,
  type DerivationOutcome,
  type ImpactClass,
  type PortfolioRelation,
  type PriorityClass,
  type StrategicRiskClass,
  type TimeHorizon,
  type UrgencyClass,
} from "./strategic-opportunity-risk-contract";
import {
  deriveCandidateFingerprint,
  deriveCandidateId,
  deriveEvidenceBundleFingerprint,
  deriveLifecycleEventId,
  deriveRelationId,
  deriveSubjectKey,
} from "./strategic-opportunity-risk-identity";
import {
  anchorEvidence,
  assertConfidenceClass,
  collectEvidenceClasses,
  computeEvidenceQualityScore,
  computeImpactScore,
  computePriorityScore,
  computeUrgencyScore,
  deriveCandidateVerdict,
  deriveTimeHorizon,
  impactClassOf,
  newestObservedAt,
  objectiveAnchorPresent,
  priorityClassOf,
  urgencyClassOf,
} from "./strategic-opportunity-risk-classification";
import {
  deriveApprovalStatus,
  type StrategicReasoningProjection,
  type StrategicReasoningReadPort,
} from "./strategic-opportunity-risk-reasoning-seam";
import {
  assertCandidateConsumable,
  validateStrategicGovernanceDecisionView,
  type StrategicGovernanceDecisionView,
  type StrategicGovernanceEnginePort,
  type StrategicOpportunityRiskApprovalReadPort,
} from "./strategic-opportunity-risk-governance-seam";
import { computePortfolioRelation } from "./strategic-opportunity-risk-overlap";
import {
  buildMissionControlProjection,
  validateMissionControlProjection,
  type StrategicMissionControlProjection,
} from "./strategic-opportunity-risk-projection";
import {
  getStrategicCandidate,
  insertStrategicCandidate,
  insertStrategicCandidateLifecycleEvent,
  insertStrategicCandidateRelation,
  listStrategicCandidateLifecycleRows,
  listStrategicCandidateRelationRows,
  listStrategicCandidateRows,
  transitionStrategicCandidateStatus,
  type StrategicCandidateRow,
  type StrategicOpportunityRiskStoreExecutor,
} from "./strategic-opportunity-risk-store";

// ─── Dependencies ───

export interface StrategicOpportunityRiskDeps {
  /** Frozen R8-D read surface (production raw-SQL seam / in-memory fake). */
  readonly reasoning: StrategicReasoningReadPort;
  /** R8-F governance engine port (canonical at R8-X / test double). */
  readonly governance: StrategicGovernanceEnginePort;
  /** Read-only approval ledger view (production / in-memory). */
  readonly approvals: StrategicOpportunityRiskApprovalReadPort;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function resolveNow(deps: StrategicOpportunityRiskDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function asAuditExecutor(executor: StrategicOpportunityRiskStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

// ─── Business authority (canonical table, re-verified every call) ───

async function assertBusinessOwnership(
  executor: StrategicOpportunityRiskStoreExecutor,
  userId: number,
  businessId: number
): Promise<void> {
  const rows = await executor
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    fail("OWNERSHIP_MISMATCH", `business ${businessId} not found for this tenant`);
  }
}

// ─── Reasoning resolution (server-side only; clients supply ids) ───

async function resolveReasoningProjections(input: {
  userId: number;
  businessId: number;
  reasoningIds: readonly string[];
  reasoning: StrategicReasoningReadPort;
}): Promise<StrategicReasoningProjection[]> {
  const uniqueIds = [...new Set(input.reasoningIds)];
  if (uniqueIds.length === 0) {
    fail("ZERO_USABLE_REASONING", "at least one governed reasoning reference is required");
  }
  const projections: StrategicReasoningProjection[] = [];
  for (const reasoningId of uniqueIds) {
    const projection = await input.reasoning.getReasoning({
      userId: input.userId,
      businessId: input.businessId,
      reasoningId,
    });
    if (!projection) {
      // Cross-tenant / cross-business / unknown are indistinguishable — fail closed.
      fail(
        "UNKNOWN_REASONING_REFERENCE",
        `reasoning ${reasoningId} does not resolve for this tenant + business`
      );
    }
    if (projection.freshness !== "current") {
      fail(
        "STALE_REASONING",
        `reasoning ${reasoningId} is stale; re-evaluate the conclusion with R8-D before deriving candidates`
      );
    }
    projections.push(projection);
  }
  return projections;
}

// ─── Approval status re-derivation (read-only; forged bindings fail closed) ───

async function deriveCandidateApprovalStatus(input: {
  row: Pick<StrategicCandidateRow, "governanceDecisionId" | "governanceRecord">;
  userId: number;
  approvals: StrategicOpportunityRiskApprovalReadPort;
}): Promise<"none" | "pending" | "approved" | "rejected"> {
  const { row, userId, approvals } = input;
  if (!row.governanceDecisionId) return "none";
  const record = row.governanceRecord;
  if (typeof record !== "object" || record === null) return "none";
  const r = record as Record<string, unknown>;
  if (
    typeof r.policyVersion !== "string" ||
    typeof r.proposalFingerprint !== "string" ||
    typeof r.evidenceFingerprint !== "string"
  ) {
    return "none";
  }
  const approvalRows = await approvals.listApprovalsForDecision({
    userId,
    governanceDecisionId: row.governanceDecisionId,
  });
  return deriveApprovalStatus({
    decision: {
      governanceDecisionId: row.governanceDecisionId,
      policyVersion: r.policyVersion,
      proposalFingerprint: r.proposalFingerprint,
      evidenceFingerprint: r.evidenceFingerprint,
    },
    bindings: approvalRows.map((a) => a.binding),
    approvalStatuses: approvalRows.map((a) => a.status),
  });
}

// ─── Candidate view (API surface) ───

export interface StrategicCandidateView {
  readonly candidateId: string;
  readonly businessId: number;
  readonly candidateKind: CandidateKind;
  readonly candidateType: CandidateType;
  readonly reasoningIds: readonly string[];
  readonly memoryRefs: readonly string[];
  readonly changeRefs: readonly string[];
  readonly signalRefs: readonly string[];
  readonly supportingEvidence: readonly { ref: string; evidenceClass: string; role?: string }[];
  readonly contradictingEvidence: readonly { ref: string; evidenceClass: string }[];
  readonly impactClass: ImpactClass;
  readonly urgencyClass: UrgencyClass;
  readonly timeHorizon: TimeHorizon;
  readonly confidenceClass: ConfidenceClass;
  readonly evidenceQualityScore: number;
  readonly priorityScore: number;
  readonly priorityClass: PriorityClass;
  readonly strategicRiskClass: StrategicRiskClass | null;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly policyVersion: string | null;
  readonly approvalStatus: "none" | "pending" | "approved" | "rejected";
  readonly status: CandidateStatus;
  readonly portfolioRelation: PortfolioRelation;
  readonly relationCandidateIds: readonly string[];
  readonly derivationOutcome: DerivationOutcome;
  readonly limitations: readonly string[];
  readonly validUntil: string | null;
  readonly freshness: "current" | "stale";
  readonly supersedesCandidateId: string | null;
  readonly version: number;
  readonly createdAt: string;
}

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function toCandidateView(input: {
  row: StrategicCandidateRow;
  approvalStatus: "none" | "pending" | "approved" | "rejected";
  nowMs: number;
}): StrategicCandidateView {
  const { row, approvalStatus, nowMs } = input;
  const validUntil = typeof row.validUntil === "string" ? row.validUntil : null;
  const expired = validUntil !== null && Date.parse(validUntil) < nowMs;
  const status: CandidateStatus =
    row.status === "REVIEW_REQUIRED" && approvalStatus === "approved"
      ? "GOVERNED_RECOMMENDATION"
      : (row.status as CandidateStatus);
  const supporting = asStringArray(row.supportingEvidence);
  void supporting;
  return {
    candidateId: row.candidateId,
    businessId: row.businessId,
    candidateKind: row.candidateKind as CandidateKind,
    candidateType: row.candidateType as CandidateType,
    reasoningIds: asStringArray(row.reasoningIds),
    memoryRefs: asStringArray(row.memoryRefs),
    changeRefs: asStringArray(row.changeRefs),
    signalRefs: asStringArray(row.signalRefs),
    supportingEvidence: Array.isArray(row.supportingEvidence)
      ? (row.supportingEvidence as readonly { ref: string; evidenceClass: string; role?: string }[])
      : [],
    contradictingEvidence: Array.isArray(row.contradictingEvidence)
      ? (row.contradictingEvidence as readonly { ref: string; evidenceClass: string }[])
      : [],
    impactClass: row.impactClass as ImpactClass,
    urgencyClass: row.urgencyClass as UrgencyClass,
    timeHorizon: row.timeHorizon as TimeHorizon,
    confidenceClass: row.confidenceClass as ConfidenceClass,
    evidenceQualityScore: Number(row.evidenceQualityScore),
    priorityScore: Number(row.priorityScore),
    priorityClass: row.priorityClass as PriorityClass,
    strategicRiskClass: (row.strategicRiskClass as StrategicRiskClass | null) ?? null,
    governanceDecisionId: row.governanceDecisionId,
    governanceDecision: row.governanceDecision,
    policyVersion: row.policyVersion,
    approvalStatus,
    status,
    portfolioRelation: row.portfolioRelation as PortfolioRelation,
    relationCandidateIds: asStringArray(row.relationCandidateIds),
    derivationOutcome: row.derivationOutcome as DerivationOutcome,
    limitations: asStringArray(row.limitations),
    validUntil,
    freshness: expired ? "stale" : "current",
    supersedesCandidateId: row.supersedesCandidateId,
    version: Number(row.version),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : typeof row.createdAt === "string"
          ? row.createdAt
          : "",
  };
}

// ─── Derivation (E3–E7) ───

export interface DeriveStrategicCandidatesResult {
  readonly contractVersion: typeof STRATEGIC_OPPORTUNITY_RISK_CONTRACT_VERSION;
  readonly engineVersion: typeof STRATEGIC_OPPORTUNITY_RISK_ENGINE_VERSION;
  readonly results: readonly {
    readonly reasoningId: string;
    readonly outcome: DerivationOutcome;
    readonly candidate: StrategicCandidateView | null;
    readonly note: string | null;
  }[];
}

interface ClassifiedCandidateMaterial {
  readonly projection: StrategicReasoningProjection;
  readonly candidateKind: CandidateKind;
  readonly candidateType: CandidateType;
  readonly derivationOutcome: DerivationOutcome;
  readonly subjectKey: string;
  readonly evidenceBundleFingerprint: string;
  readonly candidateId: string;
  readonly impactClass: ImpactClass;
  readonly urgencyClass: UrgencyClass;
  readonly timeHorizon: TimeHorizon;
  readonly confidenceClass: ConfidenceClass;
  readonly evidenceQualityScore: number;
  readonly priorityScore: number;
  readonly priorityClass: PriorityClass;
  readonly memoryRefs: readonly string[];
  readonly changeRefs: readonly string[];
  readonly signalRefs: readonly string[];
  readonly anchorRefs: readonly string[];
  readonly limitations: readonly string[];
  readonly validUntil: string | null;
  readonly note: string | null;
}

function classifyProjection(input: {
  userId: number;
  businessId: number;
  projection: StrategicReasoningProjection;
  modelCandidateTypes: readonly CandidateType[] | undefined;
  nowMs: number;
}): ClassifiedCandidateMaterial | { skipped: DerivationOutcome; note: string | null } {
  const { projection } = input;
  const verdict = deriveCandidateVerdict(projection, input.modelCandidateTypes);
  if (verdict.outcome === "NO_CANDIDATE" || !verdict.candidateKind || !verdict.candidateType) {
    return { skipped: verdict.outcome, note: verdict.limitationNote };
  }
  const anchors = anchorEvidence(projection);
  const anchorRefs = anchors.map((a) => a.ref);
  const subjectKey = deriveSubjectKey(anchorRefs);
  const evidenceBundleFingerprint = deriveEvidenceBundleFingerprint({
    businessId: input.businessId,
    anchors: [{ reasoningId: projection.reasoningId, evidenceBundleId: projection.evidenceBundleId }],
  });
  const candidateId = deriveCandidateId({
    userId: input.userId,
    businessId: input.businessId,
    candidateKind: verdict.candidateKind,
    candidateType: verdict.candidateType,
    reasoningIds: [projection.reasoningId],
    subjectKey,
    evidenceBundleFingerprint,
  });

  // E4: independent integer dimensions.
  const impactScore = computeImpactScore({
    strategicRiskClass: projection.strategicRiskClass,
    supportingAnchors: anchors.length,
    objectiveAnchorPresent: objectiveAnchorPresent([projection]),
    evidenceClasses: collectEvidenceClasses([projection]),
  });
  const impactClass = impactClassOf(impactScore);
  const urgencyScore = computeUrgencyScore({
    validUntil: projection.validUntil,
    newestObservedAt: newestObservedAt(projection),
    implicationType: projection.implicationType,
    freshness: projection.freshness,
    nowMs: input.nowMs,
  });
  const urgencyClass = urgencyClassOf(urgencyScore);
  const timeHorizon = deriveTimeHorizon({
    urgencyClass,
    validUntil: projection.validUntil,
    nowMs: input.nowMs,
  });

  // E5: confidence carried verbatim (ceiling-bound), quality + priority.
  assertConfidenceClass(projection.confidenceClass);
  const confidenceClass = projection.confidenceClass as ConfidenceClass;
  const evidenceQualityScore = computeEvidenceQualityScore({
    confidenceClass,
    contradictingCount: projection.contradictingEvidence.length,
    missingEvidenceCount: projection.missingEvidence.length,
  });
  const priorityScore = computePriorityScore({
    impactClass,
    urgencyClass,
    confidenceClass,
    objectiveAnchorPresent: objectiveAnchorPresent([projection]),
    supportingAnchors: anchors.length,
    contradictingCount: projection.contradictingEvidence.length,
    uncertaintyClassCount: projection.uncertaintyClasses.length,
    missingEvidenceNonEmpty: projection.missingEvidence.length > 0,
  });
  const priorityClass = priorityClassOf({ priorityScore, impactClass, confidenceClass });

  const memoryRefs: string[] = [];
  const changeRefs: string[] = [];
  const signalRefs: string[] = [];
  for (const item of [...projection.supportingEvidence, ...projection.contradictingEvidence]) {
    if (item.evidenceClass === "INTERNAL_MEMORY") memoryRefs.push(item.ref);
    else if (item.evidenceClass === "INTERNAL_CHANGE") changeRefs.push(item.ref);
    else signalRefs.push(item.ref);
  }

  const limitations = [...projection.limitations];
  if (verdict.limitationNote) limitations.push(verdict.limitationNote);
  const validUntil = projection.validUntil;

  return {
    projection,
    candidateKind: verdict.candidateKind,
    candidateType: verdict.candidateType,
    derivationOutcome: verdict.outcome,
    subjectKey,
    evidenceBundleFingerprint,
    candidateId,
    impactClass,
    urgencyClass,
    timeHorizon,
    confidenceClass,
    evidenceQualityScore,
    priorityScore,
    priorityClass,
    memoryRefs: [...new Set(memoryRefs)].slice(0, 32),
    changeRefs: [...new Set(changeRefs)].slice(0, 32),
    signalRefs: [...new Set(signalRefs)].slice(0, 32),
    anchorRefs,
    limitations: limitations.slice(0, MAX_LIMITATIONS),
    validUntil,
    note: verdict.limitationNote,
  };
}

function resolveStatus(input: {
  decision: StrategicGovernanceDecisionView["decision"];
  priorityClass: PriorityClass;
}): CandidateStatus {
  if (input.decision === "BLOCK") return "BLOCKED";
  if (input.decision === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
  return input.priorityClass === "MONITOR" ? "MONITOR" : "GOVERNED_RECOMMENDATION";
}

export async function deriveStrategicCandidates(
  input: {
    userId: number;
    businessId: number;
    reasoningIds: readonly string[];
    modelCandidateTypes?: readonly CandidateType[];
    /** Lifecycle binding: this derivation supersedes an existing candidate. */
    supersedesCandidateId?: string | null;
  },
  deps: StrategicOpportunityRiskDeps,
  executor: StrategicOpportunityRiskStoreExecutor
): Promise<DeriveStrategicCandidatesResult> {
  const now = resolveNow(deps);
  const nowMs = now.getTime();
  await assertBusinessOwnership(executor, input.userId, input.businessId);
  const projections = await resolveReasoningProjections({
    userId: input.userId,
    businessId: input.businessId,
    reasoningIds: input.reasoningIds,
    reasoning: deps.reasoning,
  });
  const projectionsByReasoningId = new Map(projections.map((p) => [p.reasoningId, p]));
  const existingRows = await listStrategicCandidateRows(executor, input.userId, {
    businessId: input.businessId,
  });
  const activeExisting = existingRows.filter((r) =>
    (CANDIDATE_ACTIVE_STATUSES as readonly string[]).includes(r.status)
  );

  const results: {
    reasoningId: string;
    outcome: DerivationOutcome;
    candidate: StrategicCandidateView | null;
    note: string | null;
  }[] = [];
  for (const projection of projections) {
    const classified = classifyProjection({
      userId: input.userId,
      businessId: input.businessId,
      projection,
      modelCandidateTypes: input.modelCandidateTypes,
      nowMs,
    });
    if ("skipped" in classified) {
      results.push({
        reasoningId: projection.reasoningId,
        outcome: classified.skipped,
        candidate: null,
        note: classified.note,
      });
      continue;
    }

    // E6: deterministic overlap against active candidates (lineage only).
    const overlap = computePortfolioRelation({
      candidateKind: classified.candidateKind,
      candidateType: classified.candidateType,
      subjectKey: classified.subjectKey,
      reasoningIds: [projection.reasoningId],
      anchorRefs: classified.anchorRefs,
      existing: activeExisting
        .filter((r) => r.candidateId !== classified.candidateId)
        .map((r) => ({
          candidateId: r.candidateId,
          candidateKind: r.candidateKind as CandidateKind,
          candidateType: r.candidateType,
          subjectKey: r.subjectKey,
          reasoningIds: asStringArray(r.reasoningIds),
          anchorRefs: asStringArray(r.anchorRefs),
        })),
      projectionsByReasoningId,
    });

    // E7: mandatory R8-F governance binding (proposal material only).
    const recommendationType = IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE[projection.implicationType];
    if (!recommendationType) {
      results.push({
        reasoningId: projection.reasoningId,
        outcome: "NO_CANDIDATE",
        candidate: null,
        note: `implication ${projection.implicationType} carries no governance recommendation type`,
      });
      continue;
    }
    const summary =
      `${classified.candidateKind}:${classified.candidateType}:${classified.subjectKey}`.slice(0, 200);
    const decision = validateStrategicGovernanceDecisionView(
      await deps.governance.evaluateProposal({
        userId: input.userId,
        businessId: input.businessId,
        proposal: {
          proposalId: classified.candidateId,
          businessId: input.businessId,
          recommendationType,
          summary,
          evidenceRefs: [...classified.memoryRefs, ...classified.changeRefs, ...classified.signalRefs],
          claimedConfidence: CONFIDENCE_TO_GOVERNANCE_SCALE[classified.confidenceClass],
          declaredImpact: {
            impactClass: classified.impactClass,
            urgencyClass: classified.urgencyClass,
            timeHorizon: classified.timeHorizon,
            priorityClass: classified.priorityClass,
          },
          requestedAt: now.toISOString(),
        },
      })
    );

    const status = resolveStatus({ decision: decision.decision, priorityClass: classified.priorityClass });
    const supersedesCandidateId = input.supersedesCandidateId ?? null;
    const candidateFingerprint = deriveCandidateFingerprint({
      candidateId: classified.candidateId,
      impactClass: classified.impactClass,
      urgencyClass: classified.urgencyClass,
      timeHorizon: classified.timeHorizon,
      confidenceClass: classified.confidenceClass,
      evidenceQualityScore: classified.evidenceQualityScore,
      priorityScore: classified.priorityScore,
      priorityClass: classified.priorityClass,
      strategicRiskClass: decision.strategicRiskClass,
      governanceDecisionId: decision.governanceDecisionId,
      governanceDecision: decision.decision,
      status,
      validUntil: classified.validUntil,
      supersedesCandidateId,
    });

    const row: StrategicCandidateRow = {
      candidateId: classified.candidateId,
      userId: input.userId,
      businessId: input.businessId,
      candidateKind: classified.candidateKind,
      candidateType: classified.candidateType,
      reasoningIds: [projection.reasoningId],
      memoryRefs: [...classified.memoryRefs],
      changeRefs: [...classified.changeRefs],
      signalRefs: [...classified.signalRefs],
      supportingEvidence: projection.supportingEvidence,
      contradictingEvidence: projection.contradictingEvidence,
      anchorRefs: [...classified.anchorRefs],
      subjectKey: classified.subjectKey,
      evidenceBundleFingerprint: classified.evidenceBundleFingerprint,
      candidateFingerprint,
      impactClass: classified.impactClass,
      urgencyClass: classified.urgencyClass,
      timeHorizon: classified.timeHorizon,
      confidenceClass: classified.confidenceClass,
      evidenceQualityScore: classified.evidenceQualityScore,
      priorityScore: classified.priorityScore,
      priorityClass: classified.priorityClass,
      strategicRiskClass: decision.strategicRiskClass,
      governanceDecisionId: decision.governanceDecisionId,
      governanceDecision: decision.decision,
      governanceRecord: decision,
      policyVersion: decision.policyVersion,
      approvalStatus: "none",
      status,
      portfolioRelation: overlap.relation,
      relationCandidateIds: [...overlap.relatedCandidateIds],
      derivationOutcome: classified.derivationOutcome,
      limitations: [...classified.limitations],
      validUntil: classified.validUntil,
      supersedesCandidateId,
      sourceVersions: { ...STRATEGIC_OPPORTUNITY_RISK_BOUND_VERSIONS },
      version: 1,
    };

    const { inserted } = await insertStrategicCandidate(executor, row);
    if (inserted) {
      // E6 relations: durable lineage rows (never score inputs).
      for (const relatedId of overlap.relatedCandidateIds) {
        await insertStrategicCandidateRelation(executor, {
          relationId: deriveRelationId({
            candidateId: classified.candidateId,
            relatedCandidateId: relatedId,
            relation: overlap.relation,
          }),
          userId: input.userId,
          businessId: input.businessId,
          candidateId: classified.candidateId,
          relatedCandidateId: relatedId,
          relation: overlap.relation,
        });
      }
      const event = createAuditEvent({
        eventType: "strategic_candidate_derived",
        occurredAt: now.toISOString(),
        userId: input.userId,
        source: "system",
        outcome: "succeeded",
        campaignId: null,
        businessId: input.businessId,
        workflowOperationId: null,
        metadata: {
          candidateId: classified.candidateId,
          candidateKind: classified.candidateKind,
          candidateType: classified.candidateType,
          reasoningIds: [projection.reasoningId],
          impactClass: classified.impactClass,
          urgencyClass: classified.urgencyClass,
          timeHorizon: classified.timeHorizon,
          confidenceClass: classified.confidenceClass,
          priorityClass: classified.priorityClass,
          strategicRiskClass: decision.strategicRiskClass,
          governanceDecision: decision.decision,
          governanceDecisionId: decision.governanceDecisionId,
          portfolioRelation: overlap.relation,
          derivationOutcome: classified.derivationOutcome,
          candidateFingerprint,
        },
      });
      await persistAuditEvent(event, asAuditExecutor(executor));
      activeExisting.push(row);
    }

    const approvalStatus = await deriveCandidateApprovalStatus({
      row,
      userId: input.userId,
      approvals: deps.approvals,
    });
    results.push({
      reasoningId: projection.reasoningId,
      outcome: classified.derivationOutcome,
      candidate: toCandidateView({ row, approvalStatus, nowMs }),
      note: classified.note,
    });
  }

  return {
    contractVersion: STRATEGIC_OPPORTUNITY_RISK_CONTRACT_VERSION,
    engineVersion: STRATEGIC_OPPORTUNITY_RISK_ENGINE_VERSION,
    results,
  };
}

// ─── Reads ───

export async function getStrategicCandidateForUser(input: {
  userId: number;
  candidateId: string;
  deps: StrategicOpportunityRiskDeps;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<{ candidate: StrategicCandidateView }> {
  const nowMs = resolveNow(input.deps).getTime();
  const row = await getStrategicCandidate(input.executor, input.userId, input.candidateId);
  if (!row) fail("CANDIDATE_NOT_FOUND", `candidate ${input.candidateId} not found`);
  const approvalStatus = await deriveCandidateApprovalStatus({
    row,
    userId: input.userId,
    approvals: input.deps.approvals,
  });
  return { candidate: toCandidateView({ row, approvalStatus, nowMs }) };
}

export async function listStrategicCandidatesForUser(input: {
  userId: number;
  businessId?: number;
  status?: string;
  candidateKind?: string;
  priorityClass?: string;
  deps: StrategicOpportunityRiskDeps;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<{ candidates: StrategicCandidateView[] }> {
  const nowMs = resolveNow(input.deps).getTime();
  const rows = await listStrategicCandidateRows(input.executor, input.userId, {
    businessId: input.businessId,
    status: input.status,
    candidateKind: input.candidateKind,
    priorityClass: input.priorityClass,
  });
  const candidates: StrategicCandidateView[] = [];
  for (const row of rows) {
    const approvalStatus = await deriveCandidateApprovalStatus({
      row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    candidates.push(toCandidateView({ row, approvalStatus, nowMs }));
  }
  return { candidates };
}

export async function listStrategicCandidateRelationsForUser(input: {
  userId: number;
  candidateId: string;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<{ relations: readonly { relationId: string; candidateId: string; relatedCandidateId: string; relation: string }[] }> {
  const row = await getStrategicCandidate(input.executor, input.userId, input.candidateId);
  if (!row) fail("CANDIDATE_NOT_FOUND", `candidate ${input.candidateId} not found`);
  const relations = await listStrategicCandidateRelationRows(input.executor, input.userId, input.candidateId);
  return {
    relations: relations.map((r) => ({
      relationId: r.relationId,
      candidateId: r.candidateId,
      relatedCandidateId: r.relatedCandidateId,
      relation: r.relation,
    })),
  };
}

export async function listStrategicCandidateLifecycleForUser(input: {
  userId: number;
  candidateId: string;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<{ lifecycle: readonly { lifecycleEventId: string; lifecycleType: string; targetStatus: string; successorCandidateId: string | null; occurredAt: string; reasonCode: string | null }[] }> {
  const row = await getStrategicCandidate(input.executor, input.userId, input.candidateId);
  if (!row) fail("CANDIDATE_NOT_FOUND", `candidate ${input.candidateId} not found`);
  const lifecycle = await listStrategicCandidateLifecycleRows(input.executor, input.userId, input.candidateId);
  return {
    lifecycle: lifecycle.map((l) => ({
      lifecycleEventId: l.lifecycleEventId,
      lifecycleType: l.lifecycleType,
      targetStatus: l.targetStatus,
      successorCandidateId: l.successorCandidateId,
      occurredAt: l.occurredAt,
      reasonCode: l.reasonCode,
    })),
  };
}

// ─── Re-evaluation (E9) ───

async function recordLifecycleFact(input: {
  userId: number;
  candidateId: string;
  lifecycleType: string;
  targetStatus: string;
  successorCandidateId: string | null;
  occurredAt: string;
  reasonCode: string | null;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<boolean> {
  const { inserted } = await insertStrategicCandidateLifecycleEvent(input.executor, {
    lifecycleEventId: deriveLifecycleEventId({
      candidateId: input.candidateId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorCandidateId: input.successorCandidateId,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode,
    }),
    userId: input.userId,
    candidateId: input.candidateId,
    lifecycleType: input.lifecycleType,
    targetStatus: input.targetStatus,
    successorCandidateId: input.successorCandidateId,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  });
  if (!inserted) return false;
  const event = createAuditEvent({
    eventType: "strategic_candidate_lifecycle",
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: null,
    businessId: null,
    workflowOperationId: null,
    metadata: {
      candidateId: input.candidateId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorCandidateId: input.successorCandidateId,
      reasonCode: input.reasonCode,
    },
  });
  await persistAuditEvent(event, asAuditExecutor(input.executor));
  return true;
}

export async function reevaluateStrategicCandidate(input: {
  userId: number;
  candidateId: string;
  deps: StrategicOpportunityRiskDeps;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<{ candidate: StrategicCandidateView; successor: StrategicCandidateView | null }> {
  const now = resolveNow(input.deps);
  const nowMs = now.getTime();
  const row = await getStrategicCandidate(input.executor, input.userId, input.candidateId);
  if (!row) fail("CANDIDATE_NOT_FOUND", `candidate ${input.candidateId} not found`);
  if (["SUPERSEDED", "CONTRADICTED", "INVALIDATED", "RESOLVED"].includes(row.status)) {
    // Terminal states: replay returns the stored state unchanged (convergence).
    const approvalStatus = await deriveCandidateApprovalStatus({
      row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return { candidate: toCandidateView({ row, approvalStatus, nowMs }), successor: null };
  }

  const reasoningIds = asStringArray(row.reasoningIds);
  const projections: StrategicReasoningProjection[] = [];
  for (const reasoningId of reasoningIds) {
    const projection = await input.deps.reasoning.getReasoning({
      userId: input.userId,
      businessId: row.businessId,
      reasoningId,
    });
    if (!projection) {
      fail(
        "UNKNOWN_REASONING_REFERENCE",
        `reasoning ${reasoningId} no longer resolves for this tenant + business — refusing to mutate candidate authority on unknown reasoning`
      );
    }
    projections.push(projection);
  }
  const projection = projections[0];
  const occurredAt = now.toISOString();

  // R8-D lifecycle drives candidate lifecycle (immutable facts, CAS transitions).
  if (projection.status === "SUPERSEDED") {
    // Attempt to derive the successor candidate from the active successor reasoning.
    let successor: StrategicCandidateView | null = null;
    const all = await input.deps.reasoning.listReasoningProjections({
      userId: input.userId,
      businessId: row.businessId,
      includeNonActive: true,
    });
    const successorProjection = all.find(
      (p) => p.supersedesReasoningId === projection.reasoningId && p.freshness === "current"
    );
    if (successorProjection && successorProjection.status !== "SUPERSEDED" && successorProjection.status !== "INVALIDATED") {
      const derived = await deriveStrategicCandidates(
        {
          userId: input.userId,
          businessId: row.businessId,
          reasoningIds: [successorProjection.reasoningId],
          supersedesCandidateId: row.candidateId,
        },
        input.deps,
        input.executor
      );
      const derivedCandidate = derived.results[0]?.candidate ?? null;
      if (derivedCandidate) successor = derivedCandidate;
    }
    await transitionStrategicCandidateStatus(input.executor, {
      userId: input.userId,
      candidateId: row.candidateId,
      expectedVersion: Number(row.version),
      nextStatus: "SUPERSEDED",
    });
    await recordLifecycleFact({
      userId: input.userId,
      candidateId: row.candidateId,
      lifecycleType: "supersession",
      targetStatus: "SUPERSEDED",
      successorCandidateId: successor?.candidateId ?? null,
      occurredAt,
      reasonCode: "REASONING_SUPERSEDED",
      executor: input.executor,
    });
    const updated = await getStrategicCandidate(input.executor, input.userId, row.candidateId);
    const approvalStatus = await deriveCandidateApprovalStatus({
      row: updated ?? row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return {
      candidate: toCandidateView({ row: updated ?? row, approvalStatus, nowMs }),
      successor,
    };
  }

  if (projection.status === "CONTRADICTED") {
    await transitionStrategicCandidateStatus(input.executor, {
      userId: input.userId,
      candidateId: row.candidateId,
      expectedVersion: Number(row.version),
      nextStatus: "CONTRADICTED",
    });
    await recordLifecycleFact({
      userId: input.userId,
      candidateId: row.candidateId,
      lifecycleType: "contradiction",
      targetStatus: "CONTRADICTED",
      successorCandidateId: null,
      occurredAt,
      reasonCode: "REASONING_CONTRADICTED",
      executor: input.executor,
    });
    const updated = await getStrategicCandidate(input.executor, input.userId, row.candidateId);
    const approvalStatus = await deriveCandidateApprovalStatus({
      row: updated ?? row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return { candidate: toCandidateView({ row: updated ?? row, approvalStatus, nowMs }), successor: null };
  }

  if (projection.status === "INVALIDATED") {
    await transitionStrategicCandidateStatus(input.executor, {
      userId: input.userId,
      candidateId: row.candidateId,
      expectedVersion: Number(row.version),
      nextStatus: "INVALIDATED",
    });
    await recordLifecycleFact({
      userId: input.userId,
      candidateId: row.candidateId,
      lifecycleType: "invalidation",
      targetStatus: "INVALIDATED",
      successorCandidateId: null,
      occurredAt,
      reasonCode: "REASONING_INVALIDATED",
      executor: input.executor,
    });
    const updated = await getStrategicCandidate(input.executor, input.userId, row.candidateId);
    const approvalStatus = await deriveCandidateApprovalStatus({
      row: updated ?? row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return { candidate: toCandidateView({ row: updated ?? row, approvalStatus, nowMs }), successor: null };
  }

  if (projection.freshness !== "current") {
    await transitionStrategicCandidateStatus(input.executor, {
      userId: input.userId,
      candidateId: row.candidateId,
      expectedVersion: Number(row.version),
      nextStatus: "STALE",
    });
    await recordLifecycleFact({
      userId: input.userId,
      candidateId: row.candidateId,
      lifecycleType: "staleness",
      targetStatus: "STALE",
      successorCandidateId: null,
      occurredAt,
      reasonCode: "REASONING_STALE",
      executor: input.executor,
    });
    const updated = await getStrategicCandidate(input.executor, input.userId, row.candidateId);
    const approvalStatus = await deriveCandidateApprovalStatus({
      row: updated ?? row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return { candidate: toCandidateView({ row: updated ?? row, approvalStatus, nowMs }), successor: null };
  }

  // Still-active reasoning: re-derive the classification material. Material
  // change ⇒ NEW superseding candidate (identity differs via evidence bundle
  // or classes); identical ⇒ idempotent convergence with zero events.
  const classified = classifyProjection({
    userId: input.userId,
    businessId: row.businessId,
    projection,
    modelCandidateTypes: undefined,
    nowMs,
  });
  if ("skipped" in classified) {
    // The conclusion no longer supports a candidate (e.g. demoted to
    // NO_ACTIONABLE_CONCLUSION) — the candidate is resolved as invalid.
    await transitionStrategicCandidateStatus(input.executor, {
      userId: input.userId,
      candidateId: row.candidateId,
      expectedVersion: Number(row.version),
      nextStatus: "INVALIDATED",
    });
    await recordLifecycleFact({
      userId: input.userId,
      candidateId: row.candidateId,
      lifecycleType: "invalidation",
      targetStatus: "INVALIDATED",
      successorCandidateId: null,
      occurredAt,
      reasonCode: "DERIVATION_NO_LONGER_SUPPORTED",
      executor: input.executor,
    });
    const updated = await getStrategicCandidate(input.executor, input.userId, row.candidateId);
    const approvalStatus = await deriveCandidateApprovalStatus({
      row: updated ?? row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    return { candidate: toCandidateView({ row: updated ?? row, approvalStatus, nowMs }), successor: null };
  }

  // Governance revalidation: re-submit identical proposal material — same
  // material converges to the same decision; a policy change mints a new
  // decision and is re-bound here (contract §7 + R8-F revalidate rule).
  const recommendationType = IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE[projection.implicationType];
  let refreshedRow = row;
  if (recommendationType) {
    const summary = `${classified.candidateKind}:${classified.candidateType}:${classified.subjectKey}`.slice(0, 200);
    const decision = validateStrategicGovernanceDecisionView(
      await input.deps.governance.evaluateProposal({
        userId: input.userId,
        businessId: row.businessId,
        proposal: {
          proposalId: classified.candidateId,
          businessId: row.businessId,
          recommendationType,
          summary,
          evidenceRefs: [...classified.memoryRefs, ...classified.changeRefs, ...classified.signalRefs],
          claimedConfidence: CONFIDENCE_TO_GOVERNANCE_SCALE[classified.confidenceClass],
          declaredImpact: {
            impactClass: classified.impactClass,
            urgencyClass: classified.urgencyClass,
            timeHorizon: classified.timeHorizon,
            priorityClass: classified.priorityClass,
          },
          requestedAt: occurredAt,
        },
      })
    );
    if (
      decision.governanceDecisionId !== row.governanceDecisionId ||
      decision.decision !== row.governanceDecision ||
      decision.strategicRiskClass !== row.strategicRiskClass
    ) {
      const nextStatus = resolveStatus({
        decision: decision.decision,
        priorityClass: classified.priorityClass,
      });
      const nextFingerprint = deriveCandidateFingerprint({
        candidateId: classified.candidateId,
        impactClass: classified.impactClass,
        urgencyClass: classified.urgencyClass,
        timeHorizon: classified.timeHorizon,
        confidenceClass: classified.confidenceClass,
        evidenceQualityScore: classified.evidenceQualityScore,
        priorityScore: classified.priorityScore,
        priorityClass: classified.priorityClass,
        strategicRiskClass: decision.strategicRiskClass,
        governanceDecisionId: decision.governanceDecisionId,
        governanceDecision: decision.decision,
        status: nextStatus,
        validUntil: classified.validUntil,
        supersedesCandidateId: null,
      });
      await transitionStrategicCandidateStatus(input.executor, {
        userId: input.userId,
        candidateId: row.candidateId,
        expectedVersion: Number(row.version),
        nextStatus,
        nextCandidateFingerprint: nextFingerprint,
      });
      await recordLifecycleFact({
        userId: input.userId,
        candidateId: row.candidateId,
        lifecycleType: "governance_binding",
        targetStatus: nextStatus,
        successorCandidateId: null,
        occurredAt,
        reasonCode: "GOVERNANCE_REVALIDATED",
        executor: input.executor,
      });
      refreshedRow = (await getStrategicCandidate(input.executor, input.userId, row.candidateId)) ?? row;
    }
  }

  const approvalStatus = await deriveCandidateApprovalStatus({
    row: refreshedRow,
    userId: input.userId,
    approvals: input.deps.approvals,
  });
  return { candidate: toCandidateView({ row: refreshedRow, approvalStatus, nowMs }), successor: null };
}

// ─── R9 mission-control handoff (E8) ───

export interface MissionControlHandoffResult {
  readonly contractVersion: typeof STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION;
  readonly projections: readonly StrategicMissionControlProjection[];
}

export async function getMissionControlHandoff(input: {
  userId: number;
  businessId: number;
  includeNonGoverned: boolean;
  deps: StrategicOpportunityRiskDeps;
  executor: StrategicOpportunityRiskStoreExecutor;
}): Promise<MissionControlHandoffResult> {
  const nowMs = resolveNow(input.deps).getTime();
  await assertBusinessOwnership(input.executor, input.userId, input.businessId);
  const rows = await listStrategicCandidateRows(input.executor, input.userId, {
    businessId: input.businessId,
  });
  const currentPolicyVersion = input.deps.governance.getCurrentPolicyVersion();
  const projections: StrategicMissionControlProjection[] = [];
  for (const row of rows) {
    const approvalStatus = await deriveCandidateApprovalStatus({
      row,
      userId: input.userId,
      approvals: input.deps.approvals,
    });
    const projection = buildMissionControlProjection({
      row: row as unknown as Record<string, unknown>,
      approvalStatus,
      nowMs,
    });
    const validated = validateMissionControlProjection(projection);
    // Governance consumption gate (the ONLY eligibility path).
    const record =
      typeof row.governanceRecord === "object" && row.governanceRecord !== null
        ? (row.governanceRecord as Record<string, unknown>)
        : null;
    const verdict = assertCandidateConsumable({
      decision: {
        governanceDecisionId: row.governanceDecisionId ?? "",
        decision: (row.governanceDecision ?? "BLOCK") as "ALLOW_RECOMMENDATION" | "REVIEW_REQUIRED" | "BLOCK",
        policyVersion: row.policyVersion ?? "",
        validUntil: row.validUntil,
        evidenceFingerprint: typeof record?.evidenceFingerprint === "string" ? record.evidenceFingerprint : "",
        proposalFingerprint: typeof record?.proposalFingerprint === "string" ? record.proposalFingerprint : "",
      },
      approvals: (
        await input.deps.approvals.listApprovalsForDecision({
          userId: input.userId,
          governanceDecisionId: row.governanceDecisionId ?? "",
        })
      ).map((a) => a),
      currentPolicyVersion,
      now: new Date(nowMs).toISOString(),
    });
    const governed = verdict.consumable && validated.freshness === "current";
    if (governed) {
      projections.push(validated);
    } else if (input.includeNonGoverned) {
      projections.push(validated);
    }
  }
  projections.sort((a, b) => {
    if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });
  return {
    contractVersion: STRATEGIC_OPPORTUNITY_RISK_PROJECTION_VERSION,
    projections,
  };
}
