// ─── R7-D Experimentation Engine — service orchestration ───
//
// Runs the REAL experimentation pipeline against durable stores and the
// frozen upstream seams: learning binding + design validation (D2) →
// deterministic identity → insert-first exact-once persistence → governance
// binding (D3) → activation eligibility + observation window (D5/D8) →
// deterministic assignment (D4) → evidence capture (D6) → deterministic
// result calculation (D7) → governed lifecycle → deterministic audit.
//
// No code path here mutates upstream (R6/R7-A/R7-B/R7-C/R7-F) authority or
// downstream (R7-C learning / R7-E budget) authority, and no result is ever
// minted from model opinion.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import type {
  ExperimentRow,
  InsertExperimentRow,
  InsertExperimentLifecycleEventRow,
  InsertExperimentAssignmentRow,
  InsertExperimentOutcomeEvidenceRow,
  InsertExperimentResultRow,
} from "@db/schema";
import {
  experimentCreateInputSchema,
  assertNoClientAuthorityFields,
  ExperimentStateError,
  ExperimentOwnershipError,
  canonicalJson,
  sha256Hex,
  EXPERIMENT_SOURCE_VERSION_KEYS,
  type ExperimentCreateInput,
  type ExperimentDuplicateClassification,
  type ExperimentStatus,
} from "./experimentation-contract";
import {
  createUpstreamPorts,
  type ExperimentationUpstreamPorts,
  type ConsumedGovernanceDecision,
  type ConsumedApprovalView,
} from "./experimentation-seams";
import {
  validateLearningBinding,
  assertLearningTenantScope,
  validateHypothesis,
  validateExperimentDesign,
} from "./experimentation-design";
import {
  deriveDesignHash,
  deriveHypothesisId,
  deriveExperimentId,
  deriveAssignmentVersion,
  deriveEvidenceId,
  deriveResultId,
  deriveEvidenceFingerprint,
  deriveLifecycleEventId,
  deriveRecordHash,
  deriveResultHash,
  deriveSubjectKey,
} from "./experimentation-identity";
import { computeAssignment, reconcileAssignment } from "./experimentation-assignment";
import { assertTransitionLegal } from "./experimentation-lifecycle";
import {
  computeExperimentResult,
  renderConclusion,
  RESULT_LIMITATIONS,
  RESULT_CALCULATION_VERSION,
  type EvidenceView,
} from "./experimentation-result";
import {
  getExperimentById,
  insertExperiment,
  transitionExperimentStatus,
  listExperimentsForUser,
  insertLifecycleEvent,
  listLifecycleEventsForExperiment,
  findAssignment,
  insertAssignment,
  insertEvidence,
  listEvidenceForExperiment,
  insertResult,
  getResultById,
  type ExperimentStoreExecutor,
} from "./experimentation-store";
import {
  buildExperimentView,
  buildResultHandoffProjection,
  type ExperimentView,
  type ResultHandoffProjection,
} from "./experimentation-projection";
import { z } from "zod";

export interface ExperimentationServiceDeps {
  readonly ports?: ExperimentationUpstreamPorts;
  readonly executor?: ExperimentStoreExecutor;
  /** Explicit clock — never read from the environment inside the engine. */
  readonly now?: Date;
  /** Result calculation version override (integration/test only); the engine
   *  default is the canonical experiment-result/v1. */
  readonly calculationVersion?: string;
}

function resolvePorts(deps: ExperimentationServiceDeps): ExperimentationUpstreamPorts {
  return deps.ports ?? createUpstreamPorts();
}

function resolveNow(deps: ExperimentationServiceDeps): Date {
  return deps.now ?? new Date();
}

function asAuditExecutor(executor?: ExperimentStoreExecutor): AuditDbExecutor | undefined {
  if (!executor) return undefined;
  return { select: executor.select, insert: executor.insert };
}

