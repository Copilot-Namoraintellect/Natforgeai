// ─── R5-D Opportunity Detection — orchestration (D3, D4, D6, D7, D8) ───
//
// The governed evaluation pipeline: adapt → authorize (tenant/ownership) →
// replay-check → policy gates (D6) → rule table (D2) → thread-history
// aggregation (D3) → durable candidate evidence (D4) → bounded confidence (D5)
// → lifecycle (D8). Emits exactly one canonical audit event per durable effect
// via the existing WBS7 authority. Single clock read at the boundary; explicit
// time everywhere below it. Never creates leads, scores, CRM rows, or actions.

import { and, eq } from "drizzle-orm";
import {
  businesses,
  campaigns,
  opportunityCandidates,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { persistAuditEvent } from "../audit/audit-store";
import { createAuditEvent } from "../audit/audit-event";
import type {
  CanonicalInterpretation,
} from "./canonical-intelligence";
import { toCanonicalInterpretation } from "./canonical-intelligence";
import {
  evaluateDetectionRules,
  EMPTY_THREAD_HISTORY,
  isComplaintClassIntent,
  isPraiseClassIntent,
  type ThreadHistoryContext,
} from "./detection-rules";
import {
  computeEvidenceStrength,
  computeConfidenceClass,
  recencyCap,
  maxUrgency,
  isContradiction,
  type StrengthEvidenceInput,
} from "./evidence-strength";
import {
  canTransition,
  statusForStrength,
  type LifecycleTransition,
} from "./opportunity-lifecycle";
import {
  applyPolicyGates,
  applyExplicitPolicySuppression,
  type PolicyDecisionLike,
} from "./policy-gates";
import {
  toValidatedEngagementReceipt,
} from "./engagement-evidence-seam";
import {
  buildThreadCoordinates,
  deriveActorKey,
  deriveThreadKey,
  deriveTopicKey,
  deriveDisplayTopic,
  deriveOpportunityKey,
  deriveOpportunityId,
  deriveEvidenceHash,
  HANDOFF_ID_PREFIX,
} from "./opportunity-identity";
import {
  DETECTOR_RULES_VERSION,
  HANDOFF_ENVELOPE_VERSION,
  OpportunityOwnershipError,
  OpportunityStateConflictError,
  OpportunityInputError,
  canonicalJson,
  sha256Hex,
  type EvidenceRef,
  type OpportunityHandoffEnvelope,
  type OpportunityStatus,
  type SuppressionReason,
} from "./opportunity-contract";
import * as store from "./opportunity-store";
import type { OpportunityStoreExecutor } from "./opportunity-store";

// ─── Configuration (server-side; overridable for tests) ───

export interface OpportunityDetectorConfig {
  /** Evidence window (contract §10). Default 168h. */
  evidenceWindowMs: number;
  /** Volume guard (contract §9.4). Default 10 new candidates per actor/window. */
  maxNewCandidatesPerActorWindow: number;
  /** Flood-guard lookback. Default 24h. */
  floodWindowMs: number;
}

export const DEFAULT_OPPORTUNITY_DETECTOR_CONFIG: OpportunityDetectorConfig = {
  evidenceWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxNewCandidatesPerActorWindow: 10,
  floodWindowMs: 24 * 60 * 60 * 1000,
};

// ─── Authorization (tenant/ownership, no client-supplied authority) ───

async function assertOwnership(
  interpretation: CanonicalInterpretation,
  sessionUserId: number,
  executor?: OpportunityStoreExecutor
): Promise<void> {
  if (interpretation.userId !== sessionUserId) {
    throw new OpportunityOwnershipError(
      "OWNERSHIP_MISMATCH",
      "interpretation tenant does not match the authenticated session."
    );
  }
  const db = executor ?? getDb();
  if (interpretation.businessId !== null) {
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(eq(businesses.id, interpretation.businessId), eq(businesses.userId, sessionUserId)))
      .limit(1);
    if (!business) {
      throw new OpportunityOwnershipError(
        "OWNERSHIP_MISMATCH",
        `business ${interpretation.businessId} is not owned by the session tenant.`
      );
    }
  }
  if (interpretation.sourceCampaignId !== null) {
    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, interpretation.sourceCampaignId), eq(campaigns.userId, sessionUserId)))
      .limit(1);
    if (!campaign) {
      throw new OpportunityOwnershipError(
        "OWNERSHIP_MISMATCH",
        `campaign ${interpretation.sourceCampaignId} is not owned by the session tenant.`
      );
    }
  }
}

// ─── Audit emission (one canonical event per durable effect) ───

async function emitOpportunityAudit(input: {
  eventType: "opportunity_detected" | "opportunity_suppressed" | "opportunity_state_changed" | "opportunity_handed_off";
  userId: number;
  businessId: number | null;
  campaignId: number | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
  executor?: OpportunityStoreExecutor;
}): Promise<void> {
  const event = createAuditEvent({
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: input.campaignId,
    businessId: input.businessId,
    metadata: input.metadata,
  });
  await persistAuditEvent(event, input.executor);
}

