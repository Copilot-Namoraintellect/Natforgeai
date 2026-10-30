// ─── R8-C Market & External Signal Intelligence — ingest service ───
//
// Orchestrates one external-signal ingest end to end: strict boundary →
// ownership re-verification → deterministic source/signal identity →
// server-derived trust/freshness/relevance → insert-first exact-once
// persistence → corroboration/contradiction/supersession/staleness family
// effects (immutable xsf1: facts + CAS-guarded derived state) → canonical
// audit. External content is inert evidence throughout; nothing here executes
// anything, and no upstream (R5/R7/R8-A) table is ever written.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import type { ExternalSignalLifecycleEventRow, ExternalSignalRow } from "@db/schema";
import {
  MARKET_SIGNAL_CONTRACT_VERSION,
  MarketSignalInputError,
  buildMarketSignalInput,
  type MarketSignalDuplicateClassification,
  type MarketSignalIngestInput,
} from "./market-signal-contract";
import {
  deriveClaimFamilyKey,
  deriveClaimKey,
  deriveEvidenceHash,
  deriveLifecycleEventId,
  deriveSignalId,
  normalizeClaimText,
  resolveSourceIdentity,
  type MarketSignalImmutableCore,
} from "./market-signal-identity";
import { assessContentIsolation, EXTERNAL_CONTENT_INJECTION_LIMITATION } from "./market-signal-content";
import { deriveConfidenceClass, deriveRegistryClass, deriveSourceTrustClass } from "./market-source-trust";
import { computeCorroboration, type CorroborationCandidate } from "./market-signal-corroboration";
import { deriveFreshnessClass } from "./market-signal-freshness";
import { buildBusinessTermSet, evaluateRelevance } from "./market-signal-relevance";
import { deriveSignalStatus, MARKET_LIFECYCLE_REASON_CODES } from "./market-signal-lifecycle";
import {
  assertContradictionScope,
  assertSupersessionScope,
  assertBusinessOwnership,
} from "./market-signal-ownership";
import {
  getSignalById,
  insertLifecycleEvent,
  insertSignal,
  insertSource,
  listLifecycleEvents,
  listSignals,
  resolveMarketSignalDb,
  updateSignalDerivedState,
  type MarketSignalStoreExecutor,
} from "./market-signal-store";

