// ─── R6-C Lead Qualification — service authority (contract §8–§13) ───
//
// Orchestrates one governed evaluation end to end: fetch untrusted upstream
// evidence through the provider seam, re-validate it at the C boundary,
// assemble the deterministic evidence snapshot, decide with the pure
// rule-first engine, persist exactly once under the durable convergence
// anchor, and emit exactly one audit event per inserted decision. Replays
// re-read and re-verify every binding before converging. The caller supplies
// the executor: one client/transaction spans the decision insert, the review
// insert, and the audit persistence (contract §11, §14.12).

import {
  canonicalJson,
  deriveQualificationId,
  LEAD_QUALIFICATION_CONTRACT_VERSION,
  QualificationInputError,
  QualificationOwnershipError,
  QualificationStateConflictError,
  QualificationTamperError,
  QualificationValidationError,
  QUALIFICATION_ENGINE_VERSION,
  type NormalizedIdentityEvidence,
  type QualificationDuplicateClassification,
} from "./qualification-contract";
import { getQualificationPolicy } from "./qualification-policy";
import { buildEvidenceSnapshot } from "./qualification-evidence";
import { evaluateQualification } from "./qualification-engine";
import { validateIdentityProjection } from "./qualification-identity-seam";
import { validateScorePayload } from "./qualification-scoring-seam";
import { resolvePrivacyGate } from "./qualification-governance-seam";
import {
  getLatestQualification,
  getQualification,
  getReview,
  getReviewByQualification,
  insertQualification,
  insertReview,
  listQualificationHistory,
  listReviews,
  updateReviewResolution,
  type LeadQualificationRow,
  type LeadQualificationReviewRow,
  type QualificationStoreExecutor,
} from "./qualification-store";
import {
  assertReviewDecisionBinding,
  assertReviewResolvable,
  buildReviewForDecision,
} from "./qualification-review";
import {
  buildHandoffProjection,
  type QualificationHandoffProjection,
} from "./qualification-handoff";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

// ─── Provider seam (untrusted upstream authority; bridge lands later) ───

/**
 * Raw upstream authority. Every payload arrives as `unknown` — the C seams
 * re-validate before anything consumes it. Implementations throw
 * ProviderLeadNotFound / ProviderScoreNotFound for absent records so
 * cross-tenant/forged references fail closed and indistinguishable
 * (LEAD_NOT_FOUND / SCORE_NOT_FOUND).
 */
export interface QualificationAuthorityProvider {
  getIdentityProjection(leadId: string): Promise<unknown>;
  getScorePayload(leadScoreId: string): Promise<unknown>;
  getPrivacyState(leadId: string): Promise<unknown>;
}

export class ProviderLeadNotFound extends Error {
  readonly kind = "lead_not_found" as const;
  constructor(leadId: string) {
    super(`lead not found: ${leadId}`);
    this.name = "ProviderLeadNotFound";
  }
}

export class ProviderScoreNotFound extends Error {
  readonly kind = "score_not_found" as const;
  constructor(leadScoreId: string) {
    super(`lead score not found: ${leadScoreId}`);
    this.name = "ProviderScoreNotFound";
  }
}

export interface QualificationAuthorityDeps {
  readonly provider: QualificationAuthorityProvider;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

const MAX_IDENTITY_MERGE_HOPS = 5;

function resolveNow(deps: QualificationAuthorityDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function deepFreeze<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") {
        deepFreeze(nested);
      }
    }
  }
  return value;
}

async function fetchIdentity(
  deps: QualificationAuthorityDeps,
  leadId: string
): Promise<NormalizedIdentityEvidence> {
  let raw: unknown;
  try {
    raw = await deps.provider.getIdentityProjection(leadId);
  } catch (err) {
    if (err instanceof ProviderLeadNotFound) {
      throw new QualificationInputError("LEAD_NOT_FOUND", `lead ${leadId} not found`);
    }
    throw err;
  }
  return validateIdentityProjection(raw);
}

/**
 * The qualification executor spans R6-C tables and the audit ledger. The
 * audit seam's Drizzle-typed signature is structurally identical
 * (select/insert chains); the R6-X bridge binds both to one client/tx — until
 * then this cast is opaque and the in-memory fake implements both dialects.
 */