// ─── Outcome descriptors (no raw text, no PII) ───

export type EvaluationOutcome =
  | {
      kind: "candidate_created" | "candidate_strengthened";
      opportunityId: string;
      opportunityType: string;
      opportunityStatus: string;
      confidenceClass: string;
      evidenceStrength: string;
      evidenceCount: number;
      duplicateClassification: "none" | "idempotent_replay";
    }
  | {
      kind: "suppressed";
      reason: SuppressionReason;
      detail: string;
      duplicateClassification: "none" | "idempotent_replay";
    }
  | {
      kind: "idempotent_replay";
      outcome: "candidate" | "suppression";
      opportunityId?: string;
      reason?: SuppressionReason;
    };

// ─── Main evaluation pipeline ───

export interface EvaluateOpportunityInput {
  /** Raw R5-B-facing interpretation (validated by the seam). */
  interpretation: unknown;
  /** Authenticated tenant user (ctx.user.id). */
  userId: number;
  /** Optional explicit R5-E policy decision (read-only seam, D6). */
  policyDecision?: PolicyDecisionLike | null;
  /** Clock injection for deterministic tests; defaults to boundary read. */
  now?: Date;
  executor?: OpportunityStoreExecutor;
  config?: Partial<OpportunityDetectorConfig>;
}

