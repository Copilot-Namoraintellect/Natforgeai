// ─── R8-A Strategic Memory — R7 / governed upstream consumption seam ───
//
// R8-A consumes R7 evidence EXCLUSIVELY through the frozen projection
// surfaces defined by docs/contracts/business-optimisation-to-strategic-intelligence-contract.md,
// via the upstream stores' own read + integrity-assertion + projection-builder
// paths (house seam pattern — R7-B's attribution-outcome-seam is the model).
// Production reads run against the canonical R7 tables behind the upstream
// stores' tenant predicates; every row is re-validated for tenant + business
// ownership, frozen contract version and (where applicable) immutable-core
// integrity. When an upstream row is absent the seam fail-closed degrades to
// STRATEGIC_MEMORY_SOURCE_UNKNOWN — memory is never fabricated.
//
// Truth preservation is binding (contract §6.4): this seam never reclassifies
// upstream evidence into stronger truth than its source supports. Attribution
// stays association (verbatim disclaimers travel into limitations); learning
// confidence/contradiction/novelty and experiment design-assumption
// limitations are preserved; optimisation memory keeps its governance block,
// validUntil and both disclaimers. R8-A never writes any upstream table.

import { and, eq } from "drizzle-orm";
import { businessDnaSnapshots, experimentResults, strategySnapshots } from "@db/schema";
import { StrategicMemoryInputError, StrategicMemoryOwnershipError } from "./strategic-memory-contract";
import {
  STRATEGIC_MEMORY_SOURCE_VERSIONS,
  deriveConfidenceFromAttributionEvidence,
  deriveConfidenceFromEngineConfidence,
  deriveConfidenceFromLearningConfidence,
  deriveConfidenceFromOutcomeAuthority,
  type StrategicMemoryConfidenceClass,
  type StrategicMemorySourceAuthority,
  type StrategicMemoryType,
} from "./strategic-memory-contract";
import { deriveSourceFingerprint, type StrategicMemoryContextScope } from "./strategic-memory-identity";
import type { StrategicMemoryStoreExecutor } from "./strategic-memory-store";

import {
  assertOutcomeEvidenceIntegrity,
  getOutcomeByOutcomeId,
  listOutcomeLifecycleEvents,
} from "../outcome/outcome-store";
import { buildOutcomeProjection } from "../outcome/outcome-projection";
import { OUTCOME_PROJECTION_CONTRACT_VERSION } from "../outcome/outcome-contract";
import { getAttributionById } from "../attribution/attribution-store";
import { buildAttributionLearningProjection } from "../attribution/attribution-projection";
import { ATTRIBUTION_LEARNING_CONTRACT_VERSION } from "../attribution/attribution-contract";
import { getLearningByLearningId, listLifecycleEventsForLearning } from "../business-learning/business-learning-store";
import { getExperimentById, getResultById } from "../experimentation/experimentation-store";
import { buildResultHandoffProjection, SCOPED_CAUSAL_EVIDENCE_CLAIM } from "../experimentation/experimentation-projection";
import { EXPERIMENT_RESULT_PROJECTION_VERSION } from "../experimentation/experimentation-contract";
import { getStrategyHandoffProjection } from "../budget-portfolio/budget-portfolio-service";
import { getOptimisationGovernanceDecision } from "../optimisation-governance/optimisation-governance-store";

/** The consumed upstream material for one ingest (server-loaded only). */
export interface ConsumedUpstreamEvidence {
  sourceAuthority: StrategicMemorySourceAuthority;
  sourceVersion: string;
  sourceIdentity: string;
  sourceFingerprint: string;
  memoryType: StrategicMemoryType;
  statement: unknown;
  subjectType: string;
  subjectId: string;
  evidenceRefs: string[];
  confidenceClass: StrategicMemoryConfidenceClass;
  limitations: string[];
  validFrom: string;
  observedAt: string;
  recordedAtUpstream: string;
  contextScope: StrategicMemoryContextScope;
  /** Upstream identity this record supersedes (upstream lineage chain). */
  supersedesUpstreamIdentity: string | null;
  /** Upstream identities whose invalidation this record records (reversals etc.). */
  invalidatesUpstreamIdentities: string[];
  /** This upstream row itself is terminal-negative (reversed/contradicted/...). */
  upstreamTerminalNegative: boolean;
  /** Governance validity bound carried verbatim (R7-E / R7-F). */
  governanceValidUntil: string | null;
}