function addDays(iso: string, days: number): string {
  const ms = Date.parse(iso);
  const d = new Date(Number.isNaN(ms) ? 0 : ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ─── Result shapes ───

export interface CreateExperimentResult {
  readonly experiment: ExperimentView;
  readonly duplicateClassification: ExperimentDuplicateClassification;
}

export interface TransitionResult {
  readonly experiment: ExperimentView;
  readonly duplicateClassification: ExperimentDuplicateClassification;
}

export interface AssignmentResult {
  readonly experimentId: string;
  readonly assignmentId: string;
  readonly arm: "CONTROL" | "TREATMENT";
  readonly armIndex: number;
  readonly duplicateClassification: ExperimentDuplicateClassification;
}

export interface EvidenceResult {
  readonly evidenceId: string;
  readonly experimentId: string;
  readonly outcomeId: string;
  readonly armIndex: number;
  readonly duplicateClassification: ExperimentDuplicateClassification;
}

export interface AnalyzeResult {
  readonly resultId: string;
  readonly experiment: ExperimentView;
  readonly verdict: string;
  readonly confidenceClass: string;
  readonly duplicateClassification: ExperimentDuplicateClassification;
}

// ─── Internal helpers ───

async function requireExperiment(
  userId: number,
  experimentId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentRow> {
  const row = await getExperimentById(userId, experimentId, executor);
  if (!row) {
    throw new ExperimentOwnershipError("EXPERIMENT_NOT_FOUND", "Experiment not found for this tenant.");
  }
  return row;
}

async function emitAudit(
  deps: ExperimentationServiceDeps,
  event: ReturnType<typeof createAuditEvent>
): Promise<void> {
  const executor = asAuditExecutor(deps.executor);
  if (!executor) return;
  await persistAuditEvent(event, executor);
}

function transitionEventId(input: {
  experimentId: string;
  lifecycleType: string;
  toStatus: string;
  occurredAt: string;
  reasonCode: string | null;
  seq: number;
}): string {
  return deriveLifecycleEventId(input);
}

/** Apply a legal transition + mint exactly one lifecycle fact + audit. */
async function applyTransition(
  userId: number,
  experiment: ExperimentRow,
  to: ExperimentRow["status"],
  reasonCode: string | null,
  deps: ExperimentationServiceDeps,
  extraPatch: Partial<InsertExperimentRow> = {}
): Promise<{ row: ExperimentRow; duplicateClassification: ExperimentDuplicateClassification }> {
  const spec = assertTransitionLegal({ from: experiment.status, to, reasonCode });
  const now = resolveNow(deps).toISOString();
  const seqRow = await listLifecycleEventsForExperiment(userId, experiment.experimentId, deps.executor);
  const eventId = transitionEventId({
    experimentId: experiment.experimentId,
    lifecycleType: spec.lifecycleType,
    toStatus: to,
    occurredAt: now,
    reasonCode,
    seq: seqRow.length + 1,
  });

  const patch: Partial<InsertExperimentRow> = { ...extraPatch, status: to };
  const next = await transitionExperimentStatus(
    userId,
    experiment.experimentId,
    experiment.version,
    patch,
    deps.executor
  );

  const write = await insertLifecycleEvent(
    {
      experimentLifecycleEventId: eventId,
      experimentId: experiment.experimentId,
      userId,
      lifecycleType: spec.lifecycleType,
      fromStatus: experiment.status,
      toStatus: to,
      reasonCode,
      occurredAt: now,
    } as InsertExperimentLifecycleEventRow,
    deps.executor
  );

  if (write.inserted) {
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "experiment_state_changed",
        source: "system",
        outcome: "succeeded",
        occurredAt: now,
        userId,
        businessId: experiment.businessId,
        metadata: {
          experimentId: experiment.experimentId,
          lifecycleType: spec.lifecycleType,
          fromStatus: experiment.status,
          toStatus: to,
          reasonCode,
        },
      })
    );
  }
  return { row: next, duplicateClassification: write.duplicateClassification };
}

/** Build R7-F governance proposal material (material only — R7-F decides). */
function buildGovernanceProposal(input: {
  experiment: ExperimentRow;
  proposalType: "EXPERIMENT_CREATE" | "EXPERIMENT_ACTIVATE";
}): Record<string, unknown> {
  const e = input.experiment;
  const budgetCap = (e.guardrails as { guardrail: string; params?: Record<string, number | string> }[]).find(
    (g) => g.guardrail === "BUDGET_CAP_MINOR"
  );
  const budgetMinor =
    budgetCap && typeof budgetCap.params?.["capMinor"] === "number"
      ? (budgetCap.params["capMinor"] as number)
      : 0;
  const evidenceHash = sha256Hex(
    canonicalJson({
      v: 1,
      experimentId: e.experimentId,
      designHash: e.designHash,
      learningId: e.learningId,
      hypothesisId: e.hypothesisId,
    })
  );
  return {
    proposalId: e.experimentId,
    businessId: e.businessId,
    proposalType: input.proposalType,
    financial: {
      budgetMinor,
      financialImpactClass: budgetMinor > 0 ? "REALLOCATION_WITHIN_APPROVED_TOTAL" : "RECOMMENDATION_ONLY",
    },
    experiment: {
      experimentKey: e.experimentId,
      dimensions: [e.dimension],
      budgetMinor,
      durationDays: e.durationDays,
      touchesProtectedTraits: [],
    },
    portfolio: {},
    learningReference: { learningId: e.learningId },
    campaignId: null,
    evidenceHash,
  };
}