export async function evaluateOpportunity(
  input: EvaluateOpportunityInput
): Promise<EvaluationOutcome> {
  const cfg: OpportunityDetectorConfig = { ...DEFAULT_OPPORTUNITY_DETECTOR_CONFIG, ...input.config };
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const executor = input.executor;

  const interpretation = toCanonicalInterpretation(input.interpretation);
  await assertOwnership(interpretation, input.userId, executor);

  // Replay checks first: one interpretation produces at most one durable
  // outcome ever (unique interpretationId on evidence and suppressions).
  const existingEvidence = await store.findEvidenceByInterpretation(
    input.userId,
    interpretation.interpretationId,
    executor
  );
  if (existingEvidence) {
    const candidate = await store.findCandidateById(
      input.userId,
      Number(existingEvidence.candidateId),
      executor
    );
    return {
      kind: "idempotent_replay",
      outcome: "candidate",
      opportunityId: candidate?.opportunityId,
    };
  }
  const existingSuppression = await store.findSuppressionByInterpretation(
    input.userId,
    interpretation.interpretationId,
    executor
  );
  if (existingSuppression) {
    return {
      kind: "idempotent_replay",
      outcome: "suppression",
      reason: existingSuppression.reason,
    };
  }

  // D6 gates: explicit policy suppression, then safety/risk gates.
  const explicitPolicy = applyExplicitPolicySuppression(input.policyDecision ?? null);
  if (explicitPolicy.gated) {
    return suppressEvaluation(interpretation, explicitPolicy.reason, explicitPolicy.detail, nowIso, executor);
  }
  const policyGate = applyPolicyGates(interpretation);
  if (policyGate.gated) {
    if (policyGate.reason === "SAFETY_ESCALATION") {
      // Safety evidence on an existing thread escalates live candidates.
      await escalateThreadCandidates(interpretation, nowIso, executor);
    }
    return suppressEvaluation(interpretation, policyGate.reason, policyGate.detail, nowIso, executor);
  }

  // Thread-history aggregation context (R9/R10) — same tenant + thread only.
  const actorKey = deriveActorKey(interpretation);
  const threadKey = deriveThreadKey(interpretation);
  const history = await buildThreadHistory(input.userId, threadKey, nowMs, cfg, executor);

  // D2 rule table.
  const evaluation = evaluateDetectionRules(interpretation, history);
  const outcome = evaluation.outcome;

  if (outcome.kind === "suppression") {
    return suppressEvaluation(interpretation, outcome.reason, `${outcome.ruleId}: ${outcome.detail}`, nowIso, executor);
  }

  // Candidate-worthy: deterministic identity (D4).
  const opportunityType = outcome.opportunityType;
  const topicKey = deriveTopicKey(interpretation);
  const coordinates = buildThreadCoordinates({
    userId: input.userId,
    businessId: interpretation.businessId,
    opportunityType,
    actorKey,
    threadKey,
    topicKey,
  });
  const opportunityKey = deriveOpportunityKey(coordinates);
  const opportunityId = deriveOpportunityId(opportunityKey);

  // Flood guard (D6 §9.4): bounded candidates per actor per window.
  const recentForActor = await store.countRecentCandidatesForActor(
    input.userId,
    actorKey,
    nowMs - cfg.floodWindowMs,
    executor
  );
  if (recentForActor >= cfg.maxNewCandidatesPerActorWindow) {
    return suppressEvaluation(
      interpretation,
      "FLOOD_GUARDED",
      `actor exceeded ${cfg.maxNewCandidatesPerActorWindow} new candidates in the flood window`,
      nowIso,
      executor
    );
  }

  const occurredAt = interpretation.occurredAt ?? interpretation.createdAt;

  // Find or create the durable candidate (unique (userId, opportunityKey)).
  let candidate = await store.findCandidateByKey(input.userId, opportunityKey, executor);
  let candidateCreated = false;
  if (!candidate) {
    const evidenceRef: EvidenceRef = {
      interpretationId: interpretation.interpretationId,
      signalId: interpretation.signalId,
      signalVersion: interpretation.signalVersion,
      occurredAt,
    };
    const strength = initialStrength(interpretation);
    const status = statusForStrength(strength, null);
    const insertResult = await store.insertCandidate(
      {
        opportunityId,
        opportunityKey,
        userId: input.userId,
        businessId: interpretation.businessId,
        opportunityType,
        opportunityStatus: status,
        confidenceClass: strength === "UNKNOWN" ? "UNKNOWN" : strength,
        evidenceStrength: strength,
        urgency: interpretation.urgency,
        topic: deriveDisplayTopic(interpretation),
        topicKey,
        actorKey,
        threadKey,
        campaignId: interpretation.sourceCampaignId,
        publicationId: interpretation.sourcePublicationId,
        provider: interpretation.provider,
        externalActorReference: null,
        firstEvidence: evidenceRef,
        latestEvidence: evidenceRef,
        firstObservedAt: occurredAt,
        lastObservedAt: occurredAt,
        evidenceCount: 0,
        contradictionCount: 0,
        detectorRulesVersion: DETECTOR_RULES_VERSION,
        classifierVersions: [interpretation.classifierVersion],
        version: 1,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        handedOffAt: null,
      },
      executor
    );
    candidate = insertResult.row;
    candidateCreated = insertResult.inserted;
  }

  // Append immutable evidence (unique interpretationId → replay-safe).
  const evidenceRow = buildEvidenceRow(candidate, interpretation, opportunityType, occurredAt, now);
  const evidenceResult = await store.insertEvidence(evidenceRow, executor);
  if (!evidenceResult.inserted) {
    // Lost a concurrent race after candidate convergence: replay.
    return {
      kind: "idempotent_replay",
      outcome: "candidate",
      opportunityId: candidate.opportunityId,
    };
  }

  // D3/D5: recompute deterministic aggregate state over ALL candidate evidence.
  const allEvidence = await store.listEvidenceForCandidate(Number(candidate.id), executor);
  const recomputed = recomputeCandidateState(candidate, allEvidence, nowMs, cfg);

  // Lifecycle application. New evidence on active statuses strengthens; on
  // expired it revives; on suppressed/escalated/handed_off it is recorded as
  // immutable evidence but NEVER reactivates state on its own (explicit
  // unsuppress or a new handoff attempt is required).
  const currentStatus = candidate.opportunityStatus;
  const terminalForAutoReactivation =
    currentStatus === "suppressed" ||
    currentStatus === "escalated" ||
    currentStatus === "handed_off_to_r6";
  if (terminalForAutoReactivation) {
    await emitOpportunityAudit({
      eventType: "opportunity_state_changed",
      userId: input.userId,
      businessId: candidate.businessId ? Number(candidate.businessId) : null,
      campaignId: candidate.campaignId ? Number(candidate.campaignId) : null,
      occurredAt: nowIso,
      metadata: {
        opportunityId: candidate.opportunityId,
        action: "evidence_recorded_without_reactivation",
        opportunityStatus: currentStatus,
        evidenceCount: allEvidence.length,
      },
      executor,
    });
    return {
      kind: "candidate_strengthened",
      opportunityId: candidate.opportunityId,
      opportunityType: candidate.opportunityType,
      opportunityStatus: currentStatus,
      confidenceClass: candidate.confidenceClass,
      evidenceStrength: candidate.evidenceStrength,
      evidenceCount: allEvidence.length,
      duplicateClassification: "none",
    };
  }

  const updated = await store.updateCandidateState(
    input.userId,
    Number(candidate.id),
    candidate.version,
    {
      opportunityStatus: recomputed.status as never,
      confidenceClass: recomputed.confidenceClass as never,
      evidenceStrength: recomputed.evidenceStrength as never,
      urgency: recomputed.urgency as never,
      latestEvidence: recomputed.latestEvidence,
      firstObservedAt: recomputed.firstObservedAt,
      lastObservedAt: recomputed.lastObservedAt,
      evidenceCount: recomputed.evidenceCount,
      contradictionCount: recomputed.contradictionCount,
      classifierVersions: recomputed.classifierVersions,
      statusChangedAt:
        recomputed.status !== candidate.opportunityStatus ? now : candidate.statusChangedAt,
      updatedAt: now,
    },
    executor
  );

  await emitOpportunityAudit({
    eventType: "opportunity_detected",
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: updated.campaignId ? Number(updated.campaignId) : null,
    occurredAt: nowIso,
    metadata: {
      opportunityId: updated.opportunityId,
      action: candidateCreated ? "candidate_created" : "candidate_strengthened",
      opportunityType: updated.opportunityType,
      opportunityStatus: updated.opportunityStatus,
      confidenceClass: updated.confidenceClass,
      evidenceStrength: updated.evidenceStrength,
      evidenceCount: updated.evidenceCount,
      detectorRulesVersion: DETECTOR_RULES_VERSION,
      ruleId: outcome.ruleId,
    },
    executor,
  });

  return {
    kind: candidateCreated ? "candidate_created" : "candidate_strengthened",
    opportunityId: updated.opportunityId,
    opportunityType: updated.opportunityType,
    opportunityStatus: updated.opportunityStatus,
    confidenceClass: updated.confidenceClass,
    evidenceStrength: updated.evidenceStrength,
    evidenceCount: updated.evidenceCount,
    duplicateClassification: "none",
  };
}

