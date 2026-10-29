// ─── R7-C Business Learning Engine — service orchestration ───
//
// Runs the REAL derivation pipeline against durable stores and the frozen
// upstream seams: intake validation → evidence bundle → deterministic
// candidates → closed confidence classification → novelty comparison →
// insert-first exact-once persistence → governed lifecycle side effects →
// deterministic audit. Learning is evidence, not authority: no code path
// here mutates upstream (R4/R5/R6/R7-A/R7-B) or downstream (R7-D/R7-E)
// authority, and no governance decision is made.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import type { BusinessLearningRecordRow, InsertBusinessLearningRecordRow } from "@db/schema";
import {
  businessLearningDeriveInputSchema,
  businessLearningSynchronizeInputSchema,
  guardNarrativeDraft,
  LearningStateError,
  type LearningDuplicateClassification,
} from "./business-learning-contract";
import {
  createUpstreamPorts,
  type BusinessLearningUpstreamPorts,
  type ConsumedOutcomeProjection,
} from "./business-learning-upstream-seam";
import { buildEvidenceBundle, type LearningEvidenceBundle } from "./business-learning-evidence-bundle";
import {
  validateEvidenceInput,
  deriveCandidates,
  renderLearningStatement,
  type ValidatedLearningEvidence,
  type DerivedLearningCandidate,
} from "./business-learning-derivation";
import {
  classifyLearningEvidence,
  deriveInitialStatus,
} from "./business-learning-confidence";
import { classifyNovelty, type ExistingLearningView } from "./business-learning-novelty";
import {
  deriveLearningId,
  deriveRecordHash,
  deriveUpstreamStateFingerprint,
  deriveLearningLifecycleEventId,
} from "./business-learning-identity";
import {
  getLearningByLearningId,
  listLearningBySubject,
  listLearningForUser,
  findLearningByOutcomeId,
  findLearningByAttributionId,
  insertLearningRecord,
  insertLearningLifecycleEvent,
  transitionLearningStatus,
  listLifecycleEventsForLearning,
  type LearningStoreExecutor,
} from "./business-learning-store";
import {
  buildLearningProjection,
  buildExperimentOptimisationProjection,
  resolveCurrentLearningRecord,
  type LearningProjection,
  type BusinessLearningExperimentProjection,
} from "./business-learning-projection";
import type { LearningContextScope } from "./business-learning-context";

export interface BusinessLearningServiceDeps {
  readonly ports?: BusinessLearningUpstreamPorts;
  readonly executor?: LearningStoreExecutor;
  /** Explicit clock — never read from the environment inside the engine. */
  readonly now?: Date;
}

function resolvePorts(deps: BusinessLearningServiceDeps): BusinessLearningUpstreamPorts {
  return deps.ports ?? createUpstreamPorts();
}

function resolveNow(deps: BusinessLearningServiceDeps): Date {
  return deps.now ?? new Date();
}

function asAuditExecutor(executor?: LearningStoreExecutor): AuditDbExecutor | undefined {
  if (!executor) return undefined;
  return { select: executor.select, insert: executor.insert };
}

function nowToDate(iso: string): Date {
  const ms = Date.parse(iso);
  return new Date(Number.isNaN(ms) ? 0 : ms);
}

// ─── Result shapes ───

export interface DerivedLearningResult {
  readonly learning: BusinessLearningRecordRow;
  readonly projection: LearningProjection;
  readonly duplicateClassification: LearningDuplicateClassification;
  readonly noveltyClass: string;
  readonly status: string;
}

export interface DeriveLearningResponse {
  readonly evidenceBundleId: string;
  readonly results: readonly DerivedLearningResult[];
}

// ─── Derivation ───

/**
 * Derives learning candidates from governed outcome + attribution evidence
 * and persists them exactly once. One call may mint several records (one per
 * derived subject); each converges independently on its durable anchors.
 * The caller's tenant id is session authority and is never client-supplied.
 */
