// ─── R8-A Strategic Memory — record/ingest orchestration ───
//
// Orchestrates strategic-memory recording: pure validation → server-side
// ownership re-verification → governed upstream loading (seam) or operator
// attestation derivation → deterministic identity → insert-first persistence
// → lineage effects (immutable smf1: facts + guarded CAS transitions) →
// dependency re-evaluation (upstream invalidation/supersession chains) →
// deterministic audit. Every step is idempotent (durable unique anchors +
// replay), so a crash/restart converges to one durable memory. Emits no
// strategy, no budget, no experiment, no execution authority of any kind.

import { and, eq } from "drizzle-orm";
import { businesses, campaigns } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  STRATEGIC_MEMORY_SOURCE_VERSIONS,
  StrategicMemoryInputError,
  StrategicMemoryOwnershipError,
  StrategicMemoryStateConflictError,
  buildStrategicMemoryIngestInput,
  buildStrategicMemoryRecordInput,
  type StrategicMemoryConfidenceClass,
  type StrategicMemoryDuplicateClassification,
  type StrategicMemoryIngestInput,
  type StrategicMemoryRecordInput,
} from "./strategic-memory-contract";
import {
  buildMemoryLifecycleEventId,
  deriveMemoryEvidenceHash,
  deriveMemoryId,
  deriveMemoryKey,
  deriveMemoryLifecycleKey,
  deriveOperatorSourceIdentity,
  type StrategicMemoryContextScope,
} from "./strategic-memory-identity";
import { canTransitionMemoryStatus } from "./strategic-memory-temporal";
import {
  getMemoryByMemoryId,
  insertStrategicMemoryLifecycleEvent,
  insertStrategicMemoryRecord,
  listMemories,
  transitionMemoryStatus,
  type StrategicMemoryStoreExecutor,
  resolveStrategicMemoryDb,
} from "./strategic-memory-store";
import { loadUpstreamEvidence } from "./strategic-memory-upstream-seam";
import type { InsertStrategicMemoryRecordRow, InsertStrategicMemoryLifecycleEventRow, StrategicMemoryRecordRow } from "@db/schema";

const MAX_CAS_ATTEMPTS = 5;

export interface RecordStrategicMemoryResult {
  memory: StrategicMemoryRecordRow;
  duplicateClassification: StrategicMemoryDuplicateClassification;
}

export interface IngestStrategicMemoryResult {
  memory: StrategicMemoryRecordRow;
  duplicateClassification: StrategicMemoryDuplicateClassification;
  /** Memory records re-evaluated as a side effect of this ingest. */
  reevaluatedMemoryIds: string[];
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitMemoryAudit(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  businessId: number;
  memory: StrategicMemoryRecordRow;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "strategic_memory_recorded",
      occurredAt: args.memory.recordedAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.memory.memoryId,
      metadata: {
        memoryId: args.memory.memoryId,
        businessId: args.businessId,
        memoryType: args.memory.memoryType,
        subjectType: args.memory.subjectType,
        subjectId: args.memory.subjectId,
        statementType: args.memory.statementType,
        factStatus: args.memory.factStatus,
        sourceAuthority: args.memory.sourceAuthority,
        confidenceClass: args.memory.confidenceClass,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[StrategicMemory] Failed to persist strategic_memory_recorded audit event for ${args.memory.memoryId}:`,
      (err as Error)?.message
    );
  }
}

async function emitMemoryLifecycleAudit(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  memoryId: string;
  lifecycleType: string;
  targetStatus: string;
  successorMemoryId: string | null;
  occurredAt: string;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "strategic_memory_lifecycle",
      occurredAt: args.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      artifactId: args.memoryId,
      metadata: {
        memoryId: args.memoryId,
        lifecycleType: args.lifecycleType,
        targetStatus: args.targetStatus,
        successorMemoryId: args.successorMemoryId,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[StrategicMemory] Failed to persist strategic_memory_lifecycle audit event for ${args.memoryId}:`,
      (err as Error)?.message
    );
  }
}

// ─── Server-side ownership re-verification (fail closed) ───

