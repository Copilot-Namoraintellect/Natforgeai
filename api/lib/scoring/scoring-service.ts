// ─── R6-B Lead Scoring — orchestration service ───
//
// Canonical lead identity (R6-A seam) → authoritative R5 evidence snapshot →
// feature extraction → deterministic scoring → confidence + reason codes →
// immutable score record (exact-once) → downstream-safe read-only projection.
//
// This service never qualifies leads, never writes leads/CRM/outreach rows,
// never initiates governed marketing actions, and is non-billable (no model,
// no reservations, no ai_usage). Emits exactly one canonical audit event per
// durable score record.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import { listEvidenceForCandidate } from "../opportunity/opportunity-store";
import type { OpportunityCandidateRow, OpportunityEvidenceRow } from "@db/schema";
import {
  LEAD_SCORING_CONTRACT_VERSION,
  SCORING_VERSION,
  FEATURE_VERSION,
  SCORING_WEIGHTS,
  ScoringInputError,
  type ComponentKey,
  type ScoreBand,
  type ScoringDuplicateClassification,
} from "./scoring-contract";
import {
  buildFeatureVector,
  type CandidateFeatureInput,
  type EvidenceFeatureInput,
} from "./feature-model";
import { computeScore, type ScoreComputation } from "./scoring-engine";
import {
  resolveLeadIdentity,
  listEvidenceScopeCandidates,
  type LeadIdentityRef,
  type ScoringExecutor,
} from "./lead-identity-seam";
import { buildEvidenceSnapshot, deriveLeadScoreId, type EvidenceSnapshot } from "./evidence-snapshot";
import * as scoringStore from "./scoring-store";
import type { LeadScoreSnapshotRow } from "@db/schema";

export interface ScoreLeadInput {
  /** Authenticated tenant user (ctx.user.id) — the only identity authority. */
  userId: number;
  leadId: number;
  /** Explicit scoring clock; defaults to boundary read. */
  now?: Date;
  /** Structural executor seam (tests / transactions). */
  executor?: ScoringExecutor;
}

/** Read-only downstream projection (B8) — the ONLY surface R6-C may consume. */
export interface LeadScoreProjection {
  leadScoreId: string;
  evidenceSnapshotId: string;
  scoreContractVersion: typeof LEAD_SCORING_CONTRACT_VERSION;
  userId: number;
  businessId: number | null;
  leadId: number;
  leadIdentityVersion: string;
  scoringVersion: string;
  featureVersion: string;
  evidenceSnapshotHash: string;
  overallScore: number;
  scoreBand: ScoreBand;
  scoreConfidence: ScoreComputation["confidence"];
  fitScore: number;
  intentScore: number;
  engagementScore: number;
  recencyScore: number;
  opportunityScore: number;
  componentWeights: Record<ComponentKey, number>;
  reasonCodes: string[];
  evidenceFreshness: { latestObservedAt: string | null; computedAt: string };
  computedAt: string;
  createdAt: string;
  duplicateClassification: ScoringDuplicateClassification;
}

export interface ScoreLeadResult {
  score: LeadScoreProjection;
  duplicateClassification: ScoringDuplicateClassification;
}

async function emitScoringAudit(input: {
  userId: number;
  businessId: number | null;
  campaignId: number | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
  executor?: ScoringExecutor;
}): Promise<void> {
  const event = createAuditEvent({
    eventType: "lead_score_recorded",
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: input.campaignId,
    businessId: input.businessId,
    metadata: input.metadata,
  });
  await persistAuditEvent(event, input.executor as never);
}