export async function deriveBusinessLearning(
  userId: number,
  rawInput: unknown,
  deps: BusinessLearningServiceDeps = {}
): Promise<DeriveLearningResponse> {
  const input = businessLearningDeriveInputSchema.parse(rawInput);
  const now = resolveNow(deps);

  if (input.narrativeDraft !== undefined) {
    guardNarrativeDraft(input.narrativeDraft);
  }

  // (1) Intake validation over the frozen seams (fail closed).
  const ports = resolvePorts(deps);
  const evidence = await validateEvidenceInput({
    userId,
    outcomeIds: input.outcomeIds,
    attributionIds: input.attributionIds,
    ports,
  });

  // (2) Deterministic evidence-bundle identity.
  const bundle = buildEvidenceBundle({
    userId: evidence.userId,
    businessId: evidence.businessId,
    outcomes: evidence.outcomes,
    attributions: evidence.attributions,
    sourceVersions: evidence.sourceVersions,
  });

  // (3) Credited campaign ids for the context scope: CAMPAIGN touchpoints
  // were tenant-re-verified by R7-B when materialised; the numeric identity
  // is consumed verbatim.
  const creditedCampaignIds: number[] = [];
  for (const attribution of evidence.attributions) {
    for (const touchpoint of attribution.touchpoints) {
      if (
        touchpoint.eligibility === "eligible" &&
        touchpoint.creditBps > 0 &&
        touchpoint.type === "CAMPAIGN"
      ) {
        const campaignId = Number(touchpoint.sourceIdentity);
        if (Number.isInteger(campaignId) && campaignId > 0) creditedCampaignIds.push(campaignId);
      }
    }
  }

  const upstreamStateFingerprint = deriveUpstreamStateFingerprint(
    evidence.outcomes.map((o) => ({ outcomeId: o.outcomeId, outcomeStatus: o.outcomeStatus }))
  );

  // (4) Deterministic candidates.
  const { candidates } = deriveCandidates(evidence, creditedCampaignIds);

  // (5) Per-candidate classification, novelty comparison and persistence.
  const results: DerivedLearningResult[] = [];
  for (const candidate of candidates) {
    const result = await persistCandidate({
      candidate,
      evidence,
      bundle,
      upstreamStateFingerprint,
      narrativeDraft: input.narrativeDraft ?? null,
      now,
      deps,
    });
    results.push(result);
  }

  return { evidenceBundleId: bundle.evidenceBundleId, results: Object.freeze(results) };
}