const OUTCOME_ID_PATTERN = /^out1:[a-f0-9]{64}$/;
const ATTRIBUTION_ID_PATTERN = /^atr1:[a-f0-9]{64}$/;
const LEARNING_ID_PATTERN = /^lrn1:[a-f0-9]{64}$/;
const EXPERIMENT_ID_PATTERN = /^exp1:[a-f0-9]{64}$/;
const EXPERIMENT_RESULT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
const OPTIMISATION_ID_PATTERN = /^opt1:[a-f0-9]{64}$/;
const GOVERNANCE_ID_PATTERN = /^ogd1[:_][A-Za-z0-9]{1,64}$/;
const DNA_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-]{1,127}$/;
const STRATEGY_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-]{1,127}$/;

function fingerprint(authority: string, identity: string, version: string, material: Record<string, unknown>): string {
  return deriveSourceFingerprint({ sourceAuthority: authority, sourceIdentity: identity, sourceVersion: version, material });
}

function assertBusinessOwnership(rowUserId: number, rowBusinessId: number, userId: number, businessId: number, what: string): void {
  if (rowUserId !== userId) {
    throw new StrategicMemoryOwnershipError(
      "STRATEGIC_MEMORY_CROSS_TENANT_EVIDENCE",
      `${what} belongs to a different tenant.`
    );
  }
  if (rowBusinessId !== businessId) {
    throw new StrategicMemoryOwnershipError(
      "STRATEGIC_MEMORY_CROSS_BUSINESS_EVIDENCE",
      `${what} belongs to business ${rowBusinessId}, not ${businessId}. Cross-business evidence is rejected.`
    );
  }
}

function businessScope(): StrategicMemoryContextScope {
  return { scopeType: "BUSINESS", campaignId: null, businessDnaSnapshotId: null };
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  // Timestamp strings may already be ISO; normalize via Date when parseable.
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

// ─── r7_outcome (R7-A conversion-outcome/v1) ───

async function loadOutcomeEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!OUTCOME_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an out1: outcome identity.`);
  }
  const row = await getOutcomeByOutcomeId(userId, sourceIdentity, db);
  if (!row) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `outcome ${sourceIdentity} not found for the authenticated tenant.`);
  }
  assertOutcomeEvidenceIntegrity(row as never);
  assertBusinessOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Outcome ${sourceIdentity}`);
  const lifecycle = await listOutcomeLifecycleEvents(userId, sourceIdentity, db);
  const projection = buildOutcomeProjection(row as never, lifecycle as never) as unknown as Record<string, unknown>;
  if (projection.contractVersion !== OUTCOME_PROJECTION_CONTRACT_VERSION) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED",
      `outcome projection version ${String(projection.contractVersion)} is not the frozen ${OUTCOME_PROJECTION_CONTRACT_VERSION}.`
    );
  }
  const version = OUTCOME_PROJECTION_CONTRACT_VERSION;
  const terminalNegative = ["REVERSED", "CANCELLED"].includes(row.outcomeStatus);
  const isSupersession = row.supersedesOutcomeId != null;
  const isReversal = row.reversesOutcomeId != null;
  const amountMinor = row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor);
  const statement = {
    template: "R7_OUTCOME_PATTERN",
    fields: {
      outcomeId: row.outcomeId,
      outcomeType: row.outcomeType,
      outcomeStatus: row.outcomeStatus,
      valueType: row.valueType,
      amountMinor,
      currency: row.currency ?? null,
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      metricUnit: row.metricUnit ?? null,
      evidenceAuthority: row.evidenceAuthority,
      occurredAt: row.occurredAt,
    },
  };
  const limitations = [
    "Derived from a canonical R7-A business outcome; outcome truth remains R7-A authority.",
    String(projection.causationDisclaimer),
    String(projection.attributionDisclaimer),
  ];
  return {
    sourceAuthority: "r7_outcome",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_outcome", sourceIdentity, version, projection),
    memoryType: "OUTCOME_PATTERN",
    statement,
    subjectType: "OUTCOME",
    subjectId: row.outcomeId,
    evidenceRefs: [row.outcomeId, row.conversionId],
    confidenceClass: deriveConfidenceFromOutcomeAuthority(row.evidenceAuthority),
    limitations,
    validFrom: row.occurredAt,
    observedAt: row.occurredAt,
    recordedAtUpstream: row.recordedAt,
    contextScope: businessScope(),
    supersedesUpstreamIdentity: isSupersession ? row.supersedesOutcomeId! : null,
    invalidatesUpstreamIdentities: isReversal ? [row.reversesOutcomeId!] : [],
    upstreamTerminalNegative: terminalNegative,
    governanceValidUntil: null,
  };
}