// ─── D2: Create experiment ───

export async function createExperiment(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<CreateExperimentResult> {
  assertNoClientAuthorityFields((rawInput ?? {}) as Record<string, unknown>);
  const input: ExperimentCreateInput = experimentCreateInputSchema.parse(rawInput);
  const ports = resolvePorts(deps);
  const now = resolveNow(deps).toISOString();

  const learning = await ports.learning.getLearningForExperiment(userId, input.learningId);
  validateLearningBinding({ userId, learningId: input.learningId, learning });
  assertLearningTenantScope({ userId, learning: learning! });
  const businessId = learning!.businessId;

  const hypothesis = validateHypothesis(input);
  const { design, armCount } = validateExperimentDesign({ userId, businessId, design: input.design });
  void armCount;

  const designHash = deriveDesignHash({ userId, businessId, design });
  const hypothesisId = deriveHypothesisId({
    userId,
    businessId,
    learningId: input.learningId,
    statement: hypothesis.statement,
    designHash,
  });
  const experimentId = deriveExperimentId({
    userId,
    businessId,
    learningId: input.learningId,
    hypothesisId,
    designHash,
  });

  const recordCore = {
    experimentId,
    hypothesisId,
    userId,
    businessId,
    learningId: input.learningId,
    statement: hypothesis.statement,
    designType: design.designType,
    dimension: design.dimension,
    controlDefinition: design.controlDefinition,
    treatmentDefinitions: design.treatmentDefinitions,
    allocationPolicy: design.allocationPolicy,
    primaryMetric: design.primaryMetric,
    secondaryMetrics: design.secondaryMetrics,
    guardrails: design.guardrails,
    minimumSamplePerArm: design.minimumSamplePerArm,
    durationDays: design.durationDays,
    startAt: null,
    endAt: null,
    assignmentVersion: null,
    status: "DRAFT" as const,
    governanceDecisionId: null,
    approvalReference: null,
    designHash,
    resultId: null,
    narrativeDraft: hypothesis.narrativeDraft,
  };
  const recordHash = deriveRecordHash(recordCore);
  const row: InsertExperimentRow = { ...recordCore, recordHash, version: 1 };

  const write = await insertExperiment(row, deps.executor);
  if (write.inserted) {
    const seq = 1;
    await insertLifecycleEvent(
      {
        experimentLifecycleEventId: transitionEventId({
          experimentId,
          lifecycleType: "creation",
          toStatus: "DRAFT",
          occurredAt: now,
          reasonCode: null,
          seq,
        }),
        experimentId,
        userId,
        lifecycleType: "creation",
        fromStatus: "DRAFT",
        toStatus: "DRAFT",
        reasonCode: null,
        occurredAt: now,
      } as InsertExperimentLifecycleEventRow,
      deps.executor
    );
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "experiment_created",
        source: "system",
        outcome: "succeeded",
        occurredAt: now,
        userId,
        businessId,
        metadata: {
          experimentId,
          hypothesisId,
          learningId: input.learningId,
          designType: design.designType,
          dimension: design.dimension,
          designHash,
          sourceVersions: [...EXPERIMENT_SOURCE_VERSION_KEYS],
        },
      })
    );
  }
  return {
    experiment: buildExperimentView(write.row),
    duplicateClassification: write.duplicateClassification,
  };
}

// ─── D3: Governance binding ───