async function persistCandidate(input: {
  candidate: DerivedLearningCandidate;
  evidence: ValidatedLearningEvidence;
  bundle: LearningEvidenceBundle;
  upstreamStateFingerprint: string;
  narrativeDraft: string | null;
  now: Date;
  deps: BusinessLearningServiceDeps;
}): Promise<DerivedLearningResult> {
  const { candidate, evidence, deps } = input;
  const executor = deps.executor;

  // Closed confidence / evidence classification, then the statement render
  // with the classified value bound.
  const classification = classifyLearningEvidence({
    supportCount: candidate.supportCount,
    contradictionCount: candidate.contradictionCount,
    pairs: candidate.creditableSupportPairs,
  });
  const statement = renderLearningStatement({
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    outcomeTypeFamily: candidate.outcomeTypeFamily,
    businessId: evidence.businessId,
    supportCount: candidate.supportCount,
    contradictionCount: candidate.contradictionCount,
    confidenceClass: classification.confidenceClass,
  });

  const learningId = deriveLearningId({
    userId: evidence.userId,
    businessId: evidence.businessId,
    learningType: candidate.learningType,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    outcomeTypeFamily: candidate.outcomeTypeFamily,
    contextScope: candidate.contextScope,
    evidenceBundleId: input.bundle.evidenceBundleId,
    upstreamStateFingerprint: input.upstreamStateFingerprint,
  });

  // Novelty comparison against existing current learning for the subject.
  const existing = await listLearningBySubject(
    evidence.userId,
    candidate.subjectType,
    candidate.subjectId,
    executor
  );
  const existingViews: ExistingLearningView[] = existing.map((row) => ({
    learningId: row.learningId,
    learningType: row.learningType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    evidenceBundleId: row.evidenceBundleId,
    upstreamStateFingerprint: row.upstreamStateFingerprint,
    status: row.status,
    contextScope: row.contextScope as LearningContextScope,
    outcomeIds: row.outcomeIds as string[],
    attributionIds: row.attributionIds as string[],
  }));
  const novelty = classifyNovelty(
    {
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      direction: candidate.direction,
      evidenceBundleId: input.bundle.evidenceBundleId,
      upstreamStateFingerprint: input.upstreamStateFingerprint,
      contextScope: candidate.contextScope,
      outcomeIds: evidence.outcomes.map((o) => o.outcomeId),
      attributionIds: evidence.attributions.map((a) => a.attributionId),
      supersedesAttributionIds: evidence.attributions
        .map((a) => a.supersedesAttributionId)
        .filter((v): v is string => v !== null),
      supersedesOutcomeIds: evidence.outcomes
        .map((o) => o.supersedesOutcomeId)
        .filter((v): v is string => v !== null),
    },
    existingViews
  );

  // Replay: an identical derivation converges on the durable row and never
  // re-emits events or side effects.
  if (novelty.noveltyClass === "DUPLICATE" && novelty.matchedLearningId) {
    const stored = await getLearningByLearningId(evidence.userId, novelty.matchedLearningId, executor);
    if (!stored) {
      throw new LearningStateError(
        "LEARNING_STALE_STATE",
        "Duplicate novelty matched a learning row that could not be re-read."
      );
    }
    const facts = await listLifecycleEventsForLearning(evidence.userId, stored.learningId, executor);
    return {
      learning: stored,
      projection: buildLearningProjection(stored, facts),
      duplicateClassification: "idempotent_replay",
      noveltyClass: "DUPLICATE",
      status: stored.status,
    };
  }

  const status = deriveInitialStatus({
    confidenceClass: classification.confidenceClass,
    contradictionCount: candidate.contradictionCount,
  });
  const derivedAt = input.now.toISOString();
  const supersedesLearningId =
    novelty.noveltyClass === "SUPERSEDING" ? novelty.matchedLearningId : null;
  const outcomeIds = [...new Set(candidate.pairs.map((p) => p.outcome.outcomeId))].sort();
  const attributionIds = [...new Set(candidate.pairs.map((p) => p.attribution.attributionId))].sort();

  const recordHash = deriveRecordHash({
    learningId,
    evidenceBundleId: input.bundle.evidenceBundleId,
    userId: evidence.userId,
    businessId: evidence.businessId,
    learningType: candidate.learningType,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    outcomeTypeFamily: candidate.outcomeTypeFamily,
    contextScope: candidate.contextScope,
    statement,
    outcomeIds,
    attributionIds,
    upstreamStateFingerprint: input.upstreamStateFingerprint,
    supportCount: candidate.supportCount,
    contradictionCount: candidate.contradictionCount,
    confidenceClass: classification.confidenceClass,
    evidenceClass: classification.evidenceClass,
    noveltyClass: novelty.noveltyClass,
    limitations: candidate.limitations,
    sourceVersions: evidence.sourceVersions,
    narrativeDraft: input.narrativeDraft,
    validUntil: null,
    supersedesLearningId,
    derivedAt,
  });

  const row: InsertBusinessLearningRecordRow = {
    learningId,
    evidenceBundleId: input.bundle.evidenceBundleId,
    userId: evidence.userId,
    businessId: evidence.businessId,
    learningType: candidate.learningType,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    outcomeTypeFamily: candidate.outcomeTypeFamily,
    contextScope: { ...candidate.contextScope },
    statement,
    outcomeIds,
    attributionIds,
    upstreamStateFingerprint: input.upstreamStateFingerprint,
    supportCount: candidate.supportCount,
    contradictionCount: candidate.contradictionCount,
    confidenceClass: classification.confidenceClass,
    evidenceClass: classification.evidenceClass,
    noveltyClass: novelty.noveltyClass,
    status,
    limitations: [...candidate.limitations],
    sourceVersions: { ...evidence.sourceVersions },
    narrativeDraft: input.narrativeDraft,
    validUntil: null,
    supersedesLearningId,
    recordHash,
    version: 1,
    derivedAt,
    createdAt: nowToDate(derivedAt),
  };

  const inserted = await insertLearningRecord(row, executor);

  if (!inserted.inserted) {
    const facts = await listLifecycleEventsForLearning(evidence.userId, inserted.row.learningId, executor);
    return {
      learning: inserted.row,
      projection: buildLearningProjection(inserted.row, facts),
      duplicateClassification: "idempotent_replay",
      noveltyClass: "DUPLICATE",
      status: inserted.row.status,
    };
  }

  // Deterministic derivation fact + audit (exactly once per durable row).
  await mintLifecycleFact({
    userId: evidence.userId,
    learningId,
    lifecycleType: "derivation",
    status,
    reasonCode: null,
    occurredAt: derivedAt,
    deps,
  });
  await mintAudit({
    userId: evidence.userId,
    businessId: evidence.businessId,
    learningId,
    lifecycleType: "derivation",
    status,
    noveltyClass: novelty.noveltyClass,
    confidenceClass: classification.confidenceClass,
    evidenceClass: classification.evidenceClass,
    supportCount: candidate.supportCount,
    contradictionCount: candidate.contradictionCount,
    occurredAt: derivedAt,
    deps,
  });

  // Governed side effects: contradiction / supersession transitions on the
  // matched existing record, each with its own immutable fact + audit.
  if (
    (novelty.noveltyClass === "CONTRADICTING" || novelty.noveltyClass === "SUPERSEDING") &&
    novelty.matchedLearningId
  ) {
    await applyNoveltyTransition({
      userId: evidence.userId,
      matchedLearningId: novelty.matchedLearningId,
      noveltyClass: novelty.noveltyClass,
      occurredAt: derivedAt,
      deps,
    });
  }

  const facts = await listLifecycleEventsForLearning(evidence.userId, learningId, executor);
  return {
    learning: inserted.row,
    projection: buildLearningProjection(inserted.row, facts),
    duplicateClassification: "none",
    noveltyClass: novelty.noveltyClass,
    status,
  };
}