// ─── r7_attribution (R7-B attribution-to-learning/v1) ───

async function loadAttributionEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!ATTRIBUTION_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an atr1: attribution identity.`);
  }
  const row = await getAttributionById(userId, sourceIdentity, db);
  if (!row) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `attribution ${sourceIdentity} not found for the authenticated tenant.`);
  }
  assertBusinessOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Attribution ${sourceIdentity}`);
  const projection = buildAttributionLearningProjection(row) as unknown as Record<string, unknown>;
  if (projection.contractVersion !== ATTRIBUTION_LEARNING_CONTRACT_VERSION) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED",
      `attribution projection version ${String(projection.contractVersion)} is not the frozen ${ATTRIBUTION_LEARNING_CONTRACT_VERSION}.`
    );
  }
  if (projection.causationClaimed !== false) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_FINGERPRINT_CONFLICT", "attribution projection claims causation; frozen contract forbids it.");
  }
  const version = ATTRIBUTION_LEARNING_CONTRACT_VERSION;
  const touchpoints = Array.isArray(projection.touchpoints) ? projection.touchpoints.length : 0;
  const statement = {
    template: "R7_ATTRIBUTION_ASSOCIATION",
    fields: {
      attributionId: row.attributionId,
      outcomeId: row.outcomeId,
      modelType: row.modelType,
      modelVersion: row.modelVersion,
      totalCreditBps: Number(row.totalCreditBps),
      touchpointCount: touchpoints,
      evidenceClass: row.evidenceClass,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
    },
  };
  const limitations = [
    "Association evidence only — attribution credit is not causal proof and never becomes a causal fact in strategic memory.",
    String(projection.causationDisclaimer),
    String(projection.attributionDisclaimer),
  ];
  return {
    sourceAuthority: "r7_attribution",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_attribution", sourceIdentity, version, projection),
    memoryType: "OUTCOME_PATTERN",
    statement,
    subjectType: "ATTRIBUTION",
    subjectId: row.attributionId,
    evidenceRefs: [row.attributionId, row.outcomeId],
    confidenceClass: deriveConfidenceFromAttributionEvidence(row.evidenceClass),
    limitations,
    validFrom: String(row.calculatedAt),
    observedAt: String(row.calculatedAt),
    recordedAtUpstream: String(row.calculatedAt),
    contextScope: businessScope(),
    supersedesUpstreamIdentity: row.supersedesAttributionId ?? null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: false,
    governanceValidUntil: null,
  };
}

// ─── r7_learning (R7-C business learning projections) ───