export async function submitGovernance(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<TransitionResult> {
  const input = z.strictObject({ experimentId: z.string().min(1).max(69) }).parse(rawInput);
  const ports = resolvePorts(deps);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);
  if (experiment.status !== "DRAFT") {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_INVALID",
      `Governance submission requires DRAFT status; got ${experiment.status}.`
    );
  }

  const proposal = buildGovernanceProposal({ experiment, proposalType: "EXPERIMENT_CREATE" });
  const decision = await ports.governance.evaluateProposal(userId, proposal);

  if (decision.businessId !== experiment.businessId || decision.userId !== userId) {
    throw new ExperimentStateError(
      "EXPERIMENT_GOVERNANCE_DENIED",
      "Governance decision scope does not match the experiment tenant/business."
    );
  }

  let approvalReference: string | null = null;
  if (decision.decision === "REVIEW_REQUIRED") {
    const approval = await ports.governance.getApprovalForDecision(userId, decision.governanceDecisionId);
    approvalReference = approval ? String(approval.id) : null;
    const applied = await applyTransition(
      userId,
      experiment,
      "APPROVAL_REQUIRED",
      null,
      deps,
      { governanceDecisionId: decision.governanceDecisionId, approvalReference }
    );
    return { experiment: buildExperimentView(applied.row), duplicateClassification: applied.duplicateClassification };
  }
  if (decision.decision === "BLOCK") {
    const applied = await applyTransition(
      userId,
      experiment,
      "CANCELLED",
      decision.reasonCodes[0] ?? "GOVERNANCE_BLOCKED",
      deps,
      { governanceDecisionId: decision.governanceDecisionId }
    );
    return { experiment: buildExperimentView(applied.row), duplicateClassification: applied.duplicateClassification };
  }
  // ALLOW → READY
  const applied = await applyTransition(userId, experiment, "READY", null, deps, {
    governanceDecisionId: decision.governanceDecisionId,
  });
  return { experiment: buildExperimentView(applied.row), duplicateClassification: applied.duplicateClassification };
}

// ─── D3+D5: Activation ───

export async function activateExperiment(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<TransitionResult> {
  const input = z.strictObject({ experimentId: z.string().min(1).max(69) }).parse(rawInput);
  const ports = resolvePorts(deps);
  const now = resolveNow(deps);
  const nowIso = now.toISOString();
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);

  // Duplicate activation converges; any other non-READY status fails closed.
  if (experiment.status === "ACTIVE") {
    return { experiment: buildExperimentView(experiment), duplicateClassification: "idempotent_replay" };
  }
  if (experiment.status !== "READY" && experiment.status !== "APPROVAL_REQUIRED") {
    throw new ExperimentStateError(
      "EXPERIMENT_TRANSITION_INVALID",
      `Activation requires READY status; got ${experiment.status}.`
    );
  }

  // Approval path: the bound human approval (CREATE decision) must be
  // executable; a valid approval promotes APPROVAL_REQUIRED → READY (the
  // "approval" lifecycle fact), and activation then proceeds from READY.
  let current = experiment;
  if (experiment.status === "APPROVAL_REQUIRED") {
    if (!experiment.governanceDecisionId) {
      throw new ExperimentStateError("EXPERIMENT_GOVERNANCE_DENIED", "Approval-required experiment has no governance decision.");
    }
    const createDecision = await ports.governance.getDecision(userId, experiment.governanceDecisionId);
    if (!createDecision) {
      throw new ExperimentStateError("EXPERIMENT_GOVERNANCE_DENIED", "Stored governance decision no longer resolves.");
    }
    const approval = await ports.governance.getApprovalForDecision(userId, createDecision.governanceDecisionId);
    const createGate = await ports.governance.assertExecutable({
      decision: createDecision,
      approval,
      currentPolicyVersion: await ports.governance.getCurrentPolicyVersion(),
      now: nowIso,
    });
    if (!createGate.executable) {
      throw new ExperimentStateError(
        "EXPERIMENT_GOVERNANCE_DENIED",
        `Activation approval gate denied: ${createGate.denialReasonCode ?? "UNKNOWN"}.`
      );
    }
    const promoted = await applyTransition(userId, current, "READY", null, deps);
    current = promoted.row;
  }

  // Revalidate immediately before activation with fresh proposal material.
  const activationProposal = buildGovernanceProposal({ experiment: current, proposalType: "EXPERIMENT_ACTIVATE" });
  const activationDecision = await ports.governance.evaluateProposal(userId, activationProposal);
  if (activationDecision.decision === "BLOCK") {
    throw new ExperimentStateError(
      "EXPERIMENT_GOVERNANCE_DENIED",
      `Activation governance blocked: ${activationDecision.reasonCodes[0] ?? "UNKNOWN"}.`
    );
  }
  const activationApproval =
    activationDecision.decision === "REVIEW_REQUIRED"
      ? await ports.governance.getApprovalForDecision(userId, activationDecision.governanceDecisionId)
      : null;
  const gate = await ports.governance.assertExecutable({
    decision: activationDecision,
    approval: activationApproval,
    currentPolicyVersion: await ports.governance.getCurrentPolicyVersion(),
    now: nowIso,
  });
  if (!gate.executable) {
    throw new ExperimentStateError(
      "EXPERIMENT_GOVERNANCE_DENIED",
      `Activation gate denied: ${gate.denialReasonCode ?? "UNKNOWN"}.`
    );
  }

  const startAt = nowIso;
  const endAt = addDays(startAt, current.durationDays);
  const assignmentVersion = deriveAssignmentVersion({ experimentId: current.experimentId, startAt });

  const applied = await applyTransition(userId, current, "ACTIVE", null, deps, {
    startAt,
    endAt,
    assignmentVersion,
    governanceDecisionId: activationDecision.governanceDecisionId,
    approvalReference: experiment.approvalReference,
  });
  return { experiment: buildExperimentView(applied.row), duplicateClassification: applied.duplicateClassification };
}