// ─── Suppression path ───

async function suppressEvaluation(
  interpretation: CanonicalInterpretation,
  reason: SuppressionReason,
  detail: string,
  nowIso: string,
  executor?: OpportunityStoreExecutor
): Promise<EvaluationOutcome> {
  const occurredAt = interpretation.occurredAt ?? interpretation.createdAt;
  const result = await store.insertSuppression(
    {
      userId: interpretation.userId,
      businessId: interpretation.businessId,
      interpretationId: interpretation.interpretationId,
      signalId: interpretation.signalId,
      reason,
      detail: detail.slice(0, 255),
      actorKey: deriveActorKey(interpretation),
      threadKey: deriveThreadKey(interpretation),
      intent: interpretation.intent,
      occurredAt,
      createdAt: new Date(nowIso),
    },
    executor
  );
  if (result.inserted) {
    await emitOpportunityAudit({
      eventType: "opportunity_suppressed",
      userId: interpretation.userId,
      businessId: interpretation.businessId,
      campaignId: interpretation.sourceCampaignId,
      occurredAt: nowIso,
      metadata: {
        reason,
        interpretationId: interpretation.interpretationId,
        signalId: interpretation.signalId,
        intent: interpretation.intent,
        detail: detail.slice(0, 255),
      },
      executor,
    });
  }
  return {
    kind: "suppressed",
    reason,
    detail,
    duplicateClassification: result.duplicateClassification,
  };
}

// ─── Thread history (D3) ───

async function buildThreadHistory(
  userId: number,
  threadKey: string,
  nowMs: number,
  cfg: OpportunityDetectorConfig,
  executor?: OpportunityStoreExecutor
): Promise<ThreadHistoryContext> {
  if (threadKey === "no-thread") return EMPTY_THREAD_HISTORY;
  const sinceIso = new Date(nowMs - cfg.evidenceWindowMs).toISOString();
  const rows = await store.findThreadSuppressionHistory(userId, threadKey, sinceIso, executor);
  const intents = rows.map((r) => r.intent);
  return {
    priorSuppressionIntents: intents,
    hasPriorComplaintClassSuppression: intents.some(isComplaintClassIntent),
    hasPriorPraiseClassSuppression: intents.some(isPraiseClassIntent),
  };
}

async function escalateThreadCandidates(
  interpretation: CanonicalInterpretation,
  nowIso: string,
  executor?: OpportunityStoreExecutor
): Promise<void> {
  const userId = interpretation.userId;
  const threadKey = deriveThreadKey(interpretation);
  if (threadKey === "no-thread") return;
  const db = executor ?? getDb();
  const rows = await db
    .select()
    .from(opportunityCandidates)
    .where(
      and(
        eq(opportunityCandidates.userId, userId),
        eq(opportunityCandidates.threadKey, threadKey)
      )
    );
  for (const row of rows) {
    if (!canTransition("escalate", row.opportunityStatus as never)) continue;
    try {
      const updated = await store.updateCandidateState(
        userId,
        Number(row.id),
        row.version,
        {
          opportunityStatus: "escalated" as never,
          statusChangedAt: new Date(nowIso),
          updatedAt: new Date(nowIso),
        },
        executor
      );
      await emitOpportunityAudit({
        eventType: "opportunity_state_changed",
        userId,
        businessId: updated.businessId ? Number(updated.businessId) : null,
        campaignId: updated.campaignId ? Number(updated.campaignId) : null,
        occurredAt: nowIso,
        metadata: {
          opportunityId: updated.opportunityId,
          action: "escalated",
          fromStatus: row.opportunityStatus,
          reason: "SAFETY_ESCALATION",
        },
        executor,
      });
    } catch {
      // Concurrent escalation: first writer wins; others converge by re-read.
    }
  }
}

// ─── Recompute (D3/D5) ───

