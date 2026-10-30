// ─── R8-D Strategic Reasoning — service authority ───
//
// Orchestrates one governed strategic-reasoning evaluation end to end:
// verify business ownership, resolve + revalidate every evidence reference
// server-side, build the deterministic evidence bundle, run the rule-first
// synthesis engine, persist the immutable conclusion exactly once under its
// convergence anchor, bind the mandatory R8-F governance decision, and emit
// exactly one audit event per inserted record. Replays re-read the committed
// row and converge (zero extra events). This stream never writes any
// upstream authority table, never executes strategic conclusions, and never
// becomes a governance engine (contract §1, §7).

import { and, eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import {
  CONFIDENCE_TO_GOVERNANCE_SCALE,
  fail,
  IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE,
  isIsoUtc,
  MAX_EVIDENCE_PER_BUNDLE,
  STRATEGIC_REASONING_BOUND_VERSIONS,
  STRATEGIC_REASONING_CONTRACT_VERSION,
  STRATEGIC_REASONING_ENGINE_VERSION,
  type StrategicReasoningStatus,
} from "./strategic-reasoning-contract";
import type { StrategicEvidenceAuthority, StrategicEvidenceView } from "./strategic-reasoning-evidence-seam";
import {
  deriveEvidenceBundleId,
  deriveEvidenceFingerprint,
  deriveHypothesisId,
  deriveLifecycleEventId,
  deriveReasoningFingerprint,
  deriveReasoningId,
  type BoundEvidenceItem,
} from "./strategic-reasoning-identity";
import {
  deriveApprovalStatus,
  getStrategicGovernanceEnginePort,
  validateStrategicGovernanceDecisionView,
  type StrategicApprovalReadPort,
  type StrategicGovernanceDecisionView,
} from "./strategic-reasoning-governance-seam";
import {
  buildStrategicReasoningProjection,
  type StrategicReasoningProjection,
} from "./strategic-reasoning-projection";
import {
  synthesizeStrategicReasoning,
} from "./strategic-reasoning-synthesis";
import {
  getStrategicReasoningBundle,
  getStrategicReasoningRecord,
  insertStrategicReasoningBundle,
  insertStrategicReasoningLifecycleEvent,
  insertStrategicReasoningRecord,
  listStrategicReasoningLifecycle,
  listStrategicReasoningRecords,
  type StrategicReasoningRecordRow,
  type StrategicReasoningStoreExecutor,
} from "./strategic-reasoning-store";

// ─── Dependencies ───

export interface StrategicReasoningDeps {
  /** Upstream evidence authority (production raw-SQL seam / in-memory fake). */
  readonly evidence: StrategicEvidenceAuthority;
  /** Read-only approval ledger view (production / in-memory). */
  readonly approvals: StrategicApprovalReadPort;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function resolveNow(deps: StrategicReasoningDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function asAuditExecutor(executor: StrategicReasoningStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

// ─── Business authority (canonical table, re-verified every call) ───

async function assertBusinessOwnership(
  executor: StrategicReasoningStoreExecutor,
  userId: number,
  businessId: number
): Promise<void> {
  const rows = await executor.select().from(businesses).where(and(eq(businesses.id, businessId), eq(businesses.userId, userId))).limit(1);
  if (rows.length === 0) {
    fail("OWNERSHIP_MISMATCH", `business ${businessId} not found for this tenant`);
  }
}

// ─── Evidence resolution (server-side only; clients supply ids) ───

async function resolveEvidenceBundle(input: {
  userId: number;
  businessId: number;
  memoryRefs: readonly string[];
  changeRefs: readonly string[];
  externalSignalRefs: readonly string[];
  evidence: StrategicEvidenceAuthority;
}): Promise<{ views: StrategicEvidenceView[]; items: BoundEvidenceItem[] }> {
  const { userId, businessId, evidence } = input;
  const allRefs = [...input.memoryRefs, ...input.changeRefs, ...input.externalSignalRefs];
  const uniqueRefs = [...new Set(allRefs)];
  if (uniqueRefs.length === 0) {
    fail("ZERO_USABLE_EVIDENCE", "at least one evidence reference is required");
  }
  if (uniqueRefs.length > MAX_EVIDENCE_PER_BUNDLE) {
    fail("MALFORMED_EVIDENCE", `evidence bundle exceeds ${MAX_EVIDENCE_PER_BUNDLE} items`);
  }
  const views: StrategicEvidenceView[] = [];
  for (const ref of input.memoryRefs) {
    const view = await evidence.resolveMemory(userId, businessId, ref);
    if (!view) fail("UNKNOWN_EVIDENCE_REFERENCE", `memory reference ${ref} does not resolve for this tenant + business`);
    views.push(view);
  }
  for (const ref of input.changeRefs) {
    const view = await evidence.resolveChange(userId, businessId, ref);
    if (!view) fail("UNKNOWN_EVIDENCE_REFERENCE", `change reference ${ref} does not resolve for this tenant + business`);
    views.push(view);
  }
  for (const ref of input.externalSignalRefs) {
    const view = await evidence.resolveSignal(userId, businessId, ref);
    if (!view) fail("UNKNOWN_EVIDENCE_REFERENCE", `external signal reference ${ref} does not resolve for this tenant + business`);
    views.push(view);
  }
  const items: BoundEvidenceItem[] = views.map((view) => {
    if (view.evidenceClass === "INTERNAL_MEMORY") {
      return {
        ref: view.ref,
        evidenceClass: view.evidenceClass,
        sourceVersion: view.sourceVersion,
        status: view.factStatus,
        observedAt: view.observedAt,
        recordedAt: view.recordedAt,
      };
    }
    if (view.evidenceClass === "INTERNAL_CHANGE") {
      return {
        ref: view.ref,
        evidenceClass: view.evidenceClass,
        sourceVersion: view.sourceVersion,
        status: view.status,
        observedAt: view.detectedAt,
        recordedAt: view.recordedAt,
      };
    }
    return {
      ref: view.ref,
      evidenceClass: view.evidenceClass,
      sourceVersion: view.freshnessPolicyVersion,
      status: view.signalStatus,
      observedAt: view.observedAt,
      recordedAt: view.ingestedAt,
    };
  });
  return { views, items };
}

// ─── Governance proposal material (clients/streams propose; F decides) ───

function buildGovernanceProposal(input: {
  reasoningId: string;
  businessId: number;
  hypothesisType: string;
  implicationType: string;
  confidenceClass: string;
  uncertaintyClasses: readonly string[];
  evidenceRefs: readonly string[];
  externalEvidenceInvolved: boolean;
  injectionSuspected: boolean;
}): Record<string, unknown> {
  const recommendationType = IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE[
    input.implicationType as keyof typeof IMPLICATION_TO_GOVERNANCE_RECOMMENDATION_TYPE
  ];
  if (!recommendationType) {
    fail("MALFORMED_EVIDENCE", `implication ${input.implicationType} has no governed recommendation mapping`);
  }
  const summary =
    `Strategic reasoning ${input.reasoningId}: hypothesis ${input.hypothesisType} with implication ` +
    `${input.implicationType} (confidence ${input.confidenceClass}; uncertainty: ${input.uncertaintyClasses.join(", ") || "none"}). ` +
    `Bounded recommendation candidate — attention only, never execution authority.`;
  return {
    proposalId: input.reasoningId,
    businessId: input.businessId,
    recommendationType,
    summary,
    evidenceRefs: [...input.evidenceRefs],
    claimedConfidence: CONFIDENCE_TO_GOVERNANCE_SCALE[
      input.confidenceClass as keyof typeof CONFIDENCE_TO_GOVERNANCE_SCALE
    ],
    declaredImpact: {
      externalReliance: input.externalEvidenceInvolved,
      highUncertainty: input.uncertaintyClasses.length > 0,
      injectionSuspected: input.injectionSuspected,
    },
  };
}

// ─── Evaluation ───

export interface EvaluateStrategicReasoningResult {
  readonly reasoning: StrategicReasoningProjection;
  readonly governanceDecision: StrategicGovernanceDecisionView | null;
  readonly duplicateClassification: "none" | "idempotent_replay";
  readonly rationaleCode: string;
}

/**
 * One governed strategic-reasoning evaluation. Every evidence payload is
 * untrusted until the seam accepts it; every identity and fingerprint is
 * recomputed, never taken from the wire. Same authoritative inputs ⇒ same
 * reasoningId ⇒ durable convergence (replay re-reads the stored row, emits
 * zero events).
 */
export async function evaluateStrategicReasoning(
  input: {
    userId: number;
    businessId: number;
    memoryRefs: readonly string[];
    changeRefs: readonly string[];
    externalSignalRefs: readonly string[];
    modelCandidateHypothesisTypes?: readonly string[];
    /** Exact predecessor when this evaluation supersedes a prior conclusion. */
    supersedesReasoningId?: string | null;
  },
  deps: StrategicReasoningDeps,
  executor: StrategicReasoningStoreExecutor
): Promise<EvaluateStrategicReasoningResult> {
  const now = resolveNow(deps);
  const nowMs = now.getTime();
  const evaluatedAt = now.toISOString();
  await assertBusinessOwnership(executor, input.userId, input.businessId);

  const { views, items } = await resolveEvidenceBundle({
    userId: input.userId,
    businessId: input.businessId,
    memoryRefs: input.memoryRefs,
    changeRefs: input.changeRefs,
    externalSignalRefs: input.externalSignalRefs,
    evidence: deps.evidence,
  });

  const synthesis = synthesizeStrategicReasoning({
    evidence: views,
    nowMs,
    modelCandidateHypothesisTypes: input.modelCandidateHypothesisTypes,
  });

  const evidenceBundleId = deriveEvidenceBundleId({ businessId: input.businessId, items });
  const evidenceFingerprint = deriveEvidenceFingerprint({ businessId: input.businessId, items });
  const supportingRefs = synthesis.supportingEvidence.map((s) => s.ref);
  const contradictingRefs = synthesis.contradictingEvidence.map((c) => c.ref);
  const hypothesisId = deriveHypothesisId({
    evidenceBundleId,
    hypothesisType: synthesis.hypothesisType,
    supportingRefs,
  });
  const limitations = [
    "Strategic conclusions are evidence-preserving synthesis, not source truth.",
    "Association is not causation; no causal claim is made or implied.",
    ...(synthesis.contradictingEvidence.length > 0
      ? [`Active contradiction preserved on ${synthesis.contradictingEvidence.length} evidence ref(s) — conflict stays visible.`]
      : []),
    ...(synthesis.missingEvidence.length > 0
      ? [`Missing evidence: ${synthesis.missingEvidence.join(", ")}.`]
      : []),
  ].slice(0, 8);
  const reasoningFingerprint = deriveReasoningFingerprint({
    evidenceBundleId,
    hypothesisId,
    hypothesisType: synthesis.hypothesisType,
    implicationType: synthesis.implicationType,
    supportingRefs,
    contradictingRefs,
    missingEvidence: synthesis.missingEvidence,
    confidenceClass: synthesis.confidenceClass,
    uncertaintyClasses: synthesis.uncertaintyClasses,
    limitations,
  });
  const reasoningId = deriveReasoningId({
    businessId: input.businessId,
    evidenceBundleId,
    reasoningFingerprint,
  });

  // Persist the deterministic evidence bundle (converges on replay).
  await insertStrategicReasoningBundle(executor, {
    bundleId: evidenceBundleId,
    userId: input.userId,
    businessId: input.businessId,
    evidenceRefs: {
      memoryRefs: [...input.memoryRefs].sort(),
      changeRefs: [...input.changeRefs].sort(),
      externalSignalRefs: [...input.externalSignalRefs].sort(),
      resolved: items,
    },
    evidenceFingerprint,
    reasoningGraph: synthesis.graph,
    sourceVersions: STRATEGIC_REASONING_BOUND_VERSIONS,
  });

  // Mandatory R8-F governance for voiced recommendations.
  let governance: StrategicGovernanceDecisionView | null = null;
  let status: StrategicReasoningStatus = "CANDIDATE";
  let validUntil: string | null = null;
  const requiresGovernance =
    synthesis.implicationType !== "NO_ACTION" && synthesis.confidenceClass !== "INSUFFICIENT";
  if (requiresGovernance) {
    const engine = getStrategicGovernanceEnginePort();
    const evidenceRefs = [...input.memoryRefs, ...input.changeRefs, ...input.externalSignalRefs].sort();
    const proposal = buildGovernanceProposal({
      reasoningId,
      businessId: input.businessId,
      hypothesisType: synthesis.hypothesisType,
      implicationType: synthesis.implicationType,
      confidenceClass: synthesis.confidenceClass,
      uncertaintyClasses: synthesis.uncertaintyClasses,
      evidenceRefs,
      externalEvidenceInvolved: views.some((v) => v.evidenceClass === "EXTERNAL_SIGNAL"),
      injectionSuspected: views.some((v) => v.evidenceClass === "EXTERNAL_SIGNAL" && v.injectionSuspected),
    });
    const raw = await engine.evaluateProposal({
      userId: input.userId,
      businessId: input.businessId,
      proposal,
    });
    governance = validateStrategicGovernanceDecisionView(raw);
    if (governance.businessId !== input.businessId || governance.proposalId !== reasoningId) {
      fail("GOVERNANCE_DECISION_MALFORMED", "governance decision does not bind this reasoning proposal");
    }
    status =
      governance.decision === "ALLOW_RECOMMENDATION"
        ? "SUPPORTED"
        : governance.decision === "REVIEW_REQUIRED"
          ? "REVIEW_REQUIRED"
          : "BLOCKED";
    validUntil = governance.validUntil;
  }

  const recordRow: StrategicReasoningRecordRow = {
    reasoningId,
    userId: input.userId,
    businessId: input.businessId,
    bundleId: evidenceBundleId,
    hypothesisId,
    hypothesisType: synthesis.hypothesisType,
    implicationType: synthesis.implicationType,
    supportingEvidence: synthesis.supportingEvidence,
    contradictingEvidence: synthesis.contradictingEvidence,
    missingEvidence: synthesis.missingEvidence,
    confidenceClass: synthesis.confidenceClass,
    uncertaintyClasses: synthesis.uncertaintyClasses,
    strategicRiskClass: governance ? governance.strategicRiskClass : null,
    status,
    governanceDecisionId: governance ? governance.governanceDecisionId : null,
    governanceDecision: governance ? governance.decision : null,
    governanceDecisionRecord: governance,
    policyVersion: governance ? governance.policyVersion : null,
    evidenceFingerprint,
    reasoningFingerprint,
    limitations,
    validUntil,
    supersedesReasoningId: input.supersedesReasoningId ?? null,
    sourceVersions: STRATEGIC_REASONING_BOUND_VERSIONS,
  };

  const { inserted } = await insertStrategicReasoningRecord(executor, recordRow);

  if (inserted) {
    if (governance) {
      await insertStrategicReasoningLifecycleEvent(executor, {
        lifecycleEventId: deriveLifecycleEventId({
          reasoningId,
          lifecycleType: "governance_binding",
          targetStatus: status,
          successorReasoningId: null,
          occurredAt: evaluatedAt,
          reasonCode: governance.decision,
        }),
        reasoningId,
        userId: input.userId,
        lifecycleType: "governance_binding",
        targetStatus: status,
        successorReasoningId: null,
        occurredAt: evaluatedAt,
        reasonCode: governance.decision,
      });
    }
    const audit = createAuditEvent({
      eventType: "strategic_reasoning_recorded",
      occurredAt: evaluatedAt,
      userId: input.userId,
      businessId: input.businessId,
      source: "system",
      outcome: "succeeded",
      metadata: {
        contractVersion: STRATEGIC_REASONING_CONTRACT_VERSION,
        engineVersion: STRATEGIC_REASONING_ENGINE_VERSION,
        reasoningId,
        evidenceBundleId,
        hypothesisId,
        hypothesisType: synthesis.hypothesisType,
        implicationType: synthesis.implicationType,
        confidenceClass: synthesis.confidenceClass,
        uncertaintyClasses: synthesis.uncertaintyClasses,
        status,
        governanceDecisionId: governance ? governance.governanceDecisionId : null,
        governanceDecision: governance ? governance.decision : null,
        policyVersion: governance ? governance.policyVersion : null,
        strategicRiskClass: governance ? governance.strategicRiskClass : null,
        evidenceCount: items.length,
        supportingCount: synthesis.supportingEvidence.length,
        contradictingCount: synthesis.contradictingEvidence.length,
        rationaleCode: synthesis.rationaleCode,
      },
    });
    await persistAuditEvent(audit, asAuditExecutor(executor));
  }

  const stored = await getStrategicReasoningRecord(executor, input.userId, reasoningId);
  const approvalStatus = await deriveStoredApprovalStatus(deps, stored ?? recordRow);
  return {
    reasoning: buildStrategicReasoningProjection({
      row: stored ?? recordRow,
      approvalStatus,
      nowMs,
    }),
    governanceDecision: governance,
    duplicateClassification: inserted ? "none" : "idempotent_replay",
    rationaleCode: synthesis.rationaleCode,
  };
}

async function deriveStoredApprovalStatus(
  deps: StrategicReasoningDeps,
  row: Pick<
    StrategicReasoningRecordRow,
    "userId" | "governanceDecisionId" | "governanceDecisionRecord" | "policyVersion"
  >
): Promise<"none" | "pending" | "approved" | "rejected"> {
  if (!row.governanceDecisionId || !row.policyVersion || !row.governanceDecisionRecord) return "none";
  // The bound R8-F decision record is the fingerprint authority: the approval
  // binding is validated against ITS proposal/evidence fingerprints exactly.
  const decision = row.governanceDecisionRecord as {
    governanceDecisionId: string;
    policyVersion: string;
    proposalFingerprint: string;
    evidenceFingerprint: string;
  };
  const approvals = await deps.approvals.listApprovalsForDecision(row.userId, row.governanceDecisionId);
  return deriveApprovalStatus({ decision, approvals });
}

/**
 * Current state is derived, history is never edited (contract §8): a
 * demotion recorded as an append-only lifecycle fact overrides the stored
 * status in every read projection.
 */
async function deriveRowWithCurrentStatus(
  executor: StrategicReasoningStoreExecutor,
  row: StrategicReasoningRecordRow
): Promise<StrategicReasoningRecordRow> {
  if (row.status === "BLOCKED" || row.status === "SUPERSEDED") return row;
  const lifecycle = await listStrategicReasoningLifecycle(executor, row.userId, row.reasoningId);
  const demotions = lifecycle.filter(
    (e) =>
      e.targetStatus === "CONTRADICTED" ||
      e.targetStatus === "STALE" ||
      e.targetStatus === "SUPERSEDED" ||
      e.targetStatus === "INVALIDATED"
  );
  if (demotions.length === 0) return row;
  const latest = demotions[demotions.length - 1];
  if (latest.targetStatus === row.status) return row;
  return { ...row, status: latest.targetStatus };
}

// ─── Reads ───

export async function getStrategicReasoningForUser(input: {
  userId: number;
  reasoningId: string;
  deps: StrategicReasoningDeps;
  executor: StrategicReasoningStoreExecutor;
}): Promise<{ reasoning: StrategicReasoningProjection; lifecycle: unknown[] }> {
  const { userId, reasoningId, deps, executor } = input;
  const stored = await getStrategicReasoningRecord(executor, userId, reasoningId);
  if (!stored) fail("REASONING_NOT_FOUND", `reasoning ${reasoningId} not found for this tenant`);
  const row = await deriveRowWithCurrentStatus(executor, stored);
  const lifecycle = await listStrategicReasoningLifecycle(executor, userId, reasoningId);
  const approvalStatus = await deriveStoredApprovalStatus(deps, row);
  return {
    reasoning: buildStrategicReasoningProjection({ row, approvalStatus, nowMs: resolveNow(deps).getTime() }),
    lifecycle,
  };
}

export async function listStrategicReasoningForUser(input: {
  userId: number;
  businessId?: number;
  status?: string;
  hypothesisType?: string;
  deps: StrategicReasoningDeps;
  executor: StrategicReasoningStoreExecutor;
}): Promise<StrategicReasoningProjection[]> {
  const { userId, deps, executor } = input;
  const rows = await listStrategicReasoningRecords(executor, {
    userId,
    businessId: input.businessId,
    status: input.status,
    hypothesisType: input.hypothesisType,
  });
  const nowMs = resolveNow(deps).getTime();
  const out: StrategicReasoningProjection[] = [];
  for (const stored of rows) {
    const row = await deriveRowWithCurrentStatus(executor, stored);
    const approvalStatus = await deriveStoredApprovalStatus(deps, row);
    out.push(buildStrategicReasoningProjection({ row, approvalStatus, nowMs }));
  }
  return out;
}

export async function getStrategicReasoningHandoffProjections(input: {
  userId: number;
  businessId: number;
  includeNonActive: boolean;
  deps: StrategicReasoningDeps;
  executor: StrategicReasoningStoreExecutor;
}): Promise<StrategicReasoningProjection[]> {
  const { userId, businessId, includeNonActive, deps, executor } = input;
  await assertBusinessOwnership(executor, userId, businessId);
  const all = await listStrategicReasoningForUser({ userId, businessId, deps, executor });
  const filtered = includeNonActive
    ? all
    : all.filter((p) => p.status === "SUPPORTED" || p.status === "APPROVED_RECOMMENDATION" || p.status === "REVIEW_REQUIRED");
  return filtered;
}

// ─── Re-evaluation (D7) ───

export interface ReevaluateStrategicReasoningResult {
  readonly reasoning: StrategicReasoningProjection;
  readonly outcome: "unchanged" | "superseded" | "contradicted" | "stale" | "invalidated";
  readonly successorReasoningId: string | null;
}

export async function reevaluateStrategicReasoning(input: {
  userId: number;
  reasoningId: string;
  deps: StrategicReasoningDeps;
  executor: StrategicReasoningStoreExecutor;
}): Promise<ReevaluateStrategicReasoningResult> {
  const { userId, reasoningId, deps, executor } = input;
  const now = resolveNow(deps);
  const storedExisting = await getStrategicReasoningRecord(executor, userId, reasoningId);
  if (!storedExisting) fail("REASONING_NOT_FOUND", `reasoning ${reasoningId} not found for this tenant`);
  const existing = await deriveRowWithCurrentStatus(executor, storedExisting);
  const bundle = await getStrategicReasoningBundle(executor, userId, existing.bundleId);
  if (!bundle) fail("EVIDENCE_AUTHORITY_UNAVAILABLE", `evidence bundle ${existing.bundleId} is unavailable`);

  const evidenceRefs = bundle.evidenceRefs as {
    memoryRefs?: string[];
    changeRefs?: string[];
    externalSignalRefs?: string[];
  };
  const resolved = await resolveEvidenceBundle({
    userId,
    businessId: existing.businessId,
    memoryRefs: evidenceRefs.memoryRefs ?? [],
    changeRefs: evidenceRefs.changeRefs ?? [],
    externalSignalRefs: evidenceRefs.externalSignalRefs ?? [],
    evidence: deps.evidence,
  });

  const reEvaluated = await evaluateStrategicReasoning(
    {
      userId,
      businessId: existing.businessId,
      memoryRefs: evidenceRefs.memoryRefs ?? [],
      changeRefs: evidenceRefs.changeRefs ?? [],
      externalSignalRefs: evidenceRefs.externalSignalRefs ?? [],
      supersedesReasoningId: reasoningId,
    },
    deps,
    executor
  );

  if (reEvaluated.reasoning.reasoningId === reasoningId) {
    // Material unchanged — check lifecycle demotions from evidence state.
    const contradicted = resolved.views.some((v) => {
      if (v.evidenceClass === "INTERNAL_MEMORY") return v.factStatus === "CONTRADICTED";
      if (v.evidenceClass === "INTERNAL_CHANGE") return v.status === "CONTRADICTED";
      return v.signalStatus === "CONTRADICTED" || v.corroborationStatus === "CONTRADICTED";
    });
    const anyUsable = resolved.views.some((v) => {
      if (v.evidenceClass === "INTERNAL_MEMORY") return v.factStatus === "CURRENT";
      if (v.evidenceClass === "INTERNAL_CHANGE") return v.status === "DETECTED" || v.status === "CONFIRMED";
      return v.signalStatus === "OBSERVED" || v.signalStatus === "CORROBORATED";
    });
    if (contradicted && existing.status !== "CONTRADICTED") {
      await demoteReasoning(executor, existing, "CONTRADICTED", "contradiction", now.toISOString(), null);
      return {
        reasoning: await rebuiltProjection(executor, deps, userId, existing.reasoningId),
        outcome: "contradicted",
        successorReasoningId: null,
      };
    }
    const expired = existing.validUntil !== null && isIsoUtc(existing.validUntil) && Date.parse(existing.validUntil) < now.getTime();
    if (!anyUsable && existing.status !== "STALE") {
      await demoteReasoning(executor, existing, "STALE", "staleness", now.toISOString(), null);
      return {
        reasoning: await rebuiltProjection(executor, deps, userId, existing.reasoningId),
        outcome: "stale",
        successorReasoningId: null,
      };
    }
    if (expired && existing.status !== "STALE") {
      await demoteReasoning(executor, existing, "STALE", "staleness", now.toISOString(), null);
      return {
        reasoning: await rebuiltProjection(executor, deps, userId, existing.reasoningId),
        outcome: "stale",
        successorReasoningId: null,
      };
    }
    return { reasoning: reEvaluated.reasoning, outcome: "unchanged", successorReasoningId: null };
  }

  // Material changed ⇒ a NEW record is minted (immutable history) and the
  // prior conclusion's terminal label classifies the change: contradiction
  // and staleness stay visible rather than reading as a silent replacement.
  const freshContradicted = resolved.views.some((v) => {
    if (v.evidenceClass === "INTERNAL_MEMORY") return v.factStatus === "CONTRADICTED";
    if (v.evidenceClass === "INTERNAL_CHANGE") return v.status === "CONTRADICTED";
    return v.signalStatus === "CONTRADICTED" || v.corroborationStatus === "CONTRADICTED";
  });
  const freshAnyUsable = resolved.views.some((v) => {
    if (v.evidenceClass === "INTERNAL_MEMORY") return v.factStatus === "CURRENT";
    if (v.evidenceClass === "INTERNAL_CHANGE") return v.status === "DETECTED" || v.status === "CONFIRMED";
    return v.signalStatus === "OBSERVED" || v.signalStatus === "CORROBORATED";
  });
  if (freshContradicted && existing.status !== "CONTRADICTED") {
    await demoteReasoning(
      executor,
      existing,
      "CONTRADICTED",
      "contradiction",
      now.toISOString(),
      reEvaluated.reasoning.reasoningId
    );
    return {
      reasoning: reEvaluated.reasoning,
      outcome: "contradicted",
      successorReasoningId: reEvaluated.reasoning.reasoningId,
    };
  }
  if (!freshAnyUsable && existing.status !== "STALE") {
    await demoteReasoning(
      executor,
      existing,
      "STALE",
      "staleness",
      now.toISOString(),
      reEvaluated.reasoning.reasoningId
    );
    return {
      reasoning: reEvaluated.reasoning,
      outcome: "stale",
      successorReasoningId: reEvaluated.reasoning.reasoningId,
    };
  }
  await demoteReasoning(
    executor,
    existing,
    "SUPERSEDED",
    "supersession",
    now.toISOString(),
    reEvaluated.reasoning.reasoningId
  );
  return {
    reasoning: reEvaluated.reasoning,
    outcome: "superseded",
    successorReasoningId: reEvaluated.reasoning.reasoningId,
  };
}

async function rebuiltProjection(
  executor: StrategicReasoningStoreExecutor,
  deps: StrategicReasoningDeps,
  userId: number,
  reasoningId: string
): Promise<StrategicReasoningProjection> {
  const stored = await getStrategicReasoningRecord(executor, userId, reasoningId);
  if (!stored) fail("REASONING_NOT_FOUND", `reasoning ${reasoningId} not found for this tenant`);
  const row = await deriveRowWithCurrentStatus(executor, stored);
  const approvalStatus = await deriveStoredApprovalStatus(deps, row);
  return buildStrategicReasoningProjection({
    row,
    approvalStatus,
    nowMs: resolveNow(deps).getTime(),
  });
}

async function demoteReasoning(
  executor: StrategicReasoningStoreExecutor,
  existing: StrategicReasoningRecordRow,
  targetStatus: StrategicReasoningStatus,
  lifecycleType: "supersession" | "contradiction" | "staleness" | "invalidation",
  occurredAt: string,
  successorReasoningId: string | null
): Promise<void> {
  if (existing.status === "BLOCKED" || existing.status === "SUPERSEDED") return;
  await insertStrategicReasoningLifecycleEvent(executor, {
    lifecycleEventId: deriveLifecycleEventId({
      reasoningId: existing.reasoningId,
      lifecycleType,
      targetStatus,
      successorReasoningId,
      occurredAt,
      reasonCode: `RE_${lifecycleType.toUpperCase()}`,
    }),
    reasoningId: existing.reasoningId,
    userId: existing.userId,
    lifecycleType,
    targetStatus,
    successorReasoningId,
    occurredAt,
    reasonCode: `RE_${lifecycleType.toUpperCase()}`,
  });
  const audit = createAuditEvent({
    eventType: "strategic_reasoning_lifecycle",
    occurredAt,
    userId: existing.userId,
    businessId: existing.businessId,
    source: "system",
    outcome: "succeeded",
    metadata: {
      contractVersion: STRATEGIC_REASONING_CONTRACT_VERSION,
      reasoningId: existing.reasoningId,
      lifecycleType,
      targetStatus,
      successorReasoningId,
    },
  });
  await persistAuditEvent(audit, asAuditExecutor(executor));
}