async function assertBusinessOwnership(
  db: StrategicMemoryStoreExecutor,
  userId: number,
  businessId: number
): Promise<void> {
  const [row] = (await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1)) as unknown as Array<{ id: number; userId: number }>;
  if (!row) {
    throw new StrategicMemoryOwnershipError(
      "FORBIDDEN",
      `Business ${businessId} not found for the authenticated user.`
    );
  }
}

async function assertCampaignOwnership(
  db: StrategicMemoryStoreExecutor,
  userId: number,
  businessId: number,
  campaignId: number
): Promise<void> {
  const [row] = (await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), eq(campaigns.businessId, businessId)))
    .limit(1)) as unknown as Array<{ id: number }>;
  if (!row) {
    throw new StrategicMemoryOwnershipError(
      "FORBIDDEN",
      `Campaign ${campaignId} not found for the authenticated user + business.`
    );
  }
}

// ─── Lineage effects (immutable facts + guarded CAS transitions) ───

async function mintLifecycleFact(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  memoryId: string;
  lifecycleType: "supersession" | "contradiction" | "invalidation" | "staleness" | "expiry" | "reaffirmation";
  targetStatus: string;
  successorMemoryId: string | null;
  sourceIdentity: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): Promise<boolean> {
  const { db, userId, memoryId, lifecycleType, targetStatus, successorMemoryId, sourceIdentity, occurredAt, reasonCode } = args;
  const factRow: InsertStrategicMemoryLifecycleEventRow = {
    memoryLifecycleEventId: buildMemoryLifecycleEventId(
      deriveMemoryLifecycleKey({
        memoryId,
        lifecycleType,
        targetStatus,
        successorMemoryId,
        sourceIdentity,
        occurredAt,
        reasonCode,
      })
    ),
    memoryId,
    userId,
    lifecycleType,
    targetStatus,
    successorMemoryId,
    sourceIdentity,
    occurredAt,
    reasonCode,
  };
  const fact = await insertStrategicMemoryLifecycleEvent(factRow, db);
  if (fact.inserted) {
    await emitMemoryLifecycleAudit({ db, userId, memoryId, lifecycleType, targetStatus, successorMemoryId, occurredAt });
  }
  return fact.inserted;
}

/**
 * CAS-guarded status materialization driven by a freshly minted lifecycle
 * fact. Swallows a race only when the stored status already equals the
 * post-fact status; illegal transitions fail closed.
 */
async function applyStatusTransition(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  memoryId: string;
  targetStatus: string;
  occurredAt: string;
}): Promise<void> {
  const { db, userId, memoryId, targetStatus } = args;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const fresh = await getMemoryByMemoryId(userId, memoryId, db);
    if (!fresh) {
      throw new StrategicMemoryStateConflictError("STRATEGIC_MEMORY_STALE_STATE", `memory ${memoryId} vanished during transition.`);
    }
    if (fresh.factStatus === targetStatus) return;
    if (!canTransitionMemoryStatus(fresh.factStatus, targetStatus)) {
      throw new StrategicMemoryStateConflictError(
        "STRATEGIC_MEMORY_TRANSITION_INVALID",
        `memory ${memoryId} cannot transition from ${fresh.factStatus} to ${targetStatus}.`
      );
    }
    try {
      await transitionMemoryStatus(userId, memoryId, Number(fresh.version), targetStatus, db);
      return;
    } catch (err) {
      if (err instanceof StrategicMemoryStateConflictError) continue; // re-read, retry
      throw err;
    }
  }
  throw new StrategicMemoryStateConflictError(
    "STRATEGIC_MEMORY_STALE_STATE",
    `could not transition ${memoryId} to ${targetStatus} after ${MAX_CAS_ATTEMPTS} attempts.`
  );
}

async function supersedePredecessor(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  businessId: number;
  predecessor: StrategicMemoryRecordRow;
  successorMemoryId: string;
  occurredAt: string;
}): Promise<void> {
  const { db, userId, predecessor, successorMemoryId, occurredAt } = args;
  const inserted = await mintLifecycleFact({
    db,
    userId,
    memoryId: predecessor.memoryId,
    lifecycleType: "supersession",
    targetStatus: "SUPERSEDED",
    successorMemoryId,
    sourceIdentity: null,
    occurredAt,
    reasonCode: null,
  });
  if (inserted || predecessor.factStatus !== "SUPERSEDED") {
    await applyStatusTransition({ db, userId, memoryId: predecessor.memoryId, targetStatus: "SUPERSEDED", occurredAt });
  }
}