function toProjection(
  row: LeadScoreSnapshotRow,
  duplicateClassification: ScoringDuplicateClassification
): LeadScoreProjection {
  const manifest = Array.isArray(row.evidenceManifest)
    ? (row.evidenceManifest as { occurredAt?: string }[])
    : [];
  const latestObservedAt = manifest.reduce<string | null>((max, entry) => {
    const at = entry?.occurredAt;
    if (typeof at !== "string") return max;
    return max === null || at > max ? at : max;
  }, null);
  return {
    leadScoreId: row.leadScoreId,
    evidenceSnapshotId: row.evidenceSnapshotId,
    scoreContractVersion: row.scoreContractVersion as typeof LEAD_SCORING_CONTRACT_VERSION,
    userId: Number(row.userId),
    businessId: row.businessId === null ? null : Number(row.businessId),
    leadId: Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion,
    scoringVersion: row.scoringVersion,
    featureVersion: row.featureVersion,
    evidenceSnapshotHash: row.evidenceSnapshotHash,
    overallScore: Number(row.overallScore),
    scoreBand: row.scoreBand as ScoreBand,
    scoreConfidence: row.scoreConfidence as LeadScoreProjection["scoreConfidence"],
    fitScore: Number(row.fitScore),
    intentScore: Number(row.intentScore),
    engagementScore: Number(row.engagementScore),
    recencyScore: Number(row.recencyScore),
    opportunityScore: Number(row.opportunityScore),
    componentWeights: row.componentWeights as Record<ComponentKey, number>,
    reasonCodes: Array.isArray(row.reasonCodes) ? (row.reasonCodes as string[]) : [],
    evidenceFreshness: {
      latestObservedAt,
      computedAt: row.computedAt instanceof Date ? row.computedAt.toISOString() : String(row.computedAt),
    },
    computedAt: row.computedAt instanceof Date ? row.computedAt.toISOString() : String(row.computedAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    duplicateClassification,
  };
}

interface GatheredEvidence {
  candidates: OpportunityCandidateRow[];
  evidenceRows: OpportunityEvidenceRow[];
  candidateInputs: CandidateFeatureInput[];
  evidenceInputs: EvidenceFeatureInput[];
  snapshot: EvidenceSnapshot;
}

async function gatherEvidence(identity: LeadIdentityRef, executor?: ScoringExecutor): Promise<GatheredEvidence> {
  const candidates = await listEvidenceScopeCandidates(identity, executor);
  const evidenceRows: OpportunityEvidenceRow[] = [];
  const opportunityIdByCandidateId = new Map<number, string>();
  for (const candidate of candidates) {
    opportunityIdByCandidateId.set(Number(candidate.id), candidate.opportunityId);
    const rows = await listEvidenceForCandidate(Number(candidate.id), executor as never);
    evidenceRows.push(...rows);
  }

  const candidateInputs: CandidateFeatureInput[] = candidates.map((c) => ({
    opportunityId: c.opportunityId,
    opportunityType: c.opportunityType,
    evidenceStrength: c.evidenceStrength,
    campaignId: c.campaignId === null ? null : Number(c.campaignId),
    contradictionCount: Number(c.contradictionCount),
  }));
  const evidenceInputs: EvidenceFeatureInput[] = evidenceRows.map((e) => ({
    interpretationId: e.interpretationId,
    kind: e.kind,
    contributesToStrength: Boolean(e.contributesToStrength),
    opportunityTypeAtEvaluation: e.opportunityTypeAtEvaluation,
    overallConfidence: e.overallConfidence,
    relevance: e.relevance,
    occurredAt: e.occurredAt,
  }));

  const snapshot = buildEvidenceSnapshot(identity, evidenceRows, opportunityIdByCandidateId);
  return { candidates, evidenceRows, candidateInputs, evidenceInputs, snapshot };
}

/**
 * Score one canonical lead. Deterministic: same lead + same evidence snapshot
 * + same scoring version → same score identity; replays converge to the one
 * durable row. New evidence or a version bump mints a new immutable record.
 */
export async function scoreLead(input: ScoreLeadInput): Promise<ScoreLeadResult> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new ScoringInputError("INVALID_SCORING_CLOCK", "scoring clock must be a finite timestamp.");
  }
  const nowIso = now.toISOString();

  // 1. Authoritative identity (R6-A seam) — forged/cross-tenant fails closed.
  const identity = await resolveLeadIdentity(input.userId, input.leadId, input.executor);

  // 2. Authoritative evidence snapshot (R5 evidence, hash-verified on read).
  const gathered = await gatherEvidence(identity, input.executor);

  // 3. Feature extraction (validated, provenance-carrying, forbidden features rejected).
  const vector = buildFeatureVector({
    candidates: gathered.candidateInputs,
    evidence: gathered.evidenceInputs,
    lead: { leadCampaignId: identity.campaignId },
  });

  // 4. Deterministic bounded score.
  const computation = computeScore(vector, { now, weights: SCORING_WEIGHTS });

  // 5. Deterministic identities.
  const leadScoreId = deriveLeadScoreId({
    userId: identity.userId,
    leadId: identity.leadId,
    leadIdentityVersion: identity.identityVersion,
    evidenceSnapshotHash: gathered.snapshot.snapshotHash,
    scoringVersion: SCORING_VERSION,
  });

  // 6. Exact-once persistence under the durable convergence unique key.
  const insertResult = await scoringStore.insertScore(
    {
      leadScoreId,
      evidenceSnapshotId: gathered.snapshot.snapshotId,
      scoreContractVersion: LEAD_SCORING_CONTRACT_VERSION,
      userId: identity.userId,
      businessId: identity.businessId,
      leadId: identity.leadId,
      leadIdentityVersion: identity.identityVersion,
      scoringVersion: SCORING_VERSION,
      featureVersion: FEATURE_VERSION,
      evidenceSnapshotHash: gathered.snapshot.snapshotHash,
      evidenceManifest: gathered.snapshot.manifest as unknown as import("@db/schema").InsertLeadScoreSnapshotRow["evidenceManifest"],
      overallScore: computation.overallScore,
      scoreBand: computation.scoreBand,
      scoreConfidence: computation.confidence,
      fitScore: computation.components.fit,
      intentScore: computation.components.intent,
      engagementScore: computation.components.engagement,
      recencyScore: computation.components.recency,
      opportunityScore: computation.components.opportunity,
      componentWeights: { ...SCORING_WEIGHTS },
      reasonCodes: [...computation.reasonCodes],
      computedAt: now,
      createdAt: now,
    },
    input.executor
  );

  // 7. One canonical audit event per durable score record only.
  if (insertResult.inserted) {
    await emitScoringAudit({
      userId: identity.userId,
      businessId: identity.businessId,
      campaignId: identity.campaignId,
      occurredAt: nowIso,
      metadata: {
        leadScoreId,
        leadId: identity.leadId,
        scoringVersion: SCORING_VERSION,
        overallScore: computation.overallScore,
        scoreBand: computation.scoreBand,
        scoreConfidence: computation.confidence,
        evidenceSnapshotHash: gathered.snapshot.snapshotHash,
        evidenceCount: gathered.evidenceRows.length,
      },
      executor: input.executor,
    });
  }

  return {
    score: toProjection(insertResult.row, insertResult.duplicateClassification),
    duplicateClassification: insertResult.duplicateClassification,
  };
}

/** Read one immutable score record (integrity-verified). */
export async function getScore(
  userId: number,
  leadScoreId: string,
  executor?: ScoringExecutor
): Promise<LeadScoreProjection> {
  const row = await scoringStore.findScoreByLeadScoreId(userId, leadScoreId, executor);
  if (!row) {
    throw new ScoringInputError("SCORE_NOT_FOUND", `lead score ${leadScoreId} not found for tenant.`);
  }
  return toProjection(row, "none");
}

/** Immutable score history for a lead, oldest first (integrity-verified). */
export async function listScoreHistory(
  userId: number,
  leadId: number,
  executor?: ScoringExecutor
): Promise<LeadScoreProjection[]> {
  const rows = await scoringStore.listScoresForLead(userId, leadId, executor);
  return rows.map((row) => toProjection(row, "none"));
}