// ─── D5: Generic governed lifecycle transitions ───

export async function transitionExperiment(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<TransitionResult> {
  const input = z
    .strictObject({
      experimentId: z.string().min(1).max(69),
      to: z.enum([
        "GOVERNANCE_REQUIRED",
        "APPROVAL_REQUIRED",
        "READY",
        "PAUSED",
        "STOPPED",
        "COMPLETED",
        "INVALIDATED",
        "CANCELLED",
      ]),
      reasonCode: z.string().min(1).max(191).optional(),
    })
    .parse(rawInput);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);
  const applied = await applyTransition(userId, experiment, input.to, input.reasonCode ?? null, deps);
  return { experiment: buildExperimentView(applied.row), duplicateClassification: applied.duplicateClassification };
}

// ─── D4: Assignment ───

export async function getAssignment(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<AssignmentResult> {
  const input = z
    .strictObject({
      experimentId: z.string().min(1).max(69),
      subjectRef: z.string().min(1).max(512),
    })
    .parse(rawInput);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);
  if (experiment.status !== "ACTIVE" || !experiment.assignmentVersion) {
    throw new ExperimentStateError(
      "EXPERIMENT_NOT_ACTIVE",
      `Assignment is only available while the experiment is ACTIVE; got ${experiment.status}.`
    );
  }
  const allocation = experiment.allocationPolicy as { fractionsBps: number[] };
  const computed = computeAssignment({
    userId,
    experimentId: experiment.experimentId,
    assignmentVersion: experiment.assignmentVersion,
    fractionsBps: allocation.fractionsBps,
    subjectRef: input.subjectRef,
  });
  const persisted = await findAssignment(userId, experiment.experimentId, computed.subjectKey, deps.executor);
  const reconciliation = reconcileAssignment({ computed, persisted });

  if (!persisted) {
    const now = resolveNow(deps).toISOString();
    const assignmentHash = sha256Hex(
      canonicalJson({
        v: 1,
        experimentId: experiment.experimentId,
        subjectKey: computed.subjectKey,
        armIndex: computed.armIndex,
        assignmentVersion: experiment.assignmentVersion,
      })
    );
    const write = await insertAssignment(
      {
        assignmentId: computed.assignmentId,
        experimentId: experiment.experimentId,
        userId,
        subjectKey: computed.subjectKey,
        arm: computed.armIndex === 0 ? "CONTROL" : "TREATMENT",
        armIndex: computed.armIndex,
        assignmentHash,
        assignedAt: now,
      } as InsertExperimentAssignmentRow,
      deps.executor
    );
    if (write.inserted) {
      await emitAudit(
        deps,
        createAuditEvent({
          eventType: "experiment_assignment_recorded",
          source: "system",
          outcome: "succeeded",
          occurredAt: now,
          userId,
          businessId: experiment.businessId,
          metadata: {
            experimentId: experiment.experimentId,
            assignmentId: computed.assignmentId,
            arm: computed.armIndex === 0 ? "CONTROL" : "TREATMENT",
            armIndex: computed.armIndex,
            assignmentVersion: experiment.assignmentVersion,
          },
        })
      );
    }
  }

  return {
    experimentId: experiment.experimentId,
    assignmentId: computed.assignmentId,
    arm: computed.armIndex === 0 ? "CONTROL" : "TREATMENT",
    armIndex: computed.armIndex,
    duplicateClassification: reconciliation.classification,
  };
}