async function loadLearningEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!LEARNING_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an lrn1: learning identity.`);
  }
  const row = await getLearningByLearningId(userId, sourceIdentity, db);
  if (!row) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `learning ${sourceIdentity} not found for the authenticated tenant.`);
  }
  assertBusinessOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Learning ${sourceIdentity}`);
  const lifecycle = await listLifecycleEventsForLearning(userId, sourceIdentity, db);
  const version = STRATEGIC_MEMORY_SOURCE_VERSIONS.r7_learning;
  const contradicted = row.status === "CONTRADICTED";
  // Learning context scopes are R7-C-shaped; memory scopes are the bounded
  // R8-A shape. Narrow deterministically: single-campaign scope → CAMPAIGN,
  // otherwise BUSINESS. Never wider than the verified business.
  const learningScope = row.contextScope as { campaignIds?: unknown } | null;
  const campaignIds = Array.isArray(learningScope?.campaignIds) ? (learningScope!.campaignIds as unknown[]) : [];
  const memoryScope: StrategicMemoryContextScope =
    campaignIds.length === 1
      ? { scopeType: "CAMPAIGN", campaignId: Number(campaignIds[0]), businessDnaSnapshotId: null }
      : { scopeType: "BUSINESS", campaignId: null, businessDnaSnapshotId: null };
  const statement = {
    template: "R7_LEARNING_PATTERN",
    fields: {
      learningId: row.learningId,
      learningType: row.learningType,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      statement: row.statement,
      confidenceClass: row.confidenceClass,
      evidenceClass: row.evidenceClass,
      noveltyClass: row.noveltyClass,
      status: row.status,
      supportCount: Number(row.supportCount),
      contradictionCount: Number(row.contradictionCount),
      derivedAt: row.derivedAt,
      lifecycleStatuses: lifecycle.map((f) => f.status),
    },
  };
  const limitations = [
    ...(row.limitations as string[]),
    `Learning truth remains R7-C authority; confidence ${row.confidenceClass} and contradictions (${Number(row.contradictionCount)}) preserved verbatim.`,
  ];
  return {
    sourceAuthority: "r7_learning",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_learning", sourceIdentity, version, statement.fields as unknown as Record<string, unknown>),
    memoryType: "LEARNING_PATTERN",
    statement,
    subjectType: "LEARNING",
    subjectId: row.learningId,
    evidenceRefs: [row.learningId, ...(row.outcomeIds as string[])],
    confidenceClass: deriveConfidenceFromLearningConfidence(row.confidenceClass),
    limitations,
    validFrom: row.derivedAt,
    observedAt: row.derivedAt,
    recordedAtUpstream: row.derivedAt,
    contextScope: memoryScope,
    supersedesUpstreamIdentity: row.supersedesLearningId ?? null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: contradicted,
    governanceValidUntil: row.validUntil ?? null,
  };
}

// ─── r7_experimentation (R7-D experimentation result handoff) ───