async function contradictMemory(args: {
  db: StrategicMemoryStoreExecutor;
  userId: number;
  target: StrategicMemoryRecordRow;
  successorMemoryId: string;
  occurredAt: string;
}): Promise<void> {
  const { db, userId, target, successorMemoryId, occurredAt } = args;
  const inserted = await mintLifecycleFact({
    db,
    userId,
    memoryId: target.memoryId,
    lifecycleType: "contradiction",
    targetStatus: "CONTRADICTED",
    successorMemoryId,
    sourceIdentity: null,
    occurredAt,
    reasonCode: null,
  });
  if (inserted || target.factStatus !== "CONTRADICTED") {
    await applyStatusTransition({ db, userId, memoryId: target.memoryId, targetStatus: "CONTRADICTED", occurredAt });
  }
}

// ─── record (operator attestation path) ───

/**
 * Record one operator-attested memory (ASSUMPTION / STRATEGIC_OBJECTIVE /
 * STRATEGIC_DECISION / CONSTRAINT). `now` is explicit ISO 8601 (no clock
 * here). Idempotent: retries/replays converge to the durable row; lineage
 * effects are insert-first and replay-safe.
 */
export async function recordStrategicMemory(
  executor: StrategicMemoryStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string
): Promise<RecordStrategicMemoryResult> {
  const userId = ctx.userId;
  const db = resolveStrategicMemoryDb(executor);

  // 1. Pure validation (strict boundary + client-authority guard + §5
  //    fact/assumption invariants + protected traits + lineage shape).
  const parsed: StrategicMemoryRecordInput = buildStrategicMemoryRecordInput(input, now);

  // 2. Ownership re-verification from durable rows (fail closed).
  await assertBusinessOwnership(db, userId, parsed.businessId);

  // 3. Server-derived context scope (clients can never widen it).
  let contextScope: StrategicMemoryContextScope = { scopeType: "BUSINESS", campaignId: null, businessDnaSnapshotId: null };
  if (parsed.subjectType === "CAMPAIGN") {
    const match = /^campaign:([0-9]+)$/.exec(parsed.subjectId);
    if (!match) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_CONTEXT_SCOPE_INVALID",
        `CAMPAIGN-subject memories require subjectId "campaign:<id>"; got ${JSON.stringify(parsed.subjectId)}.`
      );
    }
    const campaignId = Number(match[1]);
    await assertCampaignOwnership(db, userId, parsed.businessId, campaignId);
    contextScope = { scopeType: "CAMPAIGN", campaignId, businessDnaSnapshotId: null };
  } else if (parsed.subjectType === "BUSINESS" && parsed.subjectId !== `business:${parsed.businessId}`) {
    throw new StrategicMemoryInputError(
      "STRATEGIC_MEMORY_CONTEXT_SCOPE_INVALID",
      `BUSINESS-subject memories must reference the owned business (business:${parsed.businessId}).`
    );
  }

  // 4. Deterministic operator source identity + server-derived confidence.
  const statementText = parsed.statement.text;
  const sourceIdentity = deriveOperatorSourceIdentity({
    tenantUserId: userId,
    businessId: parsed.businessId,
    memoryType: parsed.memoryType,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
    statementText,
  });
  const confidenceClass: StrategicMemoryConfidenceClass =
    parsed.basis?.basisType === "PENDING_VERIFICATION" ? "UNVERIFIED" : "PROVISIONAL";

  // 5. Lineage bindings must exist in the same tenant + business scope.
  let predecessor: StrategicMemoryRecordRow | null = null;
  if (parsed.supersedesMemoryId) {
    predecessor = await getMemoryByMemoryId(userId, parsed.supersedesMemoryId, db);
    if (!predecessor || Number(predecessor.businessId) !== parsed.businessId) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_LINEAGE_SCOPE_CONFLICT",
        `supersedesMemoryId ${parsed.supersedesMemoryId} does not resolve in this business scope.`
      );
    }
  }
  const contradictionTargets: StrategicMemoryRecordRow[] = [];
  for (const id of parsed.contradictsMemoryIds ?? []) {
    const target = await getMemoryByMemoryId(userId, id, db);
    if (!target || Number(target.businessId) !== parsed.businessId) {
      throw new StrategicMemoryInputError(
        "STRATEGIC_MEMORY_LINEAGE_SCOPE_CONFLICT",
        `contradictsMemoryIds entry ${id} does not resolve in this business scope.`
      );
    }
    contradictionTargets.push(target);
  }

  // 6. Deterministic identity + immutable-core evidence hash.
  const validFrom = parsed.validFrom;
  const observedAt = parsed.observedAt ?? now;
  const recordedAt = parsed.recordedAt ?? now;
  const memoryId = deriveMemoryId(
    deriveMemoryKey({
      tenantUserId: userId,
      businessId: parsed.businessId,
      sourceAuthority: "operator_attestation",
      sourceIdentity,
      memoryType: parsed.memoryType,
      contextScope,
    })
  );
  const evidenceRefs = parsed.evidenceRefs ?? [];
  const limitations = parsed.limitations ?? [];
  const contradictsMemoryIds = parsed.contradictsMemoryIds ?? [];
    const evidenceHash = deriveMemoryEvidenceHash({
    userId,
    businessId: parsed.businessId,
    memoryType: parsed.memoryType,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
    statementType: parsed.statementType,
    statement: parsed.statement,
    evidenceRefs,
    sourceAuthority: "operator_attestation",
    sourceVersion: STRATEGIC_MEMORY_SOURCE_VERSIONS.operator_attestation,
    sourceIdentity,
    confidenceClass,
    basis: parsed.basis ?? null,
    limitations,
    validFrom,
    validUntil: parsed.validUntil ?? null,
    observedAt,
    supersedesMemoryId: parsed.supersedesMemoryId ?? null,
    contradictsMemoryIds,
    contextScope,
  });

  // A record whose validity window has already closed is history at birth:
  // materialize EXPIRED immediately (fact + status) so it can never be active.
  const initialStatus = parsed.validUntil != null && Date.parse(parsed.validUntil) < Date.parse(now) ? "EXPIRED" : "CURRENT";

  const row: InsertStrategicMemoryRecordRow = {
    memoryId,
    userId,
    businessId: parsed.businessId,
    memoryType: parsed.memoryType,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
    statementType: parsed.statementType,
    factStatus: initialStatus,
    statement: parsed.statement,
    evidenceRefs,
    sourceAuthority: "operator_attestation",
    sourceVersion: STRATEGIC_MEMORY_SOURCE_VERSIONS.operator_attestation,
    sourceIdentity,
    sourceFingerprint: evidenceHash,
    confidenceClass,
    basis: parsed.basis ?? null,
    limitations,
    validFrom,
    validUntil: parsed.validUntil ?? null,
    observedAt,
    recordedAt,
    supersedesMemoryId: parsed.supersedesMemoryId ?? null,
    contradictsMemoryIds,
    contextScope,
    evidenceHash,
    version: 1,
  };

  // 7. Insert-first persistence (retries/concurrency converge).
  const write = await insertStrategicMemoryRecord(row, db);
  const memory = write.row;

  // 8. Lineage effects (insert-first facts + CAS; replay-safe).
  if (write.inserted) {
    if (initialStatus === "EXPIRED") {
      await mintLifecycleFact({
        db,
        userId,
        memoryId: memory.memoryId,
        lifecycleType: "expiry",
        targetStatus: "EXPIRED",
        successorMemoryId: null,
        sourceIdentity: null,
        occurredAt: recordedAt,
        reasonCode: "VALIDITY_WINDOW_ENDED",
      });
    }
    if (predecessor) {
      await supersedePredecessor({ db, userId, businessId: parsed.businessId, predecessor, successorMemoryId: memory.memoryId, occurredAt: recordedAt });
    }
    for (const target of contradictionTargets) {
      await contradictMemory({ db, userId, target, successorMemoryId: memory.memoryId, occurredAt: recordedAt });
    }

    // Same-subject refresh without an explicit lineage binding: the prior
    // CURRENT memory for the exact same (business, type, subject) goes STALE
    // (visible, reversible-to-expiry history) — it must not silently remain
    // active next to the newer observation. Explicit supersession bindings
    // above take precedence and mark SUPERSEDED instead.
    const siblings = await listMemories(
      userId,
      {
        businessId: parsed.businessId,
        memoryType: parsed.memoryType,
        subjectType: parsed.subjectType,
        subjectId: parsed.subjectId,
        limit: 100,
      },
      db
    );
    for (const sibling of siblings) {
      if (sibling.memoryId === memory.memoryId) continue;
      if (sibling.factStatus !== "CURRENT") continue;
      if (parsed.supersedesMemoryId && sibling.memoryId === parsed.supersedesMemoryId) continue;
      const inserted = await mintLifecycleFact({
        db,
        userId,
        memoryId: sibling.memoryId,
        lifecycleType: "staleness",
        targetStatus: "STALE",
        successorMemoryId: memory.memoryId,
        sourceIdentity: null,
        occurredAt: recordedAt,
        reasonCode: "REPLACED_BY_NEWER_OBSERVATION",
      });
      if (inserted) {
        await applyStatusTransition({ db, userId, memoryId: sibling.memoryId, targetStatus: "STALE", occurredAt: recordedAt });
      }
    }

    await emitMemoryAudit({ db, userId, businessId: parsed.businessId, memory });
  }

  return { memory, duplicateClassification: write.duplicateClassification };
}