// ─── D6: Outcome evidence binding ───

export async function bindOutcomeEvidence(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<EvidenceResult> {
  const input = z
    .strictObject({
      experimentId: z.string().min(1).max(69),
      subjectRef: z.string().min(1).max(512),
      outcomeId: z.string().regex(/^out1:[a-f0-9]{64}$/, "outcomeId must be an out1: id"),
      attributionId: z.string().regex(/^atr1:[a-f0-9]{64}$/, "attributionId must be an atr1: id").optional(),
    })
    .parse(rawInput);
  assertNoClientAuthorityFields((rawInput ?? {}) as Record<string, unknown>);
  const ports = resolvePorts(deps);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);

  if (!["ACTIVE", "STOPPED", "COMPLETED"].includes(experiment.status)) {
    throw new ExperimentStateError(
      "EXPERIMENT_NOT_ACCEPTING_EVIDENCE",
      `Experiment does not accept evidence in status ${experiment.status}.`
    );
  }
  if (!experiment.startAt || !experiment.endAt) {
    throw new ExperimentStateError("EXPERIMENT_STATE_INVALID", "Experiment has no observation window.");
  }

  // Subject must be assigned; the persisted arm is the binding authority.
  const subjectKey = deriveSubjectKey({
    userId,
    experimentId: experiment.experimentId,
    subjectRef: input.subjectRef,
  });
  const assignment = await findAssignment(userId, experiment.experimentId, subjectKey, deps.executor);
  if (!assignment) {
    throw new ExperimentStateError(
      "EXPERIMENT_SUBJECT_NOT_ASSIGNED",
      "Subject has no assignment for this experiment; bind requires a persisted assignment."
    );
  }

  const outcome = await ports.outcomes.getOutcomeForExperiment(userId, input.outcomeId);
  if (!outcome) {
    throw new ExperimentStateError("EXPERIMENT_UNKNOWN_OUTCOME", "Outcome does not resolve for this tenant.");
  }
  if (outcome.businessId !== experiment.businessId) {
    throw new ExperimentOwnershipError(
      "EXPERIMENT_CROSS_BUSINESS_OUTCOME",
      "Outcome business scope does not match the experiment business."
    );
  }
  const occurredMs = Date.parse(outcome.occurredAt);
  if (
    Number.isNaN(occurredMs) ||
    occurredMs < Date.parse(experiment.startAt) ||
    occurredMs > Date.parse(experiment.endAt)
  ) {
    throw new ExperimentStateError(
      "EXPERIMENT_OUTCOME_OUTSIDE_WINDOW",
      "Outcome occurred outside the experiment observation window."
    );
  }

  if (input.attributionId) {
    const attribution = await ports.attributions.getAttributionForExperiment(userId, input.attributionId);
    if (!attribution) {
      throw new ExperimentStateError("EXPERIMENT_UNKNOWN_ATTRIBUTION", "Attribution does not resolve for this tenant.");
    }
    if (attribution.outcomeId !== outcome.outcomeId || attribution.businessId !== experiment.businessId) {
      throw new ExperimentOwnershipError(
        "EXPERIMENT_ATTRIBUTION_OUTCOME_MISMATCH",
        "Attribution must reference the same outcome and business scope."
      );
    }
    if (attribution.supersedesAttributionId !== null) {
      throw new ExperimentStateError("EXPERIMENT_STALE_ATTRIBUTION", "Superseded attributions are stale and cannot bind.");
    }
  }

  const evidenceId = deriveEvidenceId({ experimentId: experiment.experimentId, outcomeId: outcome.outcomeId });
  const evidenceHash = sha256Hex(
    canonicalJson({
      v: 1,
      evidenceId,
      experimentId: experiment.experimentId,
      outcomeId: outcome.outcomeId,
      subjectKey,
      armIndex: assignment.armIndex,
      outcomeStatus: outcome.outcomeStatus,
      outcomeType: outcome.outcomeType,
      valueType: outcome.valueType,
      amountMinor: outcome.amountMinor,
      occurredAt: outcome.occurredAt,
    })
  );
  const now = resolveNow(deps).toISOString();
  const write = await insertEvidence(
    {
      evidenceId,
      experimentId: experiment.experimentId,
      userId,
      outcomeId: outcome.outcomeId,
      attributionId: input.attributionId ?? null,
      subjectKey,
      armIndex: assignment.armIndex,
      outcomeStatus: outcome.outcomeStatus,
      outcomeType: outcome.outcomeType,
      valueType: outcome.valueType,
      amountMinor: outcome.amountMinor,
      occurredAt: outcome.occurredAt,
      evidenceHash,
    } as InsertExperimentOutcomeEvidenceRow,
    deps.executor
  );
  if (write.inserted) {
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "experiment_evidence_bound",
        source: "system",
        outcome: "succeeded",
        occurredAt: now,
        userId,
        businessId: experiment.businessId,
        metadata: {
          experimentId: experiment.experimentId,
          evidenceId,
          outcomeId: outcome.outcomeId,
          armIndex: assignment.armIndex,
          outcomeStatus: outcome.outcomeStatus,
          outcomeType: outcome.outcomeType,
        },
      })
    );
  }
  return {
    evidenceId,
    experimentId: experiment.experimentId,
    outcomeId: outcome.outcomeId,
    armIndex: assignment.armIndex,
    duplicateClassification: write.duplicateClassification,
  };
}