async function loadExperimentEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  let experimentId = sourceIdentity;
  if (EXPERIMENT_RESULT_ID_PATTERN.test(sourceIdentity)) {
    const result = await getResultById(userId, sourceIdentity, db);
    if (!result) {
      throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `experiment result ${sourceIdentity} not found for the authenticated tenant.`);
    }
    experimentId = result.experimentId;
  } else if (!EXPERIMENT_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an exp1:/exr1: identity.`);
  }
  const experiment = await getExperimentById(userId, experimentId, db);
  if (!experiment) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `experiment ${experimentId} not found for the authenticated tenant.`);
  }
  assertBusinessOwnership(Number(experiment.userId), Number(experiment.businessId), userId, businessId, `Experiment ${experimentId}`);
  // Resolve the effective result for this experiment: an explicit exr1:
  // source binds that result; an exp1: source binds the latest stored result.
  let effectiveResult: import("@db/schema").ExperimentResultRow | null = null;
  if (EXPERIMENT_RESULT_ID_PATTERN.test(sourceIdentity)) {
    const byId = await getResultById(userId, sourceIdentity, db);
    effectiveResult = byId && byId.experimentId === experimentId ? byId : null;
  } else {
    const [latest] = await db
      .select()
      .from(experimentResults)
      .where(and(eq(experimentResults.userId, userId), eq(experimentResults.experimentId, experiment.experimentId)))
      .limit(1);
    effectiveResult = latest ?? null;
  }
  const projection = buildResultHandoffProjection({ experiment, result: effectiveResult }) as unknown as Record<string, unknown>;
  if (projection.contractVersion !== EXPERIMENT_RESULT_PROJECTION_VERSION) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED",
      `experiment result projection version ${String(projection.contractVersion)} is not the frozen ${EXPERIMENT_RESULT_PROJECTION_VERSION}.`
    );
  }
  const version = EXPERIMENT_RESULT_PROJECTION_VERSION;
  const statement = {
    template: "R7_EXPERIMENT_RESULT",
    fields: {
      experimentId: experiment.experimentId,
      resultId: effectiveResult?.resultId ?? null,
      designType: experiment.designType,
      dimension: experiment.dimension,
      resultStatus: projection.resultStatus,
      confidenceClass: projection.confidenceClass,
      conclusion: projection.conclusion,
      calculatedAt: effectiveResult?.calculatedAt ?? null,
      experimentStatus: experiment.status,
    },
  };
  const limitations = [
    ...((effectiveResult?.limitations ?? []) as string[]).map((l) => String(l)),
    SCOPED_CAUSAL_EVIDENCE_CLAIM,
    "Scoped causal evidence within the governed design only; it does not generalise beyond the recorded design assumptions.",
  ];
  const experimentObservedAt = toIsoString(effectiveResult?.calculatedAt ?? experiment.createdAt);
  return {
    sourceAuthority: "r7_experimentation",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_experimentation", sourceIdentity, version, projection),
    memoryType: "EXPERIMENT_RESULT",
    statement,
    subjectType: "EXPERIMENT",
    subjectId: experiment.experimentId,
    evidenceRefs: [experiment.experimentId, ...(effectiveResult ? [effectiveResult.resultId] : [])],
    confidenceClass: deriveConfidenceFromEngineConfidence(String(projection.confidenceClass)),
    limitations,
    validFrom: experimentObservedAt,
    observedAt: experimentObservedAt,
    recordedAtUpstream: experimentObservedAt,
    contextScope: businessScope(),
    supersedesUpstreamIdentity: null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: ["INVALIDATED", "CANCELLED"].includes(experiment.status),
    governanceValidUntil: null,
  };
}

// ─── r7_budget_portfolio (R7-E business-optimisation-to-strategy/v1) ───

async function loadOptimisationEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!OPTIMISATION_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an opt1: optimisation identity.`);
  }
  let projection: Record<string, unknown>;
  try {
    projection = (await getStrategyHandoffProjection({ userId, optimisationId: sourceIdentity }, db as never)) as unknown as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "OPTIMISATION_NOT_FOUND") {
      throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `optimisation proposal ${sourceIdentity} not found for the authenticated tenant.`);
    }
    throw err;
  }
  if (projection.contractVersion !== STRATEGIC_MEMORY_SOURCE_VERSIONS.r7_budget_portfolio) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED",
      `optimisation projection version ${String(projection.contractVersion)} is not the frozen ${STRATEGIC_MEMORY_SOURCE_VERSIONS.r7_budget_portfolio}.`
    );
  }
  if (projection.businessId !== businessId) {
    throw new StrategicMemoryOwnershipError(
      "STRATEGIC_MEMORY_CROSS_BUSINESS_EVIDENCE",
      `optimisation ${sourceIdentity} belongs to business ${String(projection.businessId)}, not ${businessId}.`
    );
  }
  if (projection.causationClaimed !== false || projection.attributionClaimed !== false) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_FINGERPRINT_CONFLICT", "optimisation projection claims causation/attribution; frozen contract forbids it.");
  }
  const version = STRATEGIC_MEMORY_SOURCE_VERSIONS.r7_budget_portfolio;
  const governance = projection.governance as Record<string, unknown> | null;
  const statement = {
    template: "R7_OPTIMISATION_DECISION",
    fields: {
      optimisationId: projection.optimisationId,
      budgetPeriod: projection.budgetPeriod,
      objective: projection.objective,
      status: projection.status,
      deltaCount: Array.isArray(projection.deltaAllocations) ? (projection.deltaAllocations as unknown[]).length : 0,
      confidenceClass: projection.confidenceClass,
      reasonCodes: projection.reasonCodes,
      governance: governance ?? null,
      authorisation: projection.authorisation ?? null,
      algorithmVersion: projection.algorithmVersion,
      createdAt: projection.createdAt,
    },
  };
  const limitations = [
    "Optimisation proposes; governance authorizes; R4 settles. This memory is planning context, never execution permission.",
    String(projection.causationDisclaimer),
    String(projection.attributionDisclaimer),
    ...(governance?.decision ? [`Bound to governance decision ${String(governance.governanceDecisionId)} (${String(governance.decision)}); authority never widens downstream.`] : []),
  ];
  return {
    sourceAuthority: "r7_budget_portfolio",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_budget_portfolio", sourceIdentity, version, projection),
    memoryType: "OPTIMISATION_DECISION",
    statement,
    subjectType: "OPTIMISATION",
    subjectId: String(projection.optimisationId),
    evidenceRefs: [String(projection.optimisationId), ...((projection.evidenceRefs as string[]) ?? [])],
    confidenceClass: deriveConfidenceFromEngineConfidence(String(projection.confidenceClass)),
    limitations,
    validFrom: String(projection.createdAt),
    observedAt: String(projection.createdAt),
    recordedAtUpstream: String(projection.createdAt),
    contextScope: { scopeType: "PORTFOLIO", campaignId: null, businessDnaSnapshotId: null },
    supersedesUpstreamIdentity: null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: false,
    governanceValidUntil: (projection.validUntil as string | null) ?? null,
  };
}