async function applyNoveltyTransition(input: {
  userId: number;
  matchedLearningId: string;
  noveltyClass: "CONTRADICTING" | "SUPERSEDING";
  occurredAt: string;
  deps: BusinessLearningServiceDeps;
}): Promise<void> {
  const executor = input.deps.executor;
  const target = await getLearningByLearningId(input.userId, input.matchedLearningId, executor);
  if (!target) return;
  if (
    target.status === "SUPERSEDED" ||
    target.status === "DEPRECATED" ||
    target.status === "INVALIDATED"
  ) {
    return; // history is terminal; nothing to transition
  }
  const toStatus = input.noveltyClass === "CONTRADICTING" ? "CONTRADICTED" : "SUPERSEDED";
  const transition = await transitionLearningStatus(
    input.userId,
    input.matchedLearningId,
    Number(target.version),
    ["CANDIDATE", "SUPPORTED"],
    toStatus,
    executor
  );
  if (transition.transitioned) {
    await mintLifecycleFact({
      userId: input.userId,
      learningId: input.matchedLearningId,
      lifecycleType: input.noveltyClass === "CONTRADICTING" ? "contradiction" : "supersession",
      status: toStatus,
      reasonCode:
        input.noveltyClass === "CONTRADICTING"
          ? "CONTRADICTED_BY_NEW_EVIDENCE"
          : "SUPERSEDED_BY_NEW_EVIDENCE",
      occurredAt: input.occurredAt,
      deps: input.deps,
    });
    await mintAudit({
      userId: input.userId,
      businessId: Number(target.businessId),
      learningId: input.matchedLearningId,
      lifecycleType: input.noveltyClass === "CONTRADICTING" ? "contradiction" : "supersession",
      status: toStatus,
      noveltyClass: input.noveltyClass,
      confidenceClass: target.confidenceClass,
      evidenceClass: target.evidenceClass,
      supportCount: Number(target.supportCount),
      contradictionCount: Number(target.contradictionCount),
      occurredAt: input.occurredAt,
      deps: input.deps,
    });
  }
}

