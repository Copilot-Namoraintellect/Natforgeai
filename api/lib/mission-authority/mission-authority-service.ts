// ─── R9-A Mission Authority — service authority ───
//
// Orchestrates governed mission formulation end to end: verify business
// ownership, resolve + revalidate the frozen R8 candidate through the single
// eligibility seam, run the deterministic rule-first formation (identity,
// objective, scope, constraints, validity, lineage), persist the immutable
// mission proposal exactly once under its convergence anchor, and emit
// exactly one audit event per inserted proposal (convergence emits zero).
// Revalidation derives lifecycle targets deterministically from the
// re-resolved source and records append-only misl1: facts; supersession
// mints a NEW mission — history is never edited.
//
// This stream never writes any upstream authority table, never plans tasks,
// never executes, and never becomes a governance engine (contract §1).

import { and, eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import {
  MISSION_AUTHORITY_BOUND_VERSIONS,
  MISSION_AUTHORITY_CONTRACT_VERSION,
  MISSION_AUTHORITY_ENGINE_VERSION,
  MAX_LIMITATIONS,
  MissionAuthorityError,
  assertBoundedText,
  fail,
  type MissionCancelReasonCode,
  type MissionStatus,
  type PriorityContext,
  type StrategicRiskClass,
} from "./mission-authority-contract";
import {
  deriveConstraintSetFingerprint,
  deriveLifecycleEventId,
  deriveLineageHash,
  deriveMissionFingerprint,
  deriveMissionId,
  deriveObjectiveFingerprint,
  deriveObjectiveId,
  deriveScopeKey,
} from "./mission-authority-identity";
import {
  assertConfidenceClass,
  assertStrategicRiskClass,
  buildDerivedConstraints,
  buildScope,
  deriveFromCandidateType,
  deriveGovernanceRequirements,
  deriveValidityWindow,
  resolveObjectiveWording,
  validateAssumptions,
  validateClientConstraints,
  validateSuccessCriteria,
  type MissionScope,
  type ValidatedAssumption,
  type ValidatedConstraint,
  type ValidatedSuccessCriterion,
} from "./mission-authority-formation";
import {
  assertTransitionAllowed,
  isTerminalMissionStatus,
  lifecycleTypeForTarget,
  resolveFailedSourceTarget,
  resolveGovernedSourceTarget,
} from "./mission-authority-lifecycle";
import {
  resolveGovernedCandidate,
  type MissionCandidateAuthorityDeps,
  type MissionCandidateRowPort,
} from "./mission-authority-candidate-seam";
import {
  buildMissionPlanningProjection,
  isPlanningConsumable,
  validateMissionPlanningProjection,
  MISSION_PLANNING_PROJECTION_VERSION,
  type MissionPlanningProjection,
} from "./mission-authority-projection";
import {
  getMissionProposal,
  insertMissionLifecycleEvent,
  insertMissionProposal,
  listMissionLifecycleRows,
  listMissionProposalRows,
  transitionMissionStatus,
  type MissionAuthorityStoreExecutor,
  type MissionProposalRow,
} from "./mission-authority-store";

// ─── Dependencies ───

export interface MissionAuthorityDeps extends MissionCandidateAuthorityDeps {
  /** Durable R8-E candidate row read (production raw-SQL / in-memory fake). */
  readonly candidateRows: MissionCandidateRowPort;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function resolveNow(deps: MissionAuthorityDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function asAuditExecutor(executor: MissionAuthorityStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

// ─── Business authority (canonical table, re-verified every call) ───

async function assertBusinessOwnership(
  executor: MissionAuthorityStoreExecutor,
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

// ─── Mission view (API surface) ───

export interface MissionProposalView {
  readonly missionId: string;
  readonly objectiveId: string;
  readonly businessId: number;
  readonly sourceCandidateId: string;
  readonly sourceReasoningIds: readonly string[];
  readonly missionType: string;
  readonly objectiveType: string;
  readonly objectiveStatement: string;
  readonly objectiveClientStatement: string;
  readonly objectiveWordingDraft: string | null;
  readonly modelAssistanceFlagged: boolean;
  readonly expectedOutcome: string;
  readonly successCriteria: readonly ValidatedSuccessCriterion[];
  readonly constraints: readonly ValidatedConstraint[];
  readonly assumptions: readonly ValidatedAssumption[];
  readonly scope: MissionScope;
  readonly priorityContext: PriorityContext;
  readonly strategicRisk: StrategicRiskClass;
  readonly confidenceClass: string;
  readonly governanceReference: {
    readonly governanceDecisionId: string | null;
    readonly governanceDecision: string | null;
    readonly policyVersion: string | null;
    readonly approvalRequirement: "none" | "human_review";
    readonly authorityScope: "RECOMMENDATION_ONLY";
  };
  readonly governanceRequirements: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly limitations: readonly string[];
  readonly status: MissionStatus;
  readonly freshness: "current" | "stale";
  readonly supersedesMissionId: string | null;
  readonly lineageHash: string;
  readonly missionFingerprint: string;
  readonly version: number;
  readonly createdAt: string;
}

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function parseJsonArray<T>(raw: unknown): readonly T[] {
  return Array.isArray(raw) ? (raw as readonly T[]) : [];
}

function toMissionView(input: { row: MissionProposalRow; nowMs: number }): MissionProposalView {
  const { row, nowMs } = input;
  const validUntil = typeof row.validUntil === "string" ? row.validUntil : "";
  const expired = validUntil.length > 0 && Date.parse(validUntil) < nowMs;
  const approvalRequirement =
    row.governanceDecision === "REVIEW_REQUIRED" ? ("human_review" as const) : ("none" as const);
  return {
    missionId: row.missionId,
    objectiveId: row.objectiveId,
    businessId: row.businessId,
    sourceCandidateId: row.sourceCandidateId,
    sourceReasoningIds: asStringArray(row.sourceReasoningIds),
    missionType: row.missionType,
    objectiveType: row.objectiveType,
    objectiveStatement: row.objectiveStatement,
    objectiveClientStatement: row.objectiveClientStatement,
    objectiveWordingDraft: row.objectiveWordingDraft,
    modelAssistanceFlagged: Boolean(row.modelAssistanceFlagged),
    expectedOutcome: row.expectedOutcome,
    successCriteria: parseJsonArray<ValidatedSuccessCriterion>(row.successCriteria),
    constraints: parseJsonArray<ValidatedConstraint>(row.constraints),
    assumptions: parseJsonArray<ValidatedAssumption>(row.assumptions),
    scope: (typeof row.scope === "object" && row.scope !== null
      ? row.scope
      : { subjectType: "", businessScope: row.businessId, channelScope: null, campaignScope: null, geography: null }) as MissionScope,
    priorityContext: row.priorityContext as PriorityContext,
    strategicRisk: row.strategicRiskClass as StrategicRiskClass,
    confidenceClass: row.confidenceClass,
    governanceReference: {
      governanceDecisionId: row.governanceDecisionId,
      governanceDecision: row.governanceDecision,
      policyVersion: row.policyVersion,
      approvalRequirement,
      authorityScope: "RECOMMENDATION_ONLY",
    },
    governanceRequirements: asStringArray(row.governanceRequirements),
    validFrom: row.validFrom,
    validUntil,
    limitations: asStringArray(row.limitations),
    status: row.status as MissionStatus,
    freshness: expired ? "stale" : "current",
    supersedesMissionId: row.supersedesMissionId,
    lineageHash: row.lineageHash,
    missionFingerprint: row.missionFingerprint,
    version: Number(row.version),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : typeof row.createdAt === "string"
          ? row.createdAt
          : "",
  };
}

// ─── Formation (A2–A4, A6) ───

export interface ProposeMissionResult {
  readonly contractVersion: typeof MISSION_AUTHORITY_CONTRACT_VERSION;
  readonly engineVersion: typeof MISSION_AUTHORITY_ENGINE_VERSION;
  readonly mission: MissionProposalView;
  /** True when this call inserted the durable proposal (convergence ⇒ false). */
  readonly inserted: boolean;
}

export async function proposeMission(
  input: {
    userId: number;
    businessId: number;
    sourceCandidateId: string;
    objectiveStatement: string;
    expectedOutcome: string;
    successCriteria: Parameters<typeof validateSuccessCriteria>[0];
    assumptions: Parameters<typeof validateAssumptions>[0];
    constraints: Parameters<typeof validateClientConstraints>[0];
    modelAssistance?: { draftWording: string };
    supersedesMissionId?: string;
  },
  deps: MissionAuthorityDeps,
  executor: MissionAuthorityStoreExecutor
): Promise<ProposeMissionResult> {
  const now = resolveNow(deps);
  const nowMs = now.getTime();
  await assertBusinessOwnership(executor, input.userId, input.businessId);

  // A6: resolve + revalidate the governed source (the ONLY eligibility path).
  const row = await deps.candidateRows.getCandidateRow({
    userId: input.userId,
    businessId: input.businessId,
    candidateId: input.sourceCandidateId,
  });
  const source = await resolveGovernedCandidate({
    userId: input.userId,
    businessId: input.businessId,
    candidateId: input.sourceCandidateId,
    row,
    deps,
  });

  // A3/A4: bounded client inputs (preserved verbatim, validated).
  const wording = resolveObjectiveWording({
    clientStatement: input.objectiveStatement,
    modelDraft: input.modelAssistance?.draftWording,
  });
  const expectedOutcome = assertBoundedText(
    input.expectedOutcome,
    500,
    "INVALID_EXPECTED_OUTCOME",
    "expectedOutcome"
  );
  const successCriteria = validateSuccessCriteria(input.successCriteria);
  const assumptions = validateAssumptions(input.assumptions);
  const clientConstraints = validateClientConstraints(input.constraints);

  // Deterministic derivation from the governed source (never client/model).
  const derivation = deriveFromCandidateType(source.candidateType);
  const strategicRiskClass = assertStrategicRiskClass(source.strategicRiskClass);
  const confidenceClass = assertConfidenceClass(source.confidenceClass);
  const scope = buildScope({ subjectType: derivation.scopeSubjectType, businessId: input.businessId });
  const scopeKey = deriveScopeKey({ subjectType: scope.subjectType, businessId: input.businessId });
  const validity = deriveValidityWindow({ validFromMs: nowMs, candidateValidUntil: source.validUntil });
  const derivedConstraints = buildDerivedConstraints({
    scope,
    strategicRiskClass,
    confidenceClass,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
  });
  const constraintSet: ValidatedConstraint[] = [...derivedConstraints, ...clientConstraints];
  const constraintSetFingerprint = deriveConstraintSetFingerprint(constraintSet);
  const governanceRequirements = deriveGovernanceRequirements({
    governanceDecision: source.governanceDecision,
  });

  // A2: deterministic identities.
  const missionId = deriveMissionId({
    userId: input.userId,
    businessId: input.businessId,
    sourceCandidateId: source.candidateId,
    missionType: derivation.missionType,
    scopeKey,
    constraintSetFingerprint,
  });
  const objectiveId = deriveObjectiveId({
    userId: input.userId,
    businessId: input.businessId,
    sourceCandidateId: source.candidateId,
    objectiveType: derivation.objectiveType,
    scopeKey,
    objectiveStatement: wording.statement,
  });
  const lineageHash = deriveLineageHash({
    sourceCandidateId: source.candidateId,
    sourceReasoningIds: source.reasoningIds,
    governanceDecisionId: source.governanceDecisionId,
    governanceDecision: source.governanceDecision,
    policyVersion: source.policyVersion,
    candidateFingerprint: source.candidateFingerprint,
    projectionVersion: MISSION_AUTHORITY_BOUND_VERSIONS.strategicIntelligenceToMissionControl,
  });
  const supersedesMissionId = input.supersedesMissionId ?? null;
  const missionFingerprint = deriveMissionFingerprint({
    missionId,
    sourceCandidateId: source.candidateId,
    missionType: derivation.missionType,
    objectiveType: derivation.objectiveType,
    expectedOutcome,
    strategicRiskClass,
    priorityContext: source.priorityClass,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    supersedesMissionId,
    lineageHash,
  });
  const objectiveFingerprint = deriveObjectiveFingerprint({
    objectiveId,
    objectiveType: derivation.objectiveType,
    objectiveStatement: wording.statement,
    scopeKey,
  });

  // Governed supersession: a live predecessor is required. A terminal
  // predecessor only tolerates the exact replay of the formulation that
  // superseded it (deterministic successor identity) — anything else fails.
  let predecessor: MissionProposalRow | null = null;
  if (supersedesMissionId) {
    predecessor = await getMissionProposal(executor, input.userId, supersedesMissionId);
    if (!predecessor) fail("PREDECESSOR_INVALID", `predecessor mission ${supersedesMissionId} not found`);
    if (predecessor.businessId !== input.businessId) {
      fail("PREDECESSOR_INVALID", "predecessor mission belongs to a different business scope");
    }
    if (isTerminalMissionStatus(predecessor.status as MissionStatus)) {
      const successorReplay =
        predecessor.status === "SUPERSEDED"
          ? await getMissionProposal(executor, input.userId, missionId)
          : null;
      if (
        successorReplay &&
        successorReplay.supersedesMissionId === supersedesMissionId &&
        successorReplay.missionFingerprint === missionFingerprint
      ) {
        return {
          contractVersion: MISSION_AUTHORITY_CONTRACT_VERSION,
          engineVersion: MISSION_AUTHORITY_ENGINE_VERSION,
          mission: toMissionView({ row: successorReplay, nowMs }),
          inserted: false,
        };
      }
      fail("PREDECESSOR_INVALID", `predecessor mission is already ${predecessor.status}`);
    }
  }

  // Convergence: a retried identical formulation replays the durable state
  // with zero extra events (the winner of the original race recorded any
  // supersession inside the same atomic transaction).
  const existing = await getMissionProposal(executor, input.userId, missionId);
  if (existing) {
    if (existing.missionFingerprint !== missionFingerprint) {
      fail(
        "MISSION_REPLAY_CONFLICT",
        `mission ${missionId} exists with a different material fingerprint — conflicting replay`
      );
    }
    return {
      contractVersion: MISSION_AUTHORITY_CONTRACT_VERSION,
      engineVersion: MISSION_AUTHORITY_ENGINE_VERSION,
      mission: toMissionView({ row: existing, nowMs }),
      inserted: false,
    };
  }

  const missionRow: MissionProposalRow = {
    missionId,
    objectiveId,
    userId: input.userId,
    businessId: input.businessId,
    sourceCandidateId: source.candidateId,
    sourceReasoningIds: [...source.reasoningIds],
    missionType: derivation.missionType,
    objectiveType: derivation.objectiveType,
    objectiveStatement: wording.statement,
    objectiveClientStatement: wording.clientStatement,
    objectiveWordingDraft: wording.modelDraft,
    modelAssistanceFlagged: wording.modelAssistanceFlagged,
    expectedOutcome,
    successCriteria: [...successCriteria],
    constraints: [...constraintSet],
    assumptions: [...assumptions],
    scope,
    scopeKey,
    priorityContext: source.priorityClass,
    strategicRiskClass,
    confidenceClass,
    governanceDecisionId: source.governanceDecisionId,
    governanceDecision: source.governanceDecision,
    policyVersion: source.policyVersion,
    governanceRequirements: [...governanceRequirements],
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    limitations: source.limitations.slice(0, MAX_LIMITATIONS),
    lineageHash,
    missionFingerprint,
    objectiveFingerprint,
    constraintSetFingerprint,
    sourceProjection: source.projection,
    sourceVersions: { ...MISSION_AUTHORITY_BOUND_VERSIONS },
    supersedesMissionId,
    status: "PROPOSED",
    version: 1,
  };

  const { inserted } = await insertMissionProposal(executor, missionRow);
  if (inserted) {
    const event = createAuditEvent({
      eventType: "mission_proposed",
      occurredAt: now.toISOString(),
      userId: input.userId,
      source: "user",
      outcome: "succeeded",
      campaignId: null,
      businessId: input.businessId,
      workflowOperationId: null,
      metadata: {
        missionId,
        objectiveId,
        sourceCandidateId: source.candidateId,
        missionType: derivation.missionType,
        objectiveType: derivation.objectiveType,
        priorityContext: source.priorityClass,
        strategicRiskClass,
        governanceDecision: source.governanceDecision,
        governanceDecisionId: source.governanceDecisionId,
        supersedesMissionId,
        missionFingerprint,
        lineageHash,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }

  // Supersede the live predecessor with an append-only fact.
  if (supersedesMissionId && predecessor) {
    await transitionMissionStatus(executor, {
      userId: input.userId,
      missionId: supersedesMissionId,
      expectedVersion: Number(predecessor.version),
      nextStatus: "SUPERSEDED",
    });
    await recordLifecycleFact(
      {
        userId: input.userId,
        missionId: supersedesMissionId,
        lifecycleType: "supersession",
        targetStatus: "SUPERSEDED",
        successorMissionId: missionId,
        occurredAt: now.toISOString(),
        reasonCode: "SUPERSEDED_BY_SUCCESSOR",
      },
      executor
    );
  }

  const stored = await getMissionProposal(executor, input.userId, missionId);
  return {
    contractVersion: MISSION_AUTHORITY_CONTRACT_VERSION,
    engineVersion: MISSION_AUTHORITY_ENGINE_VERSION,
    mission: toMissionView({ row: stored ?? missionRow, nowMs }),
    inserted,
  };
}

// ─── Reads ───

export async function getMissionForUser(input: {
  userId: number;
  missionId: string;
  deps: MissionAuthorityDeps;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{ mission: MissionProposalView }> {
  const nowMs = resolveNow(input.deps).getTime();
  const row = await getMissionProposal(input.executor, input.userId, input.missionId);
  if (!row) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  return { mission: toMissionView({ row, nowMs }) };
}

export async function listMissionsForUser(input: {
  userId: number;
  businessId?: number;
  status?: string;
  missionType?: string;
  deps: MissionAuthorityDeps;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{ missions: MissionProposalView[] }> {
  const nowMs = resolveNow(input.deps).getTime();
  const rows = await listMissionProposalRows(input.executor, input.userId, {
    businessId: input.businessId,
    status: input.status,
    missionType: input.missionType,
  });
  return { missions: rows.map((row) => toMissionView({ row, nowMs })) };
}

// ─── Lifecycle facts (append-only; convergence emits zero) ───

async function recordLifecycleFact(
  input: {
    userId: number;
    missionId: string;
    lifecycleType: string;
    targetStatus: string;
    successorMissionId: string | null;
    occurredAt: string;
    reasonCode: string | null;
  },
  executor: MissionAuthorityStoreExecutor
): Promise<boolean> {
  const { inserted } = await insertMissionLifecycleEvent(executor, {
    lifecycleEventId: deriveLifecycleEventId({
      missionId: input.missionId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorMissionId: input.successorMissionId,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode,
    }),
    userId: input.userId,
    missionId: input.missionId,
    lifecycleType: input.lifecycleType,
    targetStatus: input.targetStatus,
    successorMissionId: input.successorMissionId,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  });
  if (!inserted) return false;
  const event = createAuditEvent({
    eventType: "mission_lifecycle",
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: null,
    businessId: null,
    workflowOperationId: null,
    metadata: {
      missionId: input.missionId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorMissionId: input.successorMissionId,
      reasonCode: input.reasonCode,
    },
  });
  await persistAuditEvent(event, asAuditExecutor(executor));
  return true;
}

// ─── Revalidation (A5) ───

export async function revalidateMission(input: {
  userId: number;
  missionId: string;
  deps: MissionAuthorityDeps;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{ mission: MissionProposalView; transitioned: boolean }> {
  const now = resolveNow(input.deps);
  const nowMs = now.getTime();
  const row = await getMissionProposal(input.executor, input.userId, input.missionId);
  if (!row) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  const currentStatus = row.status as MissionStatus;
  if (isTerminalMissionStatus(currentStatus)) {
    return { mission: toMissionView({ row, nowMs }), transitioned: false };
  }

  const candidateRow = await input.deps.candidateRows.getCandidateRow({
    userId: input.userId,
    businessId: row.businessId,
    candidateId: row.sourceCandidateId,
  });

  let target: { targetStatus: MissionStatus; reasonCode: string };
  try {
    await resolveGovernedCandidate({
      userId: input.userId,
      businessId: row.businessId,
      candidateId: row.sourceCandidateId,
      row: candidateRow,
      deps: input.deps,
    });
    target = resolveGovernedSourceTarget({ validUntilMs: Date.parse(row.validUntil), nowMs });
  } catch (err) {
    if (!(err instanceof MissionAuthorityError)) throw err;
    if (err.code === "GOVERNANCE_AUTHORITY_UNAVAILABLE") throw err;
    target = resolveFailedSourceTarget({ row: candidateRow, errorCode: err.code });
  }

  if (target.targetStatus === currentStatus) {
    return { mission: toMissionView({ row, nowMs }), transitioned: false };
  }
  assertTransitionAllowed(currentStatus, target.targetStatus);
  await transitionMissionStatus(input.executor, {
    userId: input.userId,
    missionId: row.missionId,
    expectedVersion: Number(row.version),
    nextStatus: target.targetStatus,
  });
  await recordLifecycleFact(
    {
      userId: input.userId,
      missionId: row.missionId,
      lifecycleType: lifecycleTypeForTarget(target.targetStatus),
      targetStatus: target.targetStatus,
      successorMissionId: null,
      occurredAt: now.toISOString(),
      reasonCode: target.reasonCode,
    },
    input.executor
  );
  const updated = await getMissionProposal(input.executor, input.userId, row.missionId);
  return { mission: toMissionView({ row: updated ?? row, nowMs }), transitioned: true };
}

// ─── Cancellation (operator path; bounded closed reasons) ───

export async function cancelMission(input: {
  userId: number;
  missionId: string;
  reasonCode: MissionCancelReasonCode;
  deps: MissionAuthorityDeps;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{ mission: MissionProposalView; transitioned: boolean }> {
  const now = resolveNow(input.deps);
  const nowMs = now.getTime();
  const row = await getMissionProposal(input.executor, input.userId, input.missionId);
  if (!row) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  const currentStatus = row.status as MissionStatus;
  if (isTerminalMissionStatus(currentStatus)) {
    return { mission: toMissionView({ row, nowMs }), transitioned: false };
  }
  await transitionMissionStatus(input.executor, {
    userId: input.userId,
    missionId: row.missionId,
    expectedVersion: Number(row.version),
    nextStatus: "CANCELLED",
  });
  await recordLifecycleFact(
    {
      userId: input.userId,
      missionId: row.missionId,
      lifecycleType: "cancellation",
      targetStatus: "CANCELLED",
      successorMissionId: null,
      occurredAt: now.toISOString(),
      reasonCode: "OPERATOR_CANCELLED",
    },
    input.executor
  );
  const updated = await getMissionProposal(input.executor, input.userId, row.missionId);
  return { mission: toMissionView({ row: updated ?? row, nowMs }), transitioned: true };
}

// ─── Lifecycle reads ───

export async function listMissionLifecycleForUser(input: {
  userId: number;
  missionId: string;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{
  lifecycle: readonly {
    lifecycleEventId: string;
    lifecycleType: string;
    targetStatus: string;
    successorMissionId: string | null;
    occurredAt: string;
    reasonCode: string | null;
  }[];
}> {
  const row = await getMissionProposal(input.executor, input.userId, input.missionId);
  if (!row) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  const lifecycle = await listMissionLifecycleRows(input.executor, input.userId, input.missionId);
  return {
    lifecycle: lifecycle.map((l) => ({
      lifecycleEventId: l.lifecycleEventId,
      lifecycleType: l.lifecycleType,
      targetStatus: l.targetStatus,
      successorMissionId: l.successorMissionId,
      occurredAt: l.occurredAt,
      reasonCode: l.reasonCode,
    })),
  };
}

// ─── Planning handoff (A8; read-only) ───

export async function getPlanningHandoffForUser(input: {
  userId: number;
  missionId: string;
  deps: MissionAuthorityDeps;
  executor: MissionAuthorityStoreExecutor;
}): Promise<{
  contractVersion: typeof MISSION_PLANNING_PROJECTION_VERSION;
  projection: MissionPlanningProjection;
  planningConsumable: boolean;
}> {
  const nowMs = resolveNow(input.deps).getTime();
  const row = await getMissionProposal(input.executor, input.userId, input.missionId);
  if (!row) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  const projection = validateMissionPlanningProjection(
    buildMissionPlanningProjection({ row: row as unknown as Record<string, unknown>, nowMs })
  );
  return {
    contractVersion: projection.contractVersion,
    projection,
    planningConsumable: isPlanningConsumable(projection),
  };
}