// ─── r7_governance (R7-F optimisation-governance/v1) ───

async function loadGovernanceEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!GOVERNANCE_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an ogd1: governance identity.`);
  }
  let row;
  try {
    row = await getOptimisationGovernanceDecision(userId, sourceIdentity, db as never);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "GOVERNANCE_DECISION_NOT_FOUND") {
      throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `governance decision ${sourceIdentity} not found for the authenticated tenant.`);
    }
    throw err;
  }
  assertBusinessOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Governance decision ${sourceIdentity}`);
  const version = STRATEGIC_MEMORY_SOURCE_VERSIONS.r7_governance;
  if (row.contractVersion !== version) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED",
      `governance decision version ${row.contractVersion} is not the frozen ${version}.`
    );
  }
  const reasonCodes = Array.isArray(row.reasonCodes) ? (row.reasonCodes as unknown[]).map(String) : [];
  const statement = {
    template: "R7_GOVERNANCE_DECISION",
    fields: {
      governanceDecisionId: row.governanceDecisionId,
      proposalId: row.proposalId,
      proposalType: row.proposalType,
      decision: row.decision,
      riskClass: row.riskClass,
      financialImpactClass: row.financialImpactClass,
      approvalRequired: row.approvalRequired,
      policyVersion: row.policyVersion ?? null,
      reasonCodes,
      evaluatedAt: row.evaluatedAt,
    },
  };
  const limitations = [
    "Governance decides whether an optimisation may proceed — never which action is optimal. Authority only ever narrows downstream.",
    row.validUntil ? `Governance validity bound: ${row.validUntil}; expiry is computed, never silently refreshed.` : "No governance validity bound recorded.",
  ];
  return {
    sourceAuthority: "r7_governance",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("r7_governance", sourceIdentity, version, statement.fields as unknown as Record<string, unknown>),
    memoryType: "OPTIMISATION_DECISION",
    statement,
    subjectType: "GOVERNANCE",
    subjectId: row.governanceDecisionId,
    evidenceRefs: [row.governanceDecisionId, row.proposalId],
    confidenceClass: "VERIFIED",
    limitations,
    validFrom: row.evaluatedAt,
    observedAt: row.evaluatedAt,
    recordedAtUpstream: row.evaluatedAt,
    contextScope: { scopeType: "PORTFOLIO", campaignId: null, businessDnaSnapshotId: null },
    supersedesUpstreamIdentity: null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: false,
    governanceValidUntil: row.validUntil ?? null,
  };
}