async function mintLifecycleFact(input: {
  userId: number;
  learningId: string;
  lifecycleType: string;
  status: string;
  reasonCode: string | null;
  occurredAt: string;
  deps: BusinessLearningServiceDeps;
}): Promise<void> {
  const learningLifecycleEventId = deriveLearningLifecycleEventId({
    learningId: input.learningId,
    lifecycleType: input.lifecycleType,
    status: input.status,
    reasonCode: input.reasonCode,
    occurredAt: input.occurredAt,
  });
  await insertLearningLifecycleEvent(
    {
      learningLifecycleEventId,
      learningId: input.learningId,
      userId: input.userId,
      lifecycleType: input.lifecycleType,
      status: input.status,
      reasonCode: input.reasonCode,
      occurredAt: input.occurredAt,
      createdAt: nowToDate(input.occurredAt),
    },
    input.deps.executor
  );
}

async function mintAudit(input: {
  userId: number;
  businessId: number;
  learningId: string;
  lifecycleType: string;
  status: string;
  noveltyClass: string;
  confidenceClass: string;
  evidenceClass: string;
  supportCount: number;
  contradictionCount: number;
  occurredAt: string;
  deps: BusinessLearningServiceDeps;
}): Promise<void> {
  const event = createAuditEvent({
    eventType: "business_learning_recorded",
    source: "system",
    outcome: "succeeded",
    occurredAt: input.occurredAt,
    userId: input.userId,
    businessId: input.businessId,
    metadata: {
      learningId: input.learningId,
      businessId: input.businessId,
      lifecycleType: input.lifecycleType,
      status: input.status,
      noveltyClass: input.noveltyClass,
      confidenceClass: input.confidenceClass,
      evidenceClass: input.evidenceClass,
      supportCount: input.supportCount,
      contradictionCount: input.contradictionCount,
    },
  });
  await persistAuditEvent(event, asAuditExecutor(input.deps.executor));
}

// ─── Reads ───

export async function getBusinessLearning(
  userId: number,
  learningId: string,
  deps: BusinessLearningServiceDeps = {}
): Promise<LearningProjection | null> {
  const row = await getLearningByLearningId(userId, learningId, deps.executor);
  if (!row) return null;
  const facts = await listLifecycleEventsForLearning(userId, learningId, deps.executor);
  return buildLearningProjection(row, facts);
}

export async function listBusinessLearning(
  userId: number,
  filter: { businessId?: number; status?: string; subjectType?: string; subjectId?: string } = {},
  deps: BusinessLearningServiceDeps = {}
): Promise<LearningProjection[]> {
  let rows: BusinessLearningRecordRow[];
  if (filter.subjectType && filter.subjectId) {
    rows = await listLearningBySubject(userId, filter.subjectType, filter.subjectId, deps.executor);
  } else {
    rows = await listLearningForUser(userId, deps.executor);
  }
  const filtered = rows.filter((row) => {
    if (filter.businessId !== undefined && Number(row.businessId) !== filter.businessId) {
      return false;
    }
    if (filter.status !== undefined && row.status !== filter.status) return false;
    return true;
  });
  const projections: LearningProjection[] = [];
  for (const row of filtered) {
    const facts = await listLifecycleEventsForLearning(userId, row.learningId, deps.executor);
    projections.push(buildLearningProjection(row, facts));
  }
  return projections;
}

/** Resolves the current learning projection for a subject (read-time). */
export async function getCurrentLearningForSubject(
  userId: number,
  subjectType: string,
  subjectId: string,
  deps: BusinessLearningServiceDeps = {}
): Promise<LearningProjection | null> {
  const rows = await listLearningBySubject(userId, subjectType, subjectId, deps.executor);
  const current = resolveCurrentLearningRecord(rows);
  if (!current) return null;
  const facts = await listLifecycleEventsForLearning(userId, current.learningId, deps.executor);
  return buildLearningProjection(current, facts);
}