// ─── ingestR7 (governed upstream path) ───

/**
 * Ingest one governed upstream evidence record (R7 authority, Business DNA or
 * strategy snapshot) as strategic memory. The server loads every authority
 * field through the frozen seam; the client names only sourceAuthority +
 * sourceIdentity. Idempotent; drives dependency re-evaluation (upstream
 * supersession chains and invalidations) with insert-first lifecycle facts.
 */
export async function ingestStrategicMemory(
  executor: StrategicMemoryStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string
): Promise<IngestStrategicMemoryResult> {
  const userId = ctx.userId;
  const db = resolveStrategicMemoryDb(executor);

  // 1. Pure validation (strict boundary + client-authority guard).
  const parsed: StrategicMemoryIngestInput = buildStrategicMemoryIngestInput(input, now);

  // 2. Ownership re-verification from durable rows (fail closed).
  await assertBusinessOwnership(db, userId, parsed.businessId);

  // 3. Governed upstream load: every authority field is server-loaded;
  //    unknown source / cross-tenant / cross-business / stale version /
  //    tamper-shaped material all fail closed inside the seam.
  const consumed = await loadUpstreamEvidence(userId, parsed.businessId, parsed.sourceAuthority, parsed.sourceIdentity, db);

  // 4. Deterministic identity + immutable-core evidence hash.
  const observedAt = parsed.observedAt ?? consumed.observedAt;
  const recordedAt = parsed.recordedAt ?? now;
  const validUntil = consumed.governanceValidUntil ?? null;
  const memoryId = deriveMemoryId(
    deriveMemoryKey({
      tenantUserId: userId,
      businessId: parsed.businessId,
      sourceAuthority: consumed.sourceAuthority,
      sourceIdentity: consumed.sourceIdentity,
      memoryType: consumed.memoryType,
      contextScope: consumed.contextScope,
    })
  );
  const evidenceHash = deriveMemoryEvidenceHash({
    userId,
    businessId: parsed.businessId,
    memoryType: consumed.memoryType,
    subjectType: consumed.subjectType,
    subjectId: consumed.subjectId,
    statementType: "FACT",
    statement: consumed.statement,
    evidenceRefs: consumed.evidenceRefs,
    sourceAuthority: consumed.sourceAuthority,
    sourceVersion: consumed.sourceVersion,
    sourceIdentity: consumed.sourceIdentity,
    confidenceClass: consumed.confidenceClass,
    basis: null,
    limitations: consumed.limitations,
    validFrom: consumed.validFrom,
    validUntil,
    observedAt,
    supersedesMemoryId: null,
    contradictsMemoryIds: [],
    contextScope: consumed.contextScope,
  });

  // 5. Upstream lineage resolution: this record may supersede existing memory
  //    bound to the upstream identity it replaces (learning/attribution/
  //    outcome supersession chains).
  let predecessor: StrategicMemoryRecordRow | null = null;
  if (consumed.supersedesUpstreamIdentity) {
    predecessor = await findMemoryByUpstreamIdentity(db, userId, parsed.businessId, consumed.sourceAuthority, consumed.supersedesUpstreamIdentity, consumed.memoryType);
  }

  // A record bound to an already-expired governance validity window is
  // history at birth: materialize EXPIRED immediately (never active).
  const initialStatus =
    consumed.upstreamTerminalNegative
      ? "INVALIDATED"
      : validUntil !== null && Date.parse(validUntil) < Date.parse(now)
        ? "EXPIRED"
        : "CURRENT";
  const row: InsertStrategicMemoryRecordRow = {
    memoryId,
    userId,
    businessId: parsed.businessId,
    memoryType: consumed.memoryType,
    subjectType: consumed.subjectType,
    subjectId: consumed.subjectId,
    statementType: "FACT",
    factStatus: initialStatus,
    statement: consumed.statement,
    evidenceRefs: consumed.evidenceRefs,
    sourceAuthority: consumed.sourceAuthority,
    sourceVersion: consumed.sourceVersion,
    sourceIdentity: consumed.sourceIdentity,
    sourceFingerprint: consumed.sourceFingerprint,
    confidenceClass: consumed.confidenceClass,
    basis: null,
    limitations: consumed.limitations,
    validFrom: consumed.validFrom,
    validUntil,
    observedAt,
    recordedAt,
    supersedesMemoryId: predecessor?.memoryId ?? null,
    contradictsMemoryIds: [],
    contextScope: consumed.contextScope,
    evidenceHash,
    version: 1,
  };

  // 6. Insert-first persistence (retries/concurrency converge).
  const write = await insertStrategicMemoryRecord(row, db);
  const memory = write.row;
  const reevaluatedMemoryIds: string[] = [];

  if (write.inserted) {
    // 7. Lineage: direct supersession of the memory bound to the upstream
    //    predecessor identity (history preserved, exact binding).
    if (predecessor) {
      await supersedePredecessor({ db, userId, businessId: parsed.businessId, predecessor, successorMemoryId: memory.memoryId, occurredAt: recordedAt });
    }

    // 8. This record itself may be terminal-negative upstream (reversed
    //    outcome, contradicted learning): the fact is durable history, not
    //    active memory — record the invalidation fact explicitly.
    if (consumed.upstreamTerminalNegative) {
      await mintLifecycleFact({
        db,
        userId,
        memoryId: memory.memoryId,
        lifecycleType: "invalidation",
        targetStatus: "INVALIDATED",
        successorMemoryId: null,
        sourceIdentity: consumed.sourceIdentity,
        occurredAt: recordedAt,
        reasonCode: "UPSTREAM_TERMINAL_NEGATIVE",
      });
    } else if (initialStatus === "EXPIRED") {
      await mintLifecycleFact({
        db,
        userId,
        memoryId: memory.memoryId,
        lifecycleType: "expiry",
        targetStatus: "EXPIRED",
        successorMemoryId: null,
        sourceIdentity: null,
        occurredAt: recordedAt,
        reasonCode: "VALIDITY_WINDOW_ENDED",
      });
    }

    // 9. Dependency re-evaluation: upstream identities this record invalidates
    //    (e.g. a reversal outcome) mark dependent memory INVALIDATED.
    for (const invalidatedId of consumed.invalidatesUpstreamIdentities) {
      const dependents = await findMemoriesByUpstreamSubject(db, userId, parsed.businessId, invalidatedId);
      for (const dependent of dependents) {
        if (dependent.memoryId === memory.memoryId) continue;
        if (["SUPERSEDED", "CONTRADICTED", "INVALIDATED"].includes(dependent.factStatus)) continue;
        const inserted = await mintLifecycleFact({
          db,
          userId,
          memoryId: dependent.memoryId,
          lifecycleType: "invalidation",
          targetStatus: "INVALIDATED",
          successorMemoryId: memory.memoryId,
          sourceIdentity: consumed.sourceIdentity,
          occurredAt: recordedAt,
          reasonCode: "UPSTREAM_INVALIDATED",
        });
        if (inserted) {
          reevaluatedMemoryIds.push(dependent.memoryId);
          await applyStatusTransition({ db, userId, memoryId: dependent.memoryId, targetStatus: "INVALIDATED", occurredAt: recordedAt });
        }
      }
    }

    await emitMemoryAudit({ db, userId, businessId: parsed.businessId, memory });
  }

  return { memory, duplicateClassification: write.duplicateClassification, reevaluatedMemoryIds };
}