// ─── business_dna (governed derivation from hash-verified DNA snapshots) ───

async function loadBusinessDnaEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!DNA_SNAPSHOT_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not a business DNA snapshot id.`);
  }
  // Read the durable row directly: tenant + business ownership are absolute
  // and the canonical projection does not carry the tenant id.
  const [row] = (await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.snapshotId, sourceIdentity))
    .limit(1)) as unknown as Array<Record<string, unknown>>;
  if (!row) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `business DNA snapshot ${sourceIdentity} not found.`);
  }
  if (Number(row.userId) !== userId) {
    throw new StrategicMemoryOwnershipError("STRATEGIC_MEMORY_CROSS_TENANT_EVIDENCE", `business DNA snapshot ${sourceIdentity} belongs to a different tenant.`);
  }
  if (Number(row.businessId) !== businessId) {
    throw new StrategicMemoryOwnershipError("STRATEGIC_MEMORY_CROSS_BUSINESS_EVIDENCE", `business DNA snapshot ${sourceIdentity} belongs to a different business.`);
  }
  const version = STRATEGIC_MEMORY_SOURCE_VERSIONS.business_dna;
  const capturedAt = toIsoString(row.capturedAt as string | Date);
  const statement = {
    template: "BUSINESS_DNA_FACT",
    fields: {
      snapshotId: row.snapshotId,
      businessId: Number(row.businessId),
      version: Number(row.version),
      businessName: row.businessName,
      industry: row.industry,
      primaryOffering: row.primaryOffering,
      evidenceHashSha256: row.evidenceHashSha256,
      capturedAt,
    },
  };
  return {
    sourceAuthority: "business_dna",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("business_dna", sourceIdentity, version, {
      snapshotId: row.snapshotId,
      evidenceHashSha256: row.evidenceHashSha256,
      payload: row.snapshot,
    }),
    memoryType: "BUSINESS_FACT",
    statement,
    subjectType: "BUSINESS",
    subjectId: `business:${businessId}`,
    evidenceRefs: [String(row.snapshotId)],
    confidenceClass: "AUTHORITATIVE",
    limitations: [
      `Derived from Business DNA snapshot ${String(row.snapshotId)} v${Number(row.version)}; Business DNA remains the authoritative source — re-derive on DNA change.`,
    ],
    validFrom: capturedAt,
    observedAt: capturedAt,
    recordedAtUpstream: capturedAt,
    contextScope: { scopeType: "BUSINESS", campaignId: null, businessDnaSnapshotId: String(row.snapshotId) },
    supersedesUpstreamIdentity: null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: false,
    governanceValidUntil: null,
  };
}

// ─── strategy_snapshot (strategy-history derivation) ───

async function loadStrategySnapshotEvidence(
  userId: number,
  businessId: number,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  if (!STRATEGY_SNAPSHOT_ID_PATTERN.test(sourceIdentity)) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not a strategy snapshot id.`);
  }
  const [row] = (await db
    .select()
    .from(strategySnapshots)
    .where(eq(strategySnapshots.snapshotId, sourceIdentity))
    .limit(1)) as unknown as Array<Record<string, unknown>>;
  if (!row) {
    throw new StrategicMemoryInputError("STRATEGIC_MEMORY_SOURCE_UNKNOWN", `strategy snapshot ${sourceIdentity} not found.`);
  }
  if (Number(row.userId) !== userId) {
    throw new StrategicMemoryOwnershipError("STRATEGIC_MEMORY_CROSS_TENANT_EVIDENCE", `strategy snapshot ${sourceIdentity} belongs to a different tenant.`);
  }
  if (Number(row.businessId) !== businessId) {
    throw new StrategicMemoryOwnershipError("STRATEGIC_MEMORY_CROSS_BUSINESS_EVIDENCE", `strategy snapshot ${sourceIdentity} belongs to a different business.`);
  }
  const version = STRATEGIC_MEMORY_SOURCE_VERSIONS.strategy_snapshot;
  const capturedAt = row.capturedAt instanceof Date ? row.capturedAt.toISOString() : String(row.capturedAt);
  const statement = {
    template: "STRATEGY_SNAPSHOT_RECORD",
    fields: {
      snapshotId: row.snapshotId,
      campaignId: Number(row.campaignId),
      version: Number(row.version),
      strategyHashSha256: row.strategyHashSha256,
      businessDnaSnapshotId: row.businessDnaSnapshotId,
      capturedAt,
    },
  };
  return {
    sourceAuthority: "strategy_snapshot",
    sourceVersion: version,
    sourceIdentity,
    sourceFingerprint: fingerprint("strategy_snapshot", sourceIdentity, version, statement.fields as unknown as Record<string, unknown>),
    memoryType: "STRATEGIC_DECISION",
    statement,
    subjectType: "CAMPAIGN",
    subjectId: `campaign:${Number(row.campaignId)}`,
    evidenceRefs: [String(row.snapshotId)],
    confidenceClass: "AUTHORITATIVE",
    limitations: [
      `Strategy snapshot ${String(row.snapshotId)} v${Number(row.version)} for campaign ${Number(row.campaignId)}; strategy authority remains with the snapshot owner.`,
    ],
    validFrom: capturedAt,
    observedAt: capturedAt,
    recordedAtUpstream: capturedAt,
    contextScope: { scopeType: "CAMPAIGN", campaignId: Number(row.campaignId), businessDnaSnapshotId: null },
    supersedesUpstreamIdentity: null,
    invalidatesUpstreamIdentities: [],
    upstreamTerminalNegative: false,
    governanceValidUntil: null,
  };
}