function recomputeCandidateState(
  candidate: Awaited<ReturnType<typeof store.findCandidateByKey>> & object,
  evidence: Awaited<ReturnType<typeof store.listEvidenceForCandidate>>,
  nowMs: number,
  cfg: OpportunityDetectorConfig,
  previousStatusOverride: OpportunityStatus | null = null
) {
  const windowStart = nowMs - cfg.evidenceWindowMs;
  const inWindow = evidence.filter((e) => Date.parse(e.occurredAt) >= windowStart);
  const strengthInputs: StrengthEvidenceInput[] = inWindow.map((e) => ({
    kind: e.kind as StrengthEvidenceInput["kind"],
    opportunityTypeAtEvaluation: e.opportunityTypeAtEvaluation,
    intent: e.intent,
    overallConfidence: e.overallConfidence,
    relevance: e.relevance,
    sentiment: e.sentiment,
    urgency: e.urgency,
    contributesToStrength: e.contributesToStrength,
  }));
  const computation = computeEvidenceStrength(strengthInputs, candidate.opportunityType);
  const cap = recencyCap(Date.parse(candidate.lastObservedAt), nowMs, cfg.evidenceWindowMs);
  const confidenceClass = computeConfidenceClass(computation.evidenceStrength, cap);
  const status = statusForStrength(
    confidenceClass,
    previousStatusOverride ?? (candidate.opportunityStatus as never)
  );
  const latest = evidence.reduce((a, b) => (Date.parse(a.occurredAt) >= Date.parse(b.occurredAt) ? a : b));
  const first = evidence.reduce((a, b) => (Date.parse(a.occurredAt) <= Date.parse(b.occurredAt) ? a : b));
  const classifierVersions = Array.from(
    new Set(
      Array.isArray(candidate.classifierVersions) ? (candidate.classifierVersions as string[]) : []
    )
  );
  return {
    status,
    confidenceClass,
    evidenceStrength: computation.evidenceStrength,
    urgency: maxUrgency(strengthInputs),
    latestEvidence: {
      interpretationId: latest.interpretationId,
      signalId: latest.signalId,
      signalVersion: latest.signalVersion,
      occurredAt: latest.occurredAt,
    } satisfies EvidenceRef,
    firstObservedAt: first.occurredAt,
    lastObservedAt: latest.occurredAt,
    evidenceCount: evidence.length,
    contradictionCount: computation.contradictionCount,
    classifierVersions,
  };
}

function initialStrength(interpretation: CanonicalInterpretation): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" {
  // Single-evidence baseline: explicit + high/relevant → HIGH baseline is NOT
  // granted (repeat is required for HIGH); medium+ → MEDIUM; else LOW/UNKNOWN.
  if (interpretation.overallConfidence === "unknown") return "UNKNOWN";
  if (interpretation.overallConfidence === "low") return "LOW";
  if (interpretation.overallConfidence === "medium" || interpretation.overallConfidence === "high") {
    if (interpretation.relevance === "not_relevant") return "LOW";
    return interpretation.overallConfidence === "high" && interpretation.relevance === "relevant"
      ? "MEDIUM"
      : "LOW";
  }
  return "LOW";
}

function buildEvidenceRow(
  candidate: NonNullable<Awaited<ReturnType<typeof store.findCandidateByKey>>>,
  interpretation: CanonicalInterpretation,
  opportunityType: string,
  occurredAt: string,
  acceptedAt: Date
): import("@db/schema").InsertOpportunityEvidenceRow {
  const contributesToStrength = !isContradiction(
    {
      kind: "signal_interpretation",
      opportunityTypeAtEvaluation: opportunityType,
      intent: interpretation.intent,
      overallConfidence: interpretation.overallConfidence,
      relevance: interpretation.relevance,
      sentiment: interpretation.sentiment,
      urgency: interpretation.urgency,
      contributesToStrength: true,
    },
    opportunityType
  );
  const base = {
    candidateId: Number(candidate.id),
    userId: interpretation.userId,
    interpretationId: interpretation.interpretationId,
    signalId: interpretation.signalId,
    signalVersion: interpretation.signalVersion,
    kind: "signal_interpretation" as const,
    engagementReceiptId: null,
    opportunityTypeAtEvaluation: opportunityType as never,
    intent: interpretation.intent,
    overallConfidence: interpretation.overallConfidence,
    relevance: interpretation.relevance,
    sentiment: interpretation.sentiment,
    urgency: interpretation.urgency as never,
    sourceCampaignId: interpretation.sourceCampaignId,
    occurredAt,
    contributesToStrength,
  };
  return {
    ...base,
    evidenceHash: deriveEvidenceHash({
      candidateId: base.candidateId,
      interpretationId: base.interpretationId,
      signalId: base.signalId,
      signalVersion: base.signalVersion,
      kind: base.kind,
      engagementReceiptId: null,
      opportunityTypeAtEvaluation: opportunityType,
      intent: base.intent,
      overallConfidence: base.overallConfidence,
      relevance: base.relevance,
      sentiment: base.sentiment,
      urgency: base.urgency,
      sourceCampaignId: base.sourceCampaignId,
      occurredAt,
    }),
    createdAt: acceptedAt,
  };
}

// ─── Engagement evidence attach (D7) ───