// ─── D7: Deterministic result calculation ───

export async function analyzeExperiment(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<AnalyzeResult> {
  const input = z.strictObject({ experimentId: z.string().min(1).max(69) }).parse(rawInput);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);

  if (["DRAFT", "GOVERNANCE_REQUIRED", "APPROVAL_REQUIRED", "READY", "CANCELLED"].includes(experiment.status)) {
    throw new ExperimentStateError(
      "EXPERIMENT_NOT_ANALYZABLE",
      `Experiment in status ${experiment.status} cannot be analyzed.`
    );
  }
  const nowMs = resolveNow(deps).getTime();
  const windowOpen = experiment.endAt ? nowMs < Date.parse(experiment.endAt) : true;
  if (windowOpen && experiment.status !== "STOPPED") {
    throw new ExperimentStateError(
      "EXPERIMENT_WINDOW_OPEN",
      "Observation window is still open; analysis requires a concluded window or a stopped experiment."
    );
  }

  const evidenceRows = await listEvidenceForExperiment(userId, experiment.experimentId, deps.executor);
  const evidenceViews: EvidenceView[] = evidenceRows.map((r) => ({
    evidenceId: r.evidenceId,
    armIndex: r.armIndex,
    subjectKey: r.subjectKey,
    outcomeType: r.outcomeType,
    outcomeStatus: r.outcomeStatus,
    valueType: r.valueType,
    amountMinor: r.amountMinor === null || r.amountMinor === undefined ? null : Number(r.amountMinor),
    occurredAt: r.occurredAt,
  }));

  const metric = experiment.primaryMetric as unknown as import("./experimentation-contract").ExperimentMetricSpec;
  const armCount = (experiment.treatmentDefinitions as unknown[]).length + 1;
  const computation = computeExperimentResult({
    metric,
    minimumSamplePerArm: experiment.minimumSamplePerArm,
    armCount,
    evidence: evidenceViews,
    experimentStatus: experiment.status,
  });

  const evidenceFingerprint = deriveEvidenceFingerprint(
    evidenceRows.map((r) => ({
      evidenceId: r.evidenceId,
      armIndex: r.armIndex,
      outcomeStatus: r.outcomeStatus,
      outcomeType: r.outcomeType,
    }))
  );
  const calculationVersion = deps.calculationVersion ?? RESULT_CALCULATION_VERSION;
  const resultId = deriveResultId({
    experimentId: experiment.experimentId,
    calculationVersion,
    evidenceFingerprint,
  });
  const conclusion = renderConclusion({
    verdict: computation.verdict,
    metricLabel: metric.metric,
    experimentId: experiment.experimentId,
  });
  const resultHash = deriveResultHash({
    resultId,
    experimentId: experiment.experimentId,
    userId,
    calculationVersion,
    verdict: computation.verdict,
    confidenceClass: computation.confidenceClass,
    primaryMetric: experiment.primaryMetric,
    armSummaries: computation.armSummaries,
    comparison: computation.comparisons,
    evidenceCounts: computation.evidenceCounts,
    limitations: [...RESULT_LIMITATIONS],
    conclusion,
    evidenceFingerprint,
  });

  const now = resolveNow(deps).toISOString();
  const write = await insertResult(
    {
      resultId,
      experimentId: experiment.experimentId,
      userId,
      calculationVersion,
      verdict: computation.verdict,
      confidenceClass: computation.confidenceClass,
      primaryMetric: experiment.primaryMetric,
      armSummaries: computation.armSummaries,
      comparisons: computation.comparisons,
      evidenceCounts: computation.evidenceCounts,
      limitations: [...RESULT_LIMITATIONS],
      conclusion,
      evidenceFingerprint,
      resultHash,
      calculatedAt: now,
    } as InsertExperimentResultRow,
    deps.executor
  );

  if (write.inserted) {
    // Link result to experiment (CAS). Replay converges without a second event.
    try {
      await transitionExperimentStatus(
        userId,
        experiment.experimentId,
        experiment.version,
        { resultId },
        deps.executor
      );
    } catch {
      // Concurrent link — re-read converges.
    }
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "experiment_result_recorded",
        source: "system",
        outcome: "succeeded",
        occurredAt: now,
        userId,
        businessId: experiment.businessId,
        metadata: {
          experimentId: experiment.experimentId,
          resultId,
          verdict: computation.verdict,
          confidenceClass: computation.confidenceClass,
          calculationVersion,
          evidenceCount: computation.evidenceCounts.total,
          evidenceFingerprint,
        },
      })
    );
  }

  const updated = await requireExperiment(userId, experiment.experimentId, deps.executor);
  return {
    resultId,
    experiment: buildExperimentView(updated),
    verdict: computation.verdict,
    confidenceClass: computation.confidenceClass,
    duplicateClassification: write.duplicateClassification,
  };
}