// ─── Downstream experiment / optimisation projection (read-only) ───

export async function getExperimentOptimisationProjection(
  userId: number,
  learningId: string,
  deps: BusinessLearningServiceDeps = {}
): Promise<BusinessLearningExperimentProjection | null> {
  const row = await getLearningByLearningId(userId, learningId, deps.executor);
  if (!row) return null;
  return buildExperimentOptimisationProjection(row, resolveNow(deps));
}

export async function listExperimentOptimisationProjections(
  userId: number,
  deps: BusinessLearningServiceDeps = {}
): Promise<BusinessLearningExperimentProjection[]> {
  const rows = await listLearningForUser(userId, deps.executor);
  const now = resolveNow(deps);
  return rows.map((row) => buildExperimentOptimisationProjection(row, now));
}

// ─── Synchronisation (upstream change re-evaluation) ───

export interface SynchronizeLearningResponse {
  readonly reevaluated: readonly {
    readonly learningId: string;
    readonly priorStatus: string;
    readonly action: "invalidated" | "superseded" | "contradicted" | "unchanged";
  }[];
  readonly derived: readonly string[];
}

async function resolveCurrentAttributionId(
  ports: BusinessLearningUpstreamPorts,
  userId: number,
  attributionId: string,
  depth = 0
): Promise<string> {
  if (depth > 25) {
    throw new LearningStateError(
      "LEARNING_STALE_ATTRIBUTION",
      `Attribution ${attributionId} supersession chain exceeds bounded depth; refusing to guess.`
    );
  }
  const superseding = await ports.attributions.findSupersedingAttribution(userId, attributionId);
  if (!superseding) return attributionId;
  return resolveCurrentAttributionId(ports, userId, superseding, depth + 1);
}

/**
 * Re-evaluates dependent learning after an upstream authority change.
 *
 * - Outcome reversal/cancellation/supersession destroys the evidential
 *   basis: the dependent record is INVALIDATED (immutable fact) and its
 *   bundle is re-derived so the contradiction is retained as new visible
 *   history (cases 3, 23).
 * - Attribution supersession substitutes the current attribution through
 *   the frozen lineage chain and re-derives, minting SUPERSEDING successors
 *   (case 22).
 * - Outcome verification changes re-derive under the new upstream state
 *   fingerprint, minting SUPERSEDING successors (case 23).
 *
 * No stale learning remains silently active; no history is ever deleted.
 */