export interface AttachEngagementEvidenceInput {
  opportunityId: string;
  receipt: unknown;
  userId: number;
  now?: Date;
  executor?: OpportunityStoreExecutor;
  config?: Partial<OpportunityDetectorConfig>;
}

export async function attachEngagementEvidence(
  input: AttachEngagementEvidenceInput
): Promise<{
  kind: "engagement_evidence_attached" | "idempotent_replay";
  opportunityId: string;
  evidenceStrength: string;
  confidenceClass: string;
  evidenceCount: number;
}> {
  const cfg = { ...DEFAULT_OPPORTUNITY_DETECTOR_CONFIG, ...input.config };
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const receipt = toValidatedEngagementReceipt(input.receipt);

  const candidate = await store.findCandidateByOpportunityId(input.userId, input.opportunityId, input.executor);
  if (!candidate) {
    throw new OpportunityInputError("CANDIDATE_NOT_FOUND", `opportunity ${input.opportunityId} not found for tenant.`);
  }
  if (candidate.businessId !== receipt.businessId) {
    throw new OpportunityInputError(
      "EVIDENCE_BINDING_MISMATCH",
      "receipt business scope does not match the candidate."
    );
  }

  // Binding: the receipt must reference an interpretation already on the
  // candidate (no free-floating enrichment).
  const candidateEvidence = await store.listEvidenceForCandidate(Number(candidate.id), input.executor);
  const bound = candidateEvidence.some((e) => e.interpretationId === receipt.sourceInterpretationId);
  if (!bound) {
    throw new OpportunityInputError(
      "EVIDENCE_BINDING_MISMATCH",
      "receipt does not bind to an interpretation evidenced on this candidate."
    );
  }

  // Replay guard on receipt identity.
  const existing = await store.findEvidenceByReceiptId(input.userId, receipt.engagementReceiptId, input.executor);
  if (existing) {
    return {
      kind: "idempotent_replay",
      opportunityId: candidate.opportunityId,
      evidenceStrength: candidate.evidenceStrength,
      confidenceClass: candidate.confidenceClass,
      evidenceCount: candidate.evidenceCount,
    };
  }

  const anchor = candidateEvidence.find((e) => e.interpretationId === receipt.sourceInterpretationId)!;
  const evidenceRow: import("@db/schema").InsertOpportunityEvidenceRow = {
    candidateId: Number(candidate.id),
    userId: input.userId,
    interpretationId: receipt.sourceInterpretationId,
    signalId: receipt.sourceSignalId,
    signalVersion: anchor.signalVersion,
    kind: "engagement_receipt",
    engagementReceiptId: receipt.engagementReceiptId,
    opportunityTypeAtEvaluation: candidate.opportunityType,
    intent: anchor.intent,
    overallConfidence: anchor.overallConfidence,
    relevance: anchor.relevance,
    sentiment: anchor.sentiment,
    urgency: anchor.urgency,
    sourceCampaignId: anchor.sourceCampaignId,
    occurredAt: receipt.occurredAt,
    contributesToStrength: true,
    evidenceHash: deriveEvidenceHash({
      candidateId: Number(candidate.id),
      interpretationId: receipt.sourceInterpretationId,
      signalId: receipt.sourceSignalId,
      signalVersion: anchor.signalVersion,
      kind: "engagement_receipt",
      engagementReceiptId: receipt.engagementReceiptId,
      opportunityTypeAtEvaluation: candidate.opportunityType,
      intent: anchor.intent,
      overallConfidence: anchor.overallConfidence,
      relevance: anchor.relevance,
      sentiment: anchor.sentiment,
      urgency: anchor.urgency,
      sourceCampaignId: anchor.sourceCampaignId,
      occurredAt: receipt.occurredAt,
    }),
    createdAt: now,
  };
  await store.insertEvidence(evidenceRow, input.executor);

  const allEvidence = await store.listEvidenceForCandidate(Number(candidate.id), input.executor);
  const recomputed = recomputeCandidateState(candidate, allEvidence, now.getTime(), cfg);
  const updated = await store.updateCandidateState(
    input.userId,
    Number(candidate.id),
    candidate.version,
    {
      opportunityStatus: recomputed.status as never,
      confidenceClass: recomputed.confidenceClass as never,
      evidenceStrength: recomputed.evidenceStrength as never,
      urgency: recomputed.urgency as never,
      latestEvidence: recomputed.latestEvidence,
      lastObservedAt: recomputed.lastObservedAt,
      evidenceCount: recomputed.evidenceCount,
      contradictionCount: recomputed.contradictionCount,
      statusChangedAt:
        recomputed.status !== candidate.opportunityStatus ? now : candidate.statusChangedAt,
      updatedAt: now,
    },
    input.executor
  );

  await emitOpportunityAudit({
    eventType: "opportunity_detected",
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: updated.campaignId ? Number(updated.campaignId) : null,
    occurredAt: nowIso,
    metadata: {
      opportunityId: updated.opportunityId,
      action: "engagement_evidence_attached",
      engagementReceiptId: receipt.engagementReceiptId,
      evidenceStrength: updated.evidenceStrength,
      evidenceCount: updated.evidenceCount,
    },
    executor: input.executor,
  });

  return {
    kind: "engagement_evidence_attached",
    opportunityId: updated.opportunityId,
    evidenceStrength: updated.evidenceStrength,
    confidenceClass: updated.confidenceClass,
    evidenceCount: updated.evidenceCount,
  };
}