// ─── dispatch ───

/**
 * Load and validate the authoritative upstream material for one ingest.
 * Fail-closed on unknown source, cross-tenant/cross-business evidence,
 * stale contract versions and tamper-shaped material. Never writes upstream.
 */
export async function loadUpstreamEvidence(
  userId: number,
  businessId: number,
  sourceAuthority: StrategicMemorySourceAuthority,
  sourceIdentity: string,
  db: StrategicMemoryStoreExecutor
): Promise<ConsumedUpstreamEvidence> {
  switch (sourceAuthority) {
    case "r7_outcome":
      return loadOutcomeEvidence(userId, businessId, sourceIdentity, db);
    case "r7_attribution":
      return loadAttributionEvidence(userId, businessId, sourceIdentity, db);
    case "r7_learning":
      return loadLearningEvidence(userId, businessId, sourceIdentity, db);
    case "r7_experimentation":
      return loadExperimentEvidence(userId, businessId, sourceIdentity, db);
    case "r7_budget_portfolio":
      return loadOptimisationEvidence(userId, businessId, sourceIdentity, db);
    case "r7_governance":
      return loadGovernanceEvidence(userId, businessId, sourceIdentity, db);
    case "business_dna":
      return loadBusinessDnaEvidence(userId, businessId, sourceIdentity, db);
    case "strategy_snapshot":
      return loadStrategySnapshotEvidence(userId, businessId, sourceIdentity, db);
    default:
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_SOURCE_UNKNOWN",
        `sourceAuthority ${String(sourceAuthority)} cannot mint memory through governed ingestion.`
      );
  }
}