async function findMemoryByUpstreamIdentity(
  db: StrategicMemoryStoreExecutor,
  userId: number,
  businessId: number,
  sourceAuthority: string,
  sourceIdentity: string,
  memoryType: string
): Promise<StrategicMemoryRecordRow | null> {
  const candidates = await listMemories(userId, { businessId, sourceAuthority, limit: 100 }, db);
  return (
    candidates.find(
      (m) =>
        m.sourceIdentity === sourceIdentity &&
        m.memoryType === memoryType &&
        ["CURRENT", "STALE", "EXPIRED"].includes(m.factStatus)
    ) ?? null
  );
}

async function findMemoriesByUpstreamSubject(
  db: StrategicMemoryStoreExecutor,
  userId: number,
  businessId: number,
  upstreamIdentity: string
): Promise<StrategicMemoryRecordRow[]> {
  const candidates = await listMemories(userId, { businessId, limit: 500 }, db);
  return candidates.filter(
    (m) => m.subjectId === upstreamIdentity || (m.evidenceRefs as string[]).includes(upstreamIdentity)
  );
}

// ─── sweepExpiry (bounded tenant-scoped temporal materialization) ───

export interface SweepExpiryResult {
  expiredMemoryIds: string[];
}

/**
 * Materialize EXPIRED for memories whose validUntil has passed. Idempotent:
 * the EXPIRY fact is insert-first (deterministic smf1: identity), replays
 * converge, and the CAS transition swallows races. Sweep is the only
 * write-path here; it changes memory status only — never content.
 */