// ─── Lifecycle operations (D8) ───

export interface LifecycleOpInput {
  opportunityId: string;
  userId: number;
  reason?: string;
  now?: Date;
  executor?: OpportunityStoreExecutor;
  config?: Partial<OpportunityDetectorConfig>;
}

export async function suppressCandidate(input: LifecycleOpInput & { reason: string }) {
  return transitionCandidate(input, "suppress", "suppressed", { reason: input.reason });
}

export async function unsuppressCandidate(input: LifecycleOpInput) {
  return transitionCandidate(input, "unsuppress", "weak", {});
}

export async function escalateCandidate(input: LifecycleOpInput) {
  return transitionCandidate(input, "escalate", "escalated", {});
}

async function transitionCandidate(
  input: LifecycleOpInput,
  transition: LifecycleTransition,
  target: "suppressed" | "weak" | "escalated",
  extra: Record<string, unknown>
) {
  const now = input.now ?? new Date();
  const candidate = await store.findCandidateByOpportunityId(input.userId, input.opportunityId, input.executor);
  if (!candidate) {
    throw new OpportunityInputError("CANDIDATE_NOT_FOUND", `opportunity ${input.opportunityId} not found for tenant.`);
  }
  if (!canTransition(transition, candidate.opportunityStatus as never)) {
    throw new OpportunityStateConflictError(
      "ILLEGAL_TRANSITION",
      `cannot ${transition} from status ${candidate.opportunityStatus}.`
    );
  }
  const updated = await store.updateCandidateState(
    input.userId,
    Number(candidate.id),
    candidate.version,
    {
      opportunityStatus: target as never,
      statusChangedAt: now,
      updatedAt: now,
    },
    input.executor
  );
  await emitOpportunityAudit({
    eventType: "opportunity_state_changed",
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: updated.campaignId ? Number(updated.campaignId) : null,
    occurredAt: now.toISOString(),
    metadata: {
      opportunityId: updated.opportunityId,
      action: target,
      fromStatus: candidate.opportunityStatus,
      ...extra,
    },
    executor: input.executor,
  });
  return updated;
}

// ─── Expiry sweep (D8) ───

export async function sweepExpiredOpportunities(input: {
  now?: Date;
  executor?: OpportunityStoreExecutor;
  config?: Partial<OpportunityDetectorConfig>;
}): Promise<{ expired: number }> {
  const cfg = { ...DEFAULT_OPPORTUNITY_DETECTOR_CONFIG, ...input.config };
  const now = input.now ?? new Date();
  const expiryIso = new Date(now.getTime() - cfg.evidenceWindowMs).toISOString();
  const rows = await store.listActiveCandidatesPastExpiry(expiryIso, input.executor);
  let expired = 0;
  for (const row of rows) {
    try {
      const updated = await store.updateCandidateState(
        Number(row.userId),
        Number(row.id),
        row.version,
        {
          opportunityStatus: "expired" as never,
          statusChangedAt: now,
          updatedAt: now,
        },
        input.executor
      );
      expired += 1;
      await emitOpportunityAudit({
        eventType: "opportunity_state_changed",
        userId: Number(row.userId),
        businessId: updated.businessId ? Number(updated.businessId) : null,
        campaignId: updated.campaignId ? Number(updated.campaignId) : null,
        occurredAt: now.toISOString(),
        metadata: {
          opportunityId: updated.opportunityId,
          action: "expired",
          fromStatus: row.opportunityStatus,
          evidenceWindowMs: cfg.evidenceWindowMs,
        },
        executor: input.executor,
      });
    } catch {
      // Concurrent sweep: first writer wins.
    }
  }
  return { expired };
}

// ─── R6 handoff (D8, exactly-once) ───