export interface IngestMarketSignalResult {
  signal: ExternalSignalRow;
  duplicateClassification: MarketSignalDuplicateClassification;
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitSignalAudit(args: {
  db: MarketSignalStoreExecutor;
  userId: number;
  businessId: number;
  signal: ExternalSignalRow;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "external_signal_recorded",
      occurredAt: args.signal.ingestedAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.signal.signalId,
      metadata: {
        signalId: args.signal.signalId,
        businessId: args.businessId,
        signalType: args.signal.signalType,
        subjectType: args.signal.subjectType,
        sourceId: args.signal.sourceId,
        sourceType: args.signal.sourceType,
        sourceTrustClass: args.signal.sourceTrustClass,
        registryClass: args.signal.registryClass,
        confidenceClass: args.signal.confidenceClass,
        freshnessClass: args.signal.freshnessClass,
        relevanceClass: args.signal.relevanceClass,
        contractVersion: MARKET_SIGNAL_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    // Loud, retry-safe failure: the signal stays durable; the audit ledger is
    // fingerprint-deduplicated so a later retry cannot duplicate it.
    console.error(
      `[MarketSignal] Failed to persist external_signal_recorded audit event for ${args.signal.signalId}:`,
      (err as Error)?.message
    );
  }
}

async function emitLifecycleAudit(args: {
  db: MarketSignalStoreExecutor;
  userId: number;
  signalId: string;
  fact: ExternalSignalLifecycleEventRow;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "external_signal_lifecycle",
      occurredAt: args.fact.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      artifactId: args.signalId,
      metadata: {
        signalId: args.signalId,
        lifecycleType: args.fact.lifecycleType,
        toStatus: args.fact.toStatus,
        counterpartySignalId: args.fact.counterpartySignalId ?? null,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[MarketSignal] Failed to persist external_signal_lifecycle audit event for ${args.signalId}:`,
      (err as Error)?.message
    );
  }
}

// ─── Mint one immutable lifecycle fact (insert-first; replays converge) ───

async function mintLifecycleFact(args: {
  db: MarketSignalStoreExecutor;
  userId: number;
  signalId: string;
  lifecycleType: "CORROBORATION" | "CONTRADICTION" | "SUPERSESSION" | "STALENESS" | "INVALIDATION";
  toStatus: string;
  counterpartySignalId?: string | null;
  occurredAt: string;
}): Promise<ExternalSignalLifecycleEventRow | null> {
  const eventId = deriveLifecycleEventId({
    signalId: args.signalId,
    lifecycleType: args.lifecycleType,
    counterpartySignalId: args.counterpartySignalId ?? null,
    toStatus: args.toStatus,
    occurredAt: args.occurredAt,
  });
  const result = await insertLifecycleEvent(
    {
      signalLifecycleEventId: eventId,
      signalId: args.signalId,
      counterpartySignalId: args.counterpartySignalId ?? null,
      userId: args.userId,
      lifecycleType: args.lifecycleType,
      toStatus: args.toStatus,
      occurredAt: args.occurredAt,
      reasonCode: MARKET_LIFECYCLE_REASON_CODES[args.lifecycleType],
    },
    args.db
  );
  if (result.inserted) {
    await emitLifecycleAudit({ db: args.db, userId: args.userId, signalId: args.signalId, fact: result.row });
    return result.row;
  }
  return null; // idempotent replay — no new fact, no audit
}

// ─── Derived-state refresh (recomputed identically; CAS-guarded) ───

interface RefreshResult {
  row: ExternalSignalRow;
  /** True when a real transition occurred (a lifecycle fact was minted). */
  transitioned: boolean;
  gainedCorroboration: boolean;
}

/**
 * Recompute one signal's server-derived state (freshness, corroboration,
 * trust, confidence, status) from durable rows + immutable facts. Applies a
 * CAS-guarded patch only when something derived actually changed, and mints
 * the corresponding lifecycle facts. Reads are tenant + business scoped.
 */
async function refreshSignalState(
  db: MarketSignalStoreExecutor,
  userId: number,
  row: ExternalSignalRow,
  now: string
): Promise<RefreshResult> {
  const facts = await listLifecycleEvents(userId, row.signalId, db);
  const freshnessClass = deriveFreshnessClass({
    signalType: row.signalType as never,
    publishedAt: row.publishedAt ?? null,
    observedAt: row.observedAt,
    now,
  });

  // Same claim family (contradiction counting + visibility) and same claim
  // (corroboration candidates), always within tenant + business.
  const familyRows = await listSignals(
    userId,
    { businessId: Number(row.businessId), claimFamilyKey: row.claimFamilyKey, limit: 500 },
    db
  );
  const claimCandidates: CorroborationCandidate[] = familyRows
    .filter((r) => r.claimKey === row.claimKey)
    .map((r) => ({
      signalId: r.signalId,
      sourceIndependenceKey: r.sourceIndependenceKey,
      eventKey: r.eventKey,
      signalStatus: r.signalStatus,
      freshnessClass: r.freshnessClass,
    }));
  const activeContradictionCount = familyRows.filter(
    (r) =>
      r.signalId !== row.signalId &&
      ((r.contradictingSignalIds as string[]) ?? []).includes(row.signalId) &&
      r.signalStatus !== "INVALIDATED" &&
      r.signalStatus !== "SUPERSEDED"
  ).length;

  const corroboration = computeCorroboration({
    self: {
      signalId: row.signalId,
      sourceIndependenceKey: row.sourceIndependenceKey,
      eventKey: row.eventKey,
      signalStatus: row.signalStatus,
      freshnessClass: row.freshnessClass,
    },
    sameClaimCandidates: claimCandidates,
    activeContradictionCount,
  });
  const sourceTrustClass = deriveSourceTrustClass({
    registryClass: row.registryClass as never,
    independentCorroborationCount: corroboration.independentCorroborationCount,
    contradictedUnresolved: corroboration.corroborationStatus === "CONTRADICTED",
  });
  const confidenceClass = deriveConfidenceClass({ sourceTrustClass, freshnessClass });
  const signalStatus = deriveSignalStatus({ facts, freshnessClass, corroborationStatus: corroboration.corroborationStatus });

  const storedCorroborating = ((row.corroboratingSignalIds as string[]) ?? []).join(",");
  const nextCorroborating = [...corroboration.corroboratingSignalIds].join(",");
  const changed =
    row.freshnessClass !== freshnessClass ||
    row.corroborationStatus !== (corroboration.corroborationStatus as string) ||
    storedCorroborating !== nextCorroborating ||
    row.sourceTrustClass !== (sourceTrustClass as string) ||
    row.confidenceClass !== (confidenceClass as string) ||
    row.signalStatus !== (signalStatus as string);

  if (!changed) {
    return { row, transitioned: false, gainedCorroboration: false };
  }

  const gainedCorroboration =
    ((row.corroboratingSignalIds as string[]) ?? []).length === 0 &&
    corroboration.corroboratingSignalIds.length > 0;

  const updated = await updateSignalDerivedState(
    userId,
    row.signalId,
    Number(row.version),
    {
      freshnessClass,
      corroborationStatus: corroboration.corroborationStatus,
      corroboratingSignalIds: [...corroboration.corroboratingSignalIds],
      sourceTrustClass,
      confidenceClass,
      signalStatus,
      version: Number(row.version) + 1,
    },
    db
  );
  const nextRow = updated ?? row;

  if (gainedCorroboration) {
    await mintLifecycleFact({
      db,
      userId,
      signalId: row.signalId,
      lifecycleType: "CORROBORATION",
      toStatus: signalStatus,
      counterpartySignalId: corroboration.corroboratingSignalIds[0] ?? null,
      occurredAt: now,
    });
  }
  const becameStale =
    row.signalStatus !== "STALE" && (signalStatus === "STALE" || signalStatus === "INVALIDATED");
  if (becameStale) {
    await mintLifecycleFact({
      db,
      userId,
      signalId: row.signalId,
      lifecycleType: "STALENESS",
      toStatus: signalStatus,
      occurredAt: now,
    });
  }
  return { row: nextRow, transitioned: true, gainedCorroboration };
}

// ─── Ingest ───

/**
 * Record one external market signal. Idempotent: retries/replays converge to
 * the durable row; conflicting replay fails closed. Corroboration,
 * contradiction, supersession and staleness effects on the claim family are
 * applied exactly once (immutable facts + CAS-guarded derived columns).
 */
export async function ingestMarketSignal(
  executor: MarketSignalStoreExecutor | undefined,
  ctx: { userId: number },
  raw: unknown,
  now: string
): Promise<IngestMarketSignalResult> {
  const db = resolveMarketSignalDb(executor);
  const userId = ctx.userId;
  const input: MarketSignalIngestInput = buildMarketSignalInput(raw);

  // Bounded clock skew on the observation itself (house ±5 minute rule).
  if (Date.parse(input.observedAt) - Date.parse(now) > 5 * 60_000) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      "observedAt is more than 5 minutes in the future; temporal evidence rejected."
    );
  }

  // ─── Ownership (fail closed) ───
  const business = await assertBusinessOwnership(db, userId, input.businessId);

  // ─── Source identity / provenance (deterministic; spoof/malform fail closed) ───
  const sourceIdentity = resolveSourceIdentity(userId, input.source);
  const registryEval = deriveRegistryClass(sourceIdentity.originKey, input.source.sourceType);

  // ─── Inert content ───
  const claimText = normalizeClaimText(input.claimText);
  const isolation = assessContentIsolation(claimText);

  // ─── Freshness (deterministic from timestamps + policy) ───
  const freshnessClass = deriveFreshnessClass({
    signalType: input.signalType,
    publishedAt: input.publishedAt ?? null,
    observedAt: input.observedAt,
    now,
  });

  // ─── Business relevance (deterministic ceiling; model proposal bounded) ───
  const businessTerms = buildBusinessTermSet({
    name: business.name,
    industry: business.industry,
    description: business.description,
    productOrService: business.productOrService,
    targetAudience: business.targetAudience,
    targetCustomer: business.targetCustomer,
    mainGoal: business.mainGoal,
    website: business.website,
  });
  const relevance = evaluateRelevance({
    subjectRef: input.subjectRef,
    claimAspect: input.claimAspect,
    claimText,
    businessTerms,
    proposedRelevanceClass: input.modelAssistance?.proposedRelevanceClass,
  });

  // ─── Claim fingerprints ───
  const claimFamilyKey = deriveClaimFamilyKey({
    signalType: input.signalType,
    subjectType: input.subjectType,
    subjectRef: input.subjectRef,
    claimAspect: input.claimAspect,
  });
  const claimKey = deriveClaimKey(claimFamilyKey, claimText);

  // ─── Lineage validation (scope-checked, fail closed) ───
  for (const targetId of input.contradictsSignalIds ?? []) {
    await assertContradictionScope(db, userId, input.businessId, claimFamilyKey, claimKey, targetId);
  }
  if (input.supersedesSignalId !== undefined) {
    await assertSupersessionScope(db, userId, input.businessId, claimFamilyKey, input.supersedesSignalId);
  }

  // ─── Source registry (insert-first convergence) ───
  await insertSource(
    {
      sourceId: sourceIdentity.sourceId,
      userId,
      sourceType: input.source.sourceType,
      originKey: sourceIdentity.originKey,
      sourceUriRef: sourceIdentity.sourceUriRef,
      registryClass: registryEval.registryClass,
      spoofFlagged: null,
      firstSeenAt: now,
    },
    db
  );

  // ─── Initial derived classes ───
  const claimPeers = await listSignals(userId, { businessId: input.businessId, claimKey, limit: 500 }, db);
  const initialCorroboration = computeCorroboration({
    self: {
      signalId: "", // identity assigned below; self excluded by id comparison
      sourceIndependenceKey: sourceIdentity.originKey,
      eventKey: input.eventKey,
      signalStatus: "OBSERVED",
      freshnessClass,
    },
    sameClaimCandidates: claimPeers.map((r) => ({
      signalId: r.signalId,
      sourceIndependenceKey: r.sourceIndependenceKey,
      eventKey: r.eventKey,
      signalStatus: r.signalStatus,
      freshnessClass: r.freshnessClass,
    })),
    activeContradictionCount: 0,
  });
  const signalId = deriveSignalId({
    tenantUserId: userId,
    businessId: input.businessId,
    sourceId: sourceIdentity.sourceId,
    eventKey: input.eventKey,
  });
  const sourceTrustClass = deriveSourceTrustClass({
    registryClass: registryEval.registryClass,
    independentCorroborationCount: initialCorroboration.independentCorroborationCount,
    contradictedUnresolved: false,
  });
  const confidenceClass = deriveConfidenceClass({ sourceTrustClass, freshnessClass });
  const limitations = [...(input.limitations ?? [])];
  if (isolation.injectionSuspected && !limitations.includes(EXTERNAL_CONTENT_INJECTION_LIMITATION)) {
    limitations.push(EXTERNAL_CONTENT_INJECTION_LIMITATION);
  }
  const core: MarketSignalImmutableCore = {
    userId,
    businessId: input.businessId,
    signalType: input.signalType,
    subjectType: input.subjectType,
    subjectRef: input.subjectRef,
    claimAspect: input.claimAspect,
    sourceId: sourceIdentity.sourceId,
    sourceType: input.source.sourceType,
    sourceUriRef: sourceIdentity.sourceUriRef,
    eventKey: input.eventKey,
    claimText,
    observedAt: input.observedAt,
    publishedAt: input.publishedAt ?? null,
    freshnessPolicyVersion: "market-signal-freshness/v1",
    contradictsSignalIds: [...(input.contradictsSignalIds ?? [])].sort(),
    supersedesSignalId: input.supersedesSignalId ?? null,
  };

  const insertResult = await insertSignal(
    {
      signalId,
      userId,
      businessId: input.businessId,
      signalType: input.signalType,
      subjectType: input.subjectType,
      subjectRef: input.subjectRef,
      claimAspect: input.claimAspect,
      sourceId: sourceIdentity.sourceId,
      sourceType: input.source.sourceType,
      sourceUriRef: sourceIdentity.sourceUriRef,
      eventKey: input.eventKey,
      registryClass: registryEval.registryClass,
      sourceTrustClass,
      sourceIndependenceKey: sourceIdentity.originKey,
      claimText,
      claimKey,
      claimFamilyKey,
      evidenceHash: deriveEvidenceHash(core),
      observedAt: input.observedAt,
      publishedAt: input.publishedAt ?? null,
      ingestedAt: now,
      freshnessClass,
      freshnessPolicyVersion: "market-signal-freshness/v1",
      corroborationStatus: initialCorroboration.corroborationStatus,
      corroboratingSignalIds: [...initialCorroboration.corroboratingSignalIds],
      contradictingSignalIds: [...(input.contradictsSignalIds ?? [])],
      relevanceClass: relevance.relevanceClass,
      relevanceEvidence: relevance.evidence,
      confidenceClass,
      signalStatus: deriveSignalStatus({
        facts: [],
        freshnessClass,
        corroborationStatus: initialCorroboration.corroborationStatus,
      }),
      contentIsolation: "INERT_EVIDENCE",
      injectionSuspected: isolation.injectionSuspected ? "true" : "false",
      limitations,
      modelAssistance: input.modelAssistance ?? null,
      supersedesSignalId: input.supersedesSignalId ?? null,
      version: 1,
    },
    db
  );

  if (!insertResult.inserted) {
    // Idempotent replay: the durable row already exists with identical
    // material; convergence emits zero lifecycle facts and zero audit.
    return { signal: insertResult.row, duplicateClassification: "idempotent_replay" };
  }

  const insertedRow = insertResult.row;
  await emitSignalAudit({ db, userId, businessId: input.businessId, signal: insertedRow });

  // ─── Family effects (exactly once) ───
  // 1. Supersession target → SUPERSEDED + fact.
  if (input.supersedesSignalId !== undefined) {
    const target = await getSignalById(userId, input.supersedesSignalId, db);
    if (target) {
      await updateSignalDerivedState(
        userId,
        target.signalId,
        Number(target.version),
        { signalStatus: "SUPERSEDED", version: Number(target.version) + 1 },
        db
      );
      await mintLifecycleFact({
        db,
        userId,
        signalId: target.signalId,
        lifecycleType: "SUPERSESSION",
        toStatus: "SUPERSEDED",
        counterpartySignalId: insertedRow.signalId,
        occurredAt: now,
      });
    }
  }

  // 2. Contradiction targets → recompute (CONTRADICTED/MIXED) + facts.
  for (const targetId of input.contradictsSignalIds ?? []) {
    const target = await getSignalById(userId, targetId, db);
    if (!target) continue;
    const before = target.signalStatus;
    const refresh = await refreshSignalState(db, userId, target, now);
    if (refresh.row.signalStatus !== before) {
      await mintLifecycleFact({
        db,
        userId,
        signalId: targetId,
        lifecycleType: "CONTRADICTION",
        toStatus: refresh.row.signalStatus,
        counterpartySignalId: insertedRow.signalId,
        occurredAt: now,
      });
    }
  }

  // 3. Claim-set corroboration + staleness refresh (includes the new row).
  const claimSet = await listSignals(userId, { businessId: input.businessId, claimKey, limit: 500 }, db);
  for (const member of claimSet) {
    await refreshSignalState(db, userId, member, now);
  }

  const finalRow = (await getSignalById(userId, insertedRow.signalId, db)) ?? insertedRow;
  return { signal: finalRow, duplicateClassification: "none" };
}

// ─── Reads ───

export interface MarketSignalReadResult {
  signal: ExternalSignalRow;
  lifecycle: ExternalSignalLifecycleEventRow[];
  /** Signals in the same claim family that list this signal as contradicted. */
  contradictedBySignalIds: string[];
}

/**
 * Tenant-scoped read of one signal with lifecycle + contradiction visibility.
 * Freshness is recomputed at read (staleness can never silently stay current).
 */
export async function getMarketSignal(
  executor: MarketSignalStoreExecutor | undefined,
  ctx: { userId: number },
  signalId: string,
  now: string
): Promise<MarketSignalReadResult | null> {
  const db = resolveMarketSignalDb(executor);
  const row = await getSignalById(ctx.userId, signalId, db);
  if (!row) return null;
  const lifecycle = await listLifecycleEvents(ctx.userId, signalId, db);
  const refreshed = await refreshSignalState(db, ctx.userId, row, now);
  const family = await listSignals(
    ctx.userId,
    { businessId: Number(row.businessId), claimFamilyKey: row.claimFamilyKey, limit: 500 },
    db
  );
  const contradictedBySignalIds = family
    .filter((r) => r.signalId !== row.signalId && ((r.contradictingSignalIds as string[]) ?? []).includes(row.signalId))
    .map((r) => r.signalId)
    .slice(0, 16);
  return { signal: refreshed.row, lifecycle, contradictedBySignalIds };
}

/** Tenant-scoped list with optional filters; derived state refreshed at read. */
export async function listMarketSignals(
  executor: MarketSignalStoreExecutor | undefined,
  ctx: { userId: number },
  filters: {
    businessId?: number;
    signalType?: string;
    signalStatus?: string;
    relevanceClass?: string;
    sourceTrustClass?: string;
    freshnessClass?: string;
    limit?: number;
  },
  now: string
): Promise<ExternalSignalRow[]> {
  const db = resolveMarketSignalDb(executor);
  const rows = await listSignals(ctx.userId, filters, db);
  const refreshed: ExternalSignalRow[] = [];
  for (const row of rows) {
    refreshed.push((await refreshSignalState(db, ctx.userId, row, now)).row);
  }
  return refreshed;
}

export async function listMarketSignalLifecycle(
  executor: MarketSignalStoreExecutor | undefined,
  ctx: { userId: number },
  signalId: string
): Promise<ExternalSignalLifecycleEventRow[]> {
  const db = resolveMarketSignalDb(executor);
  const row = await getSignalById(ctx.userId, signalId, db);
  if (!row) return [];
  return listLifecycleEvents(ctx.userId, signalId, db);
}