export async function synchronizeBusinessLearning(
  userId: number,
  rawInput: unknown,
  deps: BusinessLearningServiceDeps = {}
): Promise<SynchronizeLearningResponse> {
  const input = businessLearningSynchronizeInputSchema.parse(rawInput);
  const ports = resolvePorts(deps);
  const now = resolveNow(deps);

  let dependents: BusinessLearningRecordRow[] = [];
  let outcome: ConsumedOutcomeProjection | null = null;
  if (input.outcomeId) {
    outcome = await ports.outcomes.getOutcomeForLearning(userId, input.outcomeId);
    if (!outcome) {
      throw new LearningStateError(
        "LEARNING_UNKNOWN_OUTCOME",
        `Outcome ${input.outcomeId} does not exist for this tenant; nothing to synchronize.`
      );
    }
    dependents = await findLearningByOutcomeId(userId, input.outcomeId, deps.executor);
  } else if (input.attributionId) {
    const attribution = await ports.attributions.getAttributionForLearning(userId, input.attributionId);
    if (!attribution) {
      throw new LearningStateError(
        "LEARNING_UNKNOWN_ATTRIBUTION",
        `Attribution ${input.attributionId} does not exist for this tenant; nothing to synchronize.`
      );
    }
    dependents = await findLearningByAttributionId(userId, input.attributionId, deps.executor);
  }

  const actions: SynchronizeLearningResponse["reevaluated"][number][] = [];
  const derived: string[] = [];

  for (const record of dependents) {
    if (
      record.status === "SUPERSEDED" ||
      record.status === "DEPRECATED" ||
      record.status === "INVALIDATED"
    ) {
      actions.push({ learningId: record.learningId, priorStatus: record.status, action: "unchanged" });
      continue;
    }

    const outcomeIds = [...(record.outcomeIds as string[])];
    const rawAttributionIds = [...(record.attributionIds as string[])];

    // Substitute superseded attributions through the current chain.
    const currentAttributionIds: string[] = [];
    let anyAttributionSubstituted = false;
    for (const attributionId of rawAttributionIds) {
      const current = await resolveCurrentAttributionId(ports, userId, attributionId);
      if (current !== attributionId) anyAttributionSubstituted = true;
      currentAttributionIds.push(current);
    }
    const attributionIds = [...new Set(currentAttributionIds)];

    // Re-validate the (possibly substituted) bundle; unknown upstream rows
    // fail closed rather than guessing.
    const evidence = await validateEvidenceInput({ userId, outcomeIds, attributionIds, ports });
    const newFingerprint = deriveUpstreamStateFingerprint(
      evidence.outcomes.map((o) => ({ outcomeId: o.outcomeId, outcomeStatus: o.outcomeStatus }))
    );

    const outcomeNowTerminal =
      outcome !== null &&
      (outcome.outcomeStatus === "REVERSED" ||
        outcome.outcomeStatus === "CANCELLED" ||
        outcome.outcomeStatus === "SUPERSEDED");

    if (outcomeNowTerminal && outcome) {
      // Destroyed evidential basis: invalidate first so no stale learning
      // stays active, then re-derive so the contradiction history persists.
      const transition = await transitionLearningStatus(
        userId,
        record.learningId,
        Number(record.version),
        ["CANDIDATE", "SUPPORTED", "CONTRADICTED"],
        "INVALIDATED",
        deps.executor
      );
      if (transition.transitioned) {
        const occurredAt = now.toISOString();
        await mintLifecycleFact({
          userId,
          learningId: record.learningId,
          lifecycleType: "invalidation",
          status: "INVALIDATED",
          reasonCode:
            outcome.outcomeStatus === "REVERSED"
              ? "OUTCOME_REVERSED"
              : outcome.outcomeStatus === "CANCELLED"
                ? "OUTCOME_CANCELLED"
                : "OUTCOME_SUPERSEDED",
          occurredAt,
          deps,
        });
        await mintAudit({
          userId,
          businessId: Number(record.businessId),
          learningId: record.learningId,
          lifecycleType: "invalidation",
          status: "INVALIDATED",
          noveltyClass: record.noveltyClass,
          confidenceClass: record.confidenceClass,
          evidenceClass: record.evidenceClass,
          supportCount: Number(record.supportCount),
          contradictionCount: Number(record.contradictionCount),
          occurredAt,
          deps,
        });
        actions.push({ learningId: record.learningId, priorStatus: record.status, action: "invalidated" });
      } else {
        actions.push({ learningId: record.learningId, priorStatus: record.status, action: "unchanged" });
      }
      const response = await deriveBusinessLearning(
        userId,
        { outcomeIds, attributionIds },
        deps
      );
      for (const result of response.results) derived.push(result.learning.learningId);
      continue;
    }

    if (anyAttributionSubstituted || newFingerprint !== record.upstreamStateFingerprint) {
      // Re-derivation mints SUPERSEDING successors via novelty comparison.
      const response = await deriveBusinessLearning(userId, { outcomeIds, attributionIds }, deps);
      let action: SynchronizeLearningResponse["reevaluated"][number]["action"] = "unchanged";
      for (const result of response.results) {
        derived.push(result.learning.learningId);
        if (result.learning.supersedesLearningId === record.learningId) {
          action =
            result.noveltyClass === "CONTRADICTING"
              ? "contradicted"
              : result.noveltyClass === "SUPERSEDING"
                ? "superseded"
                : "unchanged";
        }
      }
      actions.push({ learningId: record.learningId, priorStatus: record.status, action });
      continue;
    }

    actions.push({ learningId: record.learningId, priorStatus: record.status, action: "unchanged" });
  }

  return { reevaluated: Object.freeze(actions), derived: Object.freeze(derived) };
}