export async function sweepStrategicMemoryExpiry(
  executor: StrategicMemoryStoreExecutor | undefined,
  ctx: { userId: number },
  input: { businessId?: number },
  now: string
): Promise<SweepExpiryResult> {
  const userId = ctx.userId;
  const db = resolveStrategicMemoryDb(executor);
  const filters: { businessId?: number; limit?: number } = { limit: 500 };
  if (input.businessId !== undefined) {
    await assertBusinessOwnership(db, userId, input.businessId);
    filters.businessId = input.businessId;
  }
  const candidates = await listMemories(userId, filters, db);
  const expiredMemoryIds: string[] = [];
  for (const memory of candidates) {
    if (memory.validUntil === null || memory.validUntil === undefined) continue;
    if (Date.parse(memory.validUntil) >= Date.parse(now)) continue;
    if (["SUPERSEDED", "CONTRADICTED", "INVALIDATED"].includes(memory.factStatus)) continue;
    const inserted = await mintLifecycleFact({
      db,
      userId,
      memoryId: memory.memoryId,
      lifecycleType: "expiry",
      targetStatus: "EXPIRED",
      successorMemoryId: null,
      sourceIdentity: null,
      occurredAt: now,
      reasonCode: "VALIDITY_WINDOW_ENDED",
    });
    if (inserted) {
      expiredMemoryIds.push(memory.memoryId);
      await applyStatusTransition({ db, userId, memoryId: memory.memoryId, targetStatus: "EXPIRED", occurredAt: now });
    }
  }
  return { expiredMemoryIds };
}