export async function handoffToR6(input: LifecycleOpInput): Promise<{
  handoffId: string;
  opportunityId: string;
  duplicateClassification: "none" | "idempotent_replay";
  envelope: OpportunityHandoffEnvelope;
}> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = await store.findHandoff(input.userId, input.opportunityId, input.executor);
  if (existing) {
    return {
      handoffId: existing.handoffId,
      opportunityId: existing.opportunityId,
      duplicateClassification: "idempotent_replay",
      envelope: existing.envelope as unknown as OpportunityHandoffEnvelope,
    };
  }

  const candidate = await store.findCandidateByOpportunityId(input.userId, input.opportunityId, input.executor);
  if (!candidate) {
    throw new OpportunityInputError("CANDIDATE_NOT_FOUND", `opportunity ${input.opportunityId} not found for tenant.`);
  }
  if (!canTransition("handoff", candidate.opportunityStatus as never)) {
    throw new OpportunityStateConflictError(
      "ILLEGAL_TRANSITION",
      `cannot hand off from status ${candidate.opportunityStatus}.`
    );
  }

  const evidence = await store.listEvidenceForCandidate(Number(candidate.id), input.executor);
  const manifest: EvidenceRef[] = evidence.map((e) => ({
    interpretationId: e.interpretationId,
    signalId: e.signalId,
    signalVersion: e.signalVersion,
    occurredAt: e.occurredAt,
  }));
  const evidenceSnapshotHash = sha256Hex(canonicalJson(manifest));
  const envelopePreId = {
    handoffEnvelopeVersion: HANDOFF_ENVELOPE_VERSION,
    opportunityId: candidate.opportunityId,
    opportunityKey: candidate.opportunityKey,
    userId: Number(candidate.userId),
    businessId: candidate.businessId ? Number(candidate.businessId) : null,
    opportunityType: candidate.opportunityType,
    opportunityStatusAtHandoff: candidate.opportunityStatus,
    confidenceClass: candidate.confidenceClass,
    evidenceStrength: candidate.evidenceStrength,
    urgency: candidate.urgency,
    topic: candidate.topic,
    topicKey: candidate.topicKey,
    actorKey: candidate.actorKey,
    threadKey: candidate.threadKey,
    campaignId: candidate.campaignId ? Number(candidate.campaignId) : null,
    publicationId: candidate.publicationId,
    provider: candidate.provider,
    externalActorReference: null,
    evidenceCount: evidence.length,
    contradictionCount: candidate.contradictionCount,
    firstObservedAt: candidate.firstObservedAt,
    lastObservedAt: candidate.lastObservedAt,
    detectorRulesVersion: candidate.detectorRulesVersion as typeof DETECTOR_RULES_VERSION,
    classifierVersions: Array.isArray(candidate.classifierVersions)
      ? (candidate.classifierVersions as string[])
      : [],
    evidence: manifest,
    evidenceSnapshotHash,
    handedOffAt: nowIso,
  } satisfies Omit<OpportunityHandoffEnvelope, "handoffId">;
  const handoffId = `${HANDOFF_ID_PREFIX}${sha256Hex(canonicalJson(envelopePreId))}`;

  // Exactly-once: insert the durable envelope first (unique opportunityId);
  // a raced duplicate re-reads and replays.
  const insertResult = await store.insertHandoff(
    {
      handoffId,
      opportunityId: candidate.opportunityId,
      userId: Number(candidate.userId),
      businessId: candidate.businessId ? Number(candidate.businessId) : null,
      envelope: { ...envelopePreId, handoffId } as unknown as import("@db/schema").InsertOpportunityHandoffRow["envelope"],
      evidenceSnapshotHash,
      handedOffAt: now,
      createdAt: now,
    },
    input.executor
  );
  const envelope = insertResult.row.envelope as unknown as OpportunityHandoffEnvelope;

  if (insertResult.inserted) {
    // CAS the candidate to handed_off_to_r6; envelope durability is the
    // exactly-once anchor, so a failed CAS here is retried by replay sweeps
    // but can never duplicate the handoff itself.
    try {
      await store.updateCandidateState(
        input.userId,
        Number(candidate.id),
        candidate.version,
        {
          opportunityStatus: "handed_off_to_r6" as never,
          handedOffAt: now,
          statusChangedAt: now,
          updatedAt: now,
        },
        input.executor
      );
    } catch {
      // Concurrent lifecycle change: envelope is durable; state converges on
      // the next read. Never duplicate the handoff.
    }
    await emitOpportunityAudit({
      eventType: "opportunity_handed_off",
      userId: input.userId,
      businessId: candidate.businessId ? Number(candidate.businessId) : null,
      campaignId: candidate.campaignId ? Number(candidate.campaignId) : null,
      occurredAt: nowIso,
      metadata: {
        handoffId,
        opportunityId: candidate.opportunityId,
        opportunityType: candidate.opportunityType,
        confidenceClass: candidate.confidenceClass,
        evidenceCount: evidence.length,
        evidenceSnapshotHash,
      },
      executor: input.executor,
    });
  }

  return {
    handoffId,
    opportunityId: candidate.opportunityId,
    duplicateClassification: insertResult.duplicateClassification,
    envelope,
  };
}

// ─── Read models ───

export async function listOpportunities(
  userId: number,
  filters: { status?: string; opportunityType?: string } = {},
  executor?: OpportunityStoreExecutor
) {
  return store.listCandidates(userId, filters, executor);
}

export async function getOpportunity(userId: number, opportunityId: string, executor?: OpportunityStoreExecutor) {
  return store.findCandidateByOpportunityId(userId, opportunityId, executor);
}

export async function listOpportunityHandoffs(userId: number, executor?: OpportunityStoreExecutor) {
  return store.listHandoffs(userId, executor);
}