function asAuditExecutor(executor: QualificationStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

export interface EvaluateQualificationForLeadInput {
  readonly userId: number;
  readonly leadId: string;
  readonly leadScoreId: string;
  readonly businessId?: number;
  readonly policyVersion?: string;
}

export interface EvaluateQualificationForLeadResult {
  readonly qualification: LeadQualificationRow;
  readonly duplicateClassification: QualificationDuplicateClassification;
}

/**
 * One governed evaluation (contract §8–§12). Every upstream payload is
 * untrusted until its seam accepts it; every binding is recomputed, never
 * taken from the wire. Same authoritative inputs ⇒ same qualificationId ⇒
 * durable convergence (replay re-reads and re-verifies the stored row).
 */
export async function evaluateQualificationForLead(
  input: EvaluateQualificationForLeadInput,
  deps: QualificationAuthorityDeps,
  executor: QualificationStoreExecutor
): Promise<EvaluateQualificationForLeadResult> {
  const now = resolveNow(deps);

  // (1) Policy — unknown versions fail closed (UNKNOWN_POLICY_VERSION).
  const policy = getQualificationPolicy(input.policyVersion);

  // (2) Identity — re-validated; merged chains resolve to the canonical lead
  //     (max 5 hops; a broken chain or missing canonical fails closed).
  let identity = await fetchIdentity(deps, input.leadId);
  let mergeHops = 0;
  while (identity.identityStatus === "merged") {
    if (identity.canonicalLeadId === null || mergeHops >= MAX_IDENTITY_MERGE_HOPS) {
      throw new QualificationValidationError(
        "IDENTITY_MERGE_CHAIN_BROKEN",
        `identity ${identity.leadId} is merged but its canonical chain is broken or exceeds ${MAX_IDENTITY_MERGE_HOPS} hops`
      );
    }
    mergeHops += 1;
    identity = await fetchIdentity(deps, identity.canonicalLeadId);
  }

  // (3) Business scope — server-side ownership assertion.
  if (input.businessId !== undefined && identity.businessId !== input.businessId) {
    throw new QualificationOwnershipError(
      "OWNERSHIP_MISMATCH",
      `identity is scoped to business ${identity.businessId}, not ${input.businessId}`
    );
  }

  // (4) Identity freshness.
  if (now.getTime() - Date.parse(identity.lastObservedAt) > policy.staleIdentityMs) {
    throw new QualificationInputError(
      "STALE_IDENTITY",
      `identity last observed at ${identity.lastObservedAt} is older than the policy staleness window`
    );
  }

  // (5) Score — re-validated, then cross-bound to this identity and tenant.
  let rawScore: unknown;
  try {
    rawScore = await deps.provider.getScorePayload(input.leadScoreId);
  } catch (err) {
    if (err instanceof ProviderScoreNotFound) {
      throw new QualificationInputError("SCORE_NOT_FOUND", `score ${input.leadScoreId} not found`);
    }
    throw err;
  }
  const score = validateScorePayload(rawScore);
  if (score.userId !== input.userId) {
    // Cross-tenant scores are indistinguishable from absent ones.
    throw new QualificationInputError("SCORE_NOT_FOUND", `score ${input.leadScoreId} not found`);
  }
  if (score.leadId !== identity.leadId) {
    throw new QualificationTamperError(
      "SCORE_TAMPERED",
      `score is bound to lead ${score.leadId}, not ${identity.leadId}`
    );
  }
  if (score.leadIdentityVersion !== identity.leadIdentityVersion) {
    throw new QualificationTamperError(
      "SCORE_TAMPERED",
      `score identity version ${score.leadIdentityVersion} disagrees with identity ${identity.leadIdentityVersion}`
    );
  }
  if (
    score.businessId !== null &&
    identity.businessId !== null &&
    score.businessId !== identity.businessId
  ) {
    throw new QualificationTamperError(
      "SCORE_TAMPERED",
      `score business scope ${score.businessId} disagrees with identity business scope ${identity.businessId}`
    );
  }

  // (6) Score freshness — evidence age is measured from latest observation.
  if (score.latestObservedAt === null) {
    throw new QualificationInputError("STALE_SCORE", "score carries no observed evidence freshness");
  }
  if (now.getTime() - Date.parse(score.latestObservedAt) > policy.maximumEvidenceAgeMs) {
    throw new QualificationInputError(
      "STALE_SCORE",
      `score evidence last observed at ${score.latestObservedAt} is older than the policy evidence-age window`
    );
  }

  // (7) Privacy gate — governed state only; an absent row degrades to ACTIVE.
  const privacy = resolvePrivacyGate(await deps.provider.getPrivacyState(identity.leadId));

  // (8)+(9) Deterministic snapshot + rule-first decision. No model in the path.
  const { snapshot, snapshotHash, entries } = buildEvidenceSnapshot({
    identity,
    score,
    policy,
    privacy,
    now,
  });
  const evaluation = evaluateQualification({ identity, score, policy, entries, privacy, now });

  // (10) The immutable decision row, deep-frozen before it touches the store.
  const evaluatedAt = now.toISOString();
  const row: LeadQualificationRow = deepFreeze({
    qualificationId: deriveQualificationId({
      contractVersion: LEAD_QUALIFICATION_CONTRACT_VERSION,
      userId: input.userId,
      businessId: identity.businessId,
      leadId: identity.leadId,
      leadIdentityVersion: identity.leadIdentityVersion,
      identityReference: identity.identityReference,
      leadScoreId: score.leadScoreId,
      scoringVersion: score.scoringVersion,
      scoreContentHash: score.scoreContentHash,
      qualificationPolicyVersion: policy.policyVersion,
      evidenceSnapshotHash: snapshotHash,
      engineVersion: QUALIFICATION_ENGINE_VERSION,
    }),
    contractVersion: LEAD_QUALIFICATION_CONTRACT_VERSION,
    engineVersion: QUALIFICATION_ENGINE_VERSION,
    userId: input.userId,
    businessId: identity.businessId,
    leadId: identity.leadId,
    leadIdentityVersion: identity.leadIdentityVersion,
    identityReference: identity.identityReference,
    leadScoreId: score.leadScoreId,
    scoringVersion: score.scoringVersion,
    scoreContentHash: score.scoreContentHash,
    qualificationPolicyVersion: policy.policyVersion,
    evidenceSnapshotHash: snapshotHash,
    evidenceSnapshot: snapshot,
    decision: evaluation.decision,
    reasonCodes: [...evaluation.reasonCodes],
    confidenceScore: evaluation.confidenceScore,
    reviewRequired: evaluation.reviewRequired,
    evaluatedAt,
    validUntil: new Date(now.getTime() + policy.validityMs).toISOString(),
    createdAt: evaluatedAt,
  });

  // (11) Durable convergence + exactly-once side effects.
  const inserted = await insertQualification(row, executor);
  if (inserted.inserted) {
    if (row.decision === "REVIEW_REQUIRED") {
      // Duplicate review inserts converge by their own durable anchors; the
      // outcome is intentionally ignored here (exactly one review per decision).
      await insertReview(buildReviewForDecision(row), executor);
    }
    const event = createAuditEvent({
      eventType: "lead_qualification_evaluated",
      source: "system",
      outcome: "succeeded",
      occurredAt: evaluatedAt,
      userId: input.userId,
      businessId: identity.businessId,
      metadata: {
        qualificationId: row.qualificationId,
        leadId: row.leadId,
        businessId: row.businessId,
        decision: row.decision,
        reasonCodes: [...(row.reasonCodes as string[])],
        confidenceScore: row.confidenceScore,
        qualificationPolicyVersion: row.qualificationPolicyVersion,
        engineVersion: row.engineVersion,
        leadScoreId: row.leadScoreId,
        scoringVersion: row.scoringVersion,
        evidenceSnapshotHash: row.evidenceSnapshotHash,
        identityReference: row.identityReference,
        scoreContentHash: row.scoreContentHash,
        reviewRequired: row.reviewRequired,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
    return { qualification: row, duplicateClassification: "none" };
  }

  // (12) Replay: re-read the durable row and verify every binding field plus
  // decision, reason codes, confidence and evaluated time against the
  // recomputed decision. Drift is tampering (QUALIFICATION_REPLAY_CONFLICT).
  const stored = await getQualification(input.userId, row.qualificationId, executor);
  assertReplayConverges(stored, row);
  return { qualification: stored, duplicateClassification: "idempotent_replay" };
}

/** Normalizes a JSON column that may arrive pre-parsed or as a JSON string. */
function jsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function replayBindingView(row: LeadQualificationRow): Record<string, unknown> {
  return {
    contractVersion: row.contractVersion,
    engineVersion: row.engineVersion,
    userId: row.userId,
    businessId: row.businessId,
    leadId: row.leadId,
    leadIdentityVersion: row.leadIdentityVersion,
    identityReference: row.identityReference,
    leadScoreId: row.leadScoreId,
    scoringVersion: row.scoringVersion,
    scoreContentHash: row.scoreContentHash,
    qualificationPolicyVersion: row.qualificationPolicyVersion,
    evidenceSnapshotHash: row.evidenceSnapshotHash,
    decision: row.decision,
    reasonCodes: jsonColumn(row.reasonCodes),
    confidenceScore: row.confidenceScore,
    evaluatedAt: row.evaluatedAt,
  };
}

function assertReplayConverges(stored: LeadQualificationRow, computed: LeadQualificationRow): void {
  if (canonicalJson(replayBindingView(stored)) !== canonicalJson(replayBindingView(computed))) {
    throw new QualificationTamperError(
      "QUALIFICATION_REPLAY_CONFLICT",
      `stored qualification ${stored.qualificationId} does not match the recomputed decision bindings; refusing to serve divergent durable state.`
    );
  }
}

// ─── Read surfaces ───

export async function getQualificationForUser(
  input: { userId: number; qualificationId: string },
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow> {
  return getQualification(input.userId, input.qualificationId, executor);
}

export async function getQualificationHistory(
  input: { userId: number; leadId: string },
  executor: QualificationStoreExecutor
): Promise<LeadQualificationRow[]> {
  return listQualificationHistory(input.userId, input.leadId, executor);
}

export async function listQualificationReviews(
  input: { userId: number; leadId?: string; status?: string },
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow[]> {
  return listReviews(input.userId, { leadId: input.leadId, status: input.status }, executor);
}

// ─── Handoff projection (contract §13) ───

export async function getHandoffProjectionForUser(
  input: { userId: number; qualificationId: string },
  deps: QualificationAuthorityDeps,
  executor: QualificationStoreExecutor
): Promise<QualificationHandoffProjection> {
  const q = await getQualification(input.userId, input.qualificationId, executor);
  const latest = await getLatestQualification(input.userId, q.leadId, executor);
  const review = await getReviewByQualification(input.userId, q.qualificationId, executor);
  const privacy = resolvePrivacyGate(await deps.provider.getPrivacyState(q.leadId));
  return buildHandoffProjection(
    q,
    review,
    privacy,
    latest?.qualificationId === input.qualificationId,
    resolveNow(deps)
  );
}

// ─── Governed review resolution (contract §10) ───

export interface ResolveQualificationReviewInput {
  readonly userId: number;
  readonly reviewId: string;
  readonly outcome: string;
  readonly reason: string;
}

export async function resolveQualificationReview(
  input: ResolveQualificationReviewInput,
  deps: QualificationAuthorityDeps,
  executor: QualificationStoreExecutor
): Promise<LeadQualificationReviewRow> {
  if (input.outcome !== "progress_authorized" && input.outcome !== "progression_rejected") {
    throw new QualificationValidationError(
      "INVALID_DECISION",
      `unknown review outcome: ${String(input.outcome)}`
    );
  }
  if (typeof input.reason !== "string" || input.reason.length === 0 || input.reason.length > 500) {
    throw new QualificationValidationError(
      "INVALID_REASON_CODE",
      "resolution reason must be a non-empty string of at most 500 chars"
    );
  }

  const review = await getReview(input.userId, input.reviewId, executor);
  assertReviewResolvable(review);

  // The bound qualification must still exist for this tenant.
  let q: LeadQualificationRow;
  try {
    q = await getQualification(input.userId, review.qualificationId, executor);
  } catch (err) {
    if (err instanceof QualificationInputError && err.code === "QUALIFICATION_NOT_FOUND") {
      throw new QualificationStateConflictError(
        "REVIEW_STALE_BINDING",
        `bound qualification ${review.qualificationId} no longer exists; review is stale`
      );
    }
    throw err;
  }
  assertReviewDecisionBinding(review, q);

  const now = resolveNow(deps);
  const resolvedAt = now.toISOString();
  const updated = await updateReviewResolution(
    input.userId,
    input.reviewId,
    review.version,
    {
      status: input.outcome,
      resolvedBy: input.userId,
      resolvedAt,
      resolutionReason: input.reason,
    },
    executor
  );

  const event = createAuditEvent({
    eventType: "lead_qualification_review_resolved",
    source: "user",
    outcome: "succeeded",
    occurredAt: resolvedAt,
    userId: input.userId,
    businessId: review.businessId,
    metadata: {
      reviewId: review.reviewId,
      qualificationId: review.qualificationId,
      leadId: review.leadId,
      businessId: review.businessId,
      outcome: input.outcome,
      decision: q.decision,
      qualificationPolicyVersion: q.qualificationPolicyVersion,
      engineVersion: q.engineVersion,
      resolvedBy: input.userId,
    },
  });
  await persistAuditEvent(event, asAuditExecutor(executor));
  return updated;
}