// ─── Reads + downstream projections (read-only) ───

export async function getExperiment(
  userId: number,
  experimentId: string,
  deps: ExperimentationServiceDeps = {}
): Promise<ExperimentView> {
  const row = await requireExperiment(userId, experimentId, deps.executor);
  return buildExperimentView(row);
}

export async function listExperiments(
  userId: number,
  filter: { businessId?: number; status?: ExperimentStatus } = {},
  deps: ExperimentationServiceDeps = {}
): Promise<ExperimentView[]> {
  const rows = await listExperimentsForUser(userId, filter, deps.executor);
  return rows.map(buildExperimentView);
}

export async function getExperimentResult(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
) {
  const input = z.strictObject({ experimentId: z.string().min(1).max(69) }).parse(rawInput);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);
  if (!experiment.resultId) return { experiment: buildExperimentView(experiment), result: null };
  const result = await getResultById(userId, experiment.resultId, deps.executor);
  return { experiment: buildExperimentView(experiment), result };
}

export async function getResultHandoffProjection(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<ResultHandoffProjection> {
  const input = z.strictObject({ experimentId: z.string().min(1).max(69) }).parse(rawInput);
  const experiment = await requireExperiment(userId, input.experimentId, deps.executor);
  const result = experiment.resultId ? await getResultById(userId, experiment.resultId, deps.executor) : null;
  return buildResultHandoffProjection({ experiment, result });
}

export async function listResultHandoffProjections(
  userId: number,
  rawInput: unknown,
  deps: ExperimentationServiceDeps = {}
): Promise<ResultHandoffProjection[]> {
  const input = z
    .strictObject({ businessId: z.number().int().positive().optional() })
    .parse(rawInput ?? {});
  const rows = await listExperimentsForUser(
    userId,
    input.businessId ? { businessId: input.businessId } : {},
    deps.executor
  );
  const projections: ResultHandoffProjection[] = [];
  for (const row of rows) {
    const result = row.resultId ? await getResultById(userId, row.resultId, deps.executor) : null;
    projections.push(buildResultHandoffProjection({ experiment: row, result }));
  }
  return projections;
}

// Re-export for the router + tests.
export type { ConsumedGovernanceDecision, ConsumedApprovalView };
