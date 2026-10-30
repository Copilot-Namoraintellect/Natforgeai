// ─── R8-B Business Change Intelligence — detection orchestration ───
//
// Orchestrates business-change detection: pure validation → server-side
// ownership re-verification → governed new-state loading (upstream seam) or
// operator attestation derivation → previous-state resolution through the
// read-only R8-A memory seam (pointer re-load) → deterministic comparison
// (detection rules) → identity + immutable-core hash → significance/confidence
// (server-derived, confidence-capped) → insert-first persistence → lineage
// effects (confirmation / contradiction / supersession facts + guarded CAS) →
// deterministic audit. Every step is idempotent (durable unique anchors +
// replay), so a crash/restart converges to one durable change. Emits no
// strategy, no budget, no memory writes, no execution authority of any kind.

import { and, eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  BUSINESS_CHANGE_SOURCE_VERSIONS,
  BUSINESS_CHANGE_SUBJECT_DOMAIN,
  BusinessChangeInputError,
  BusinessChangeOwnershipError,
  BusinessChangeStateConflictError,
  buildBusinessChangeAttestInput,
  buildBusinessChangeCorrectInput,
  buildBusinessChangeEvaluateInput,
  type BusinessChangeAttestInput,
  type BusinessChangeConfidenceClass,
  type BusinessChangeCorrectInput,
  type BusinessChangeDuplicateClassification,
  type BusinessChangeEvaluateInput,
} from "./business-change-contract";
import {
  NO_MEMORY_SENTINEL,
  buildChangeLifecycleEventId,
  deriveChangeEvidenceHash,
  deriveChangeId,
  deriveChangeKey,
  deriveChangeLifecycleKey,
  deriveStateFingerprint,
  deriveStateValueFingerprint,
  type BusinessChangeStateRef,
} from "./business-change-identity";
import {
  buildObjectiveStateView,
  detectChange,
  type ChangeStateView,
} from "./business-change-detection";
import {
  classifySignificance,
  deriveSignificanceDimensions,
} from "./business-change-significance";
import {
  loadNewChangeState,
  loadPreviousChangeState,
  type ConsumedChangeState,
} from "./business-change-upstream-seam";
import {
  createBusinessChangeMemoryPort,
  type BusinessChangeMemoryPort,
} from "./business-change-memory-seam";
import { canTransitionChangeStatus } from "./business-change-temporal";
import {
  getChangeByChangeId,
  insertBusinessChangeLifecycleEvent,
  insertBusinessChangeEvent,
  listChanges,
  listChangeLifecycleEvents,
  transitionChangeStatus,
  type BusinessChangeStoreExecutor,
  resolveBusinessChangeDb,
} from "./business-change-store";
import type {
  BusinessChangeEventRow,
  InsertBusinessChangeEventRow,
  InsertBusinessChangeLifecycleEventRow,
} from "@db/schema";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

const MAX_CAS_ATTEMPTS = 5;

export interface BusinessChangeServiceDeps {
  /** Injectable memory port (production reads R8-A; tests inject fakes). */
  memoryPort?: BusinessChangeMemoryPort;
}

export interface EvaluateBusinessChangeResult {
  change: BusinessChangeEventRow | null;
  duplicateClassification: BusinessChangeDuplicateClassification;
  /** True when this observation corroborated an existing change (new confirmation fact). */
  corroborated: boolean;
  /** Changes re-evaluated as a side effect (contradicted predecessors). */
  affectedChangeIds: string[];
}

export interface SweepBusinessChangeExpiryResult {
  expiredChangeIds: string[];
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitChangeAudit(args: {
  db: BusinessChangeStoreExecutor;
  userId: number;
  businessId: number;
  change: BusinessChangeEventRow;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "business_change_detected",
      occurredAt: args.change.recordedAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.change.changeId,
      metadata: {
        changeId: args.change.changeId,
        businessId: args.businessId,
        changeDomain: args.change.changeDomain,
        changeType: args.change.changeType,
        subjectType: args.change.subjectType,
        subjectId: args.change.subjectId,
        significanceClass: args.change.significanceClass,
        confidenceClass: args.change.confidenceClass,
        status: args.change.status,
        sourceAuthority: args.change.sourceAuthority,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[BusinessChange] Failed to persist business_change_detected audit event for ${args.change.changeId}:`,
      (err as Error)?.message
    );
  }
}

async function emitChangeLifecycleAudit(args: {
  db: BusinessChangeStoreExecutor;
  userId: number;
  changeId: string;
  lifecycleType: string;
  targetStatus: string;
  successorChangeId: string | null;
  occurredAt: string;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "business_change_lifecycle",
      occurredAt: args.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      artifactId: args.changeId,
      metadata: {
        changeId: args.changeId,
        lifecycleType: args.lifecycleType,
        targetStatus: args.targetStatus,
        successorChangeId: args.successorChangeId,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[BusinessChange] Failed to persist business_change_lifecycle audit event for ${args.changeId}:`,
      (err as Error)?.message
    );
  }
}

// ─── Server-side ownership re-verification (fail closed) ───

async function assertBusinessOwnership(
  db: BusinessChangeStoreExecutor,
  userId: number,
  businessId: number
): Promise<void> {
  const [row] = (await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1)) as unknown as Array<{ id: number; userId: number }>;
  if (!row) {
    throw new BusinessChangeOwnershipError("FORBIDDEN", `Business ${businessId} not found for the authenticated user.`);
  }
}

// ─── Lifecycle facts + guarded CAS transitions ───

async function mintLifecycleFact(args: {
  db: BusinessChangeStoreExecutor;
  userId: number;
  changeId: string;
  lifecycleType: "confirmation" | "contradiction" | "supersession" | "invalidation" | "expiry" | "reaffirmation";
  targetStatus: string;
  successorChangeId: string | null;
  sourceIdentity: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): Promise<boolean> {
  const { db, userId, changeId, lifecycleType, targetStatus, successorChangeId, sourceIdentity, occurredAt, reasonCode } = args;
  const factRow: InsertBusinessChangeLifecycleEventRow = {
    changeLifecycleEventId: buildChangeLifecycleEventId(
      deriveChangeLifecycleKey({ changeId, lifecycleType, targetStatus, successorChangeId, sourceIdentity, occurredAt, reasonCode })
    ),
    changeId,
    userId,
    lifecycleType,
    targetStatus,
    successorChangeId,
    sourceIdentity,
    occurredAt,
    reasonCode,
  };
  const fact = await insertBusinessChangeLifecycleEvent(factRow, db);
  if (fact.inserted) {
    await emitChangeLifecycleAudit({ db, userId, changeId, lifecycleType, targetStatus, successorChangeId, occurredAt });
  }
  return fact.inserted;
}

async function applyStatusTransition(args: {
  db: BusinessChangeStoreExecutor;
  userId: number;
  changeId: string;
  targetStatus: string;
  occurredAt: string;
}): Promise<void> {
  const { db, userId, changeId, targetStatus } = args;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const fresh = await getChangeByChangeId(userId, changeId, db);
    if (!fresh) {
      throw new BusinessChangeStateConflictError("CHANGE_STALE_STATE", `change ${changeId} vanished during transition.`);
    }
    if (fresh.status === targetStatus) return;
    if (!canTransitionChangeStatus(fresh.status, targetStatus)) {
      throw new BusinessChangeStateConflictError(
        "CHANGE_TRANSITION_INVALID",
        `change ${changeId} cannot transition from ${fresh.status} to ${targetStatus}.`
      );
    }
    try {
      await transitionChangeStatus(userId, changeId, Number(fresh.version), targetStatus, db);
      return;
    } catch (err) {
      if (err instanceof BusinessChangeStateConflictError) continue; // re-read, retry
      throw err;
    }
  }
  throw new BusinessChangeStateConflictError(
    "CHANGE_STALE_STATE",
    `could not transition ${changeId} to ${targetStatus} after ${MAX_CAS_ATTEMPTS} attempts.`
  );
}

// ─── Previous-state resolution (R8-A read-only memory binding, B6) ───

interface ResolvedPreviousState {
  view: ChangeStateView;
  ref: BusinessChangeStateRef;
  /** True when the comparison anchor was an ASSUMPTION (caps confidence). */
  assumptionAnchored: boolean;
}

async function resolvePreviousState(args: {
  db: BusinessChangeStoreExecutor;
  memoryPort: BusinessChangeMemoryPort;
  userId: number;
  businessId: number;
  subjectType: BusinessChangeEvaluateInput["subjectType"] | "OBJECTIVE";
  subjectId: string;
}): Promise<ResolvedPreviousState> {
  const { db, memoryPort, userId, businessId, subjectType, subjectId } = args;
  const memory = await memoryPort.getCurrentMemoryForSubject(userId, businessId, subjectType, subjectId);
  if (!memory) {
    throw new BusinessChangeInputError(
      "CHANGE_PREVIOUS_STATE_MISSING",
      `No current strategic memory anchors subject ${subjectType}:${subjectId}; change detection refuses to run without an authoritative before-state.`
    );
  }
  if (memory.sourceAuthority === "operator_attestation") {
    // Statement-resident state: the memory statement itself is the compared
    // state (objective text attestation).
    const statement = (memory.statement ?? {}) as { text?: unknown; fields?: unknown };
    const text = typeof statement.text === "string" ? statement.text : (statement.fields as Record<string, unknown> | undefined)?.objectiveText;
    const view = buildObjectiveStateView(text);
    const fp = deriveStateFingerprint({
      authority: memory.sourceAuthority,
      identity: memory.sourceIdentity,
      version: memory.sourceVersion,
      template: view.template,
      fields: view.fields,
    });
    return {
      view,
      assumptionAnchored: memory.statementType === "ASSUMPTION",
      ref: {
        authority: memory.sourceAuthority,
        memoryId: memory.memoryId,
        sourceIdentity: memory.sourceIdentity,
        sourceVersion: memory.sourceVersion,
        statementType: memory.statementType,
        stateFingerprint: fp,
      },
    };
  }
  // Pointer-resident state: re-load the immutable upstream row the memory
  // binds, and build the identical closed state view the new-state loader
  // produces (same normalisation ⇒ representation-only drift can never mint
  // a change).
  const previous = await loadPreviousChangeState(userId, businessId, subjectType, memory.sourceAuthority, memory.sourceIdentity, db);
  if (previous.subjectId !== subjectId) {
    throw new BusinessChangeInputError(
      "CHANGE_COMPARISON_STATE_MISSING",
      `Memory pointer ${memory.sourceIdentity} resolves to subject ${previous.subjectId}, not ${subjectId}; refusing a cross-subject comparison.`
    );
  }
  const fp = deriveStateFingerprint({
    authority: memory.sourceAuthority,
    identity: memory.sourceIdentity,
    version: memory.sourceVersion,
    template: previous.view.template,
    fields: previous.view.fields,
  });
  return {
    view: previous.view,
    assumptionAnchored: memory.statementType === "ASSUMPTION",
    ref: {
      authority: memory.sourceAuthority,
      memoryId: memory.memoryId,
      sourceIdentity: memory.sourceIdentity,
      sourceVersion: memory.sourceVersion,
      statementType: memory.statementType,
      stateFingerprint: fp,
    },
  };
}

/** Cap derived confidence when the comparison anchor was an ASSUMPTION. */
function capConfidenceForAnchor(confidence: BusinessChangeConfidenceClass, assumptionAnchored: boolean): BusinessChangeConfidenceClass {
  if (!assumptionAnchored) return confidence;
  if (confidence === "AUTHORITATIVE" || confidence === "VERIFIED") return "PROVISIONAL";
  return confidence;
}

function buildCurrentRef(consumed: ConsumedChangeState): { ref: BusinessChangeStateRef; fingerprint: string } {
  const fp = deriveStateFingerprint({
    authority: consumed.sourceAuthority,
    identity: consumed.sourceIdentity,
    version: consumed.sourceVersion,
    template: consumed.view.template,
    fields: consumed.view.fields,
  });
  return {
    fingerprint: fp,
    ref: {
      authority: consumed.sourceAuthority,
      memoryId: NO_MEMORY_SENTINEL,
      sourceIdentity: consumed.sourceIdentity,
      sourceVersion: consumed.sourceVersion,
      statementType: "FACT",
      stateFingerprint: fp,
    },
  };
}

// ─── Shared persistence (insert-first + confirmation + contradiction) ───

async function persistDetectedChange(args: {
  db: BusinessChangeStoreExecutor;
  userId: number;
  businessId: number;
  subjectType: string;
  subjectId: string;
  changeDomain: string;
  changeType: string;
  previousRef: BusinessChangeStateRef;
  currentRef: BusinessChangeStateRef;
  currentFingerprint: string;
  previousValueFingerprint: string;
  currentValueFingerprint: string;
  evidenceRefs: string[];
  sourceAuthority: string;
  sourceVersion: string;
  confidenceClass: BusinessChangeConfidenceClass;
  significanceInput: {
    changeType: string;
    budgetDeltaMinor?: number | null;
    setChangeCount?: number | null;
    previousApprovedTotalMinor?: number | null;
    ordinalDistance?: number | null;
  };
  detectedAt: string;
  effectiveAt: string;
  recordedAt: string;
  supersedesChangeId: string | null;
  limitations: string[];
  initialStatus: "DETECTED" | "PROVISIONAL";
  contradictScan: boolean;
}): Promise<EvaluateBusinessChangeResult> {
  const { db, userId, businessId } = args;
  const significanceClass = classifySignificance(
    deriveSignificanceDimensions({
      subjectType: args.subjectType as never,
      changeType: args.significanceInput.changeType as never,
      budgetDeltaMinor: args.significanceInput.budgetDeltaMinor ?? null,
      setChangeCount: args.significanceInput.setChangeCount ?? null,
      previousApprovedTotalMinor: args.significanceInput.previousApprovedTotalMinor ?? null,
      ordinalDistance: args.significanceInput.ordinalDistance ?? null,
    }),
    args.confidenceClass
  );
  const changeKey = deriveChangeKey({
    tenantUserId: userId,
    businessId,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    changeType: args.changeType,
    previousStateFingerprint: args.previousRef.stateFingerprint,
    currentStateFingerprint: args.currentFingerprint,
  });
  const changeId = deriveChangeId(changeKey);
  const evidenceHash = deriveChangeEvidenceHash({
    userId,
    businessId,
    changeDomain: args.changeDomain,
    changeType: args.changeType,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    previousStateRef: args.previousRef,
    currentStateRef: args.currentRef,
    evidenceRefs: args.evidenceRefs,
    sourceAuthority: args.sourceAuthority,
    sourceVersion: args.sourceVersion,
    significanceClass,
    confidenceClass: args.confidenceClass,
    supersedesChangeId: args.supersedesChangeId,
    limitations: args.limitations,
  });

  const row: InsertBusinessChangeEventRow = {
    changeId,
    userId,
    businessId,
    changeDomain: args.changeDomain,
    changeType: args.changeType,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    previousStateRef: args.previousRef as never,
    currentStateRef: args.currentRef as never,
    previousStateFingerprint: args.previousRef.stateFingerprint,
    currentStateFingerprint: args.currentFingerprint,
    previousStateValueFingerprint: args.previousValueFingerprint,
    currentStateValueFingerprint: args.currentValueFingerprint,
    evidenceRefs: args.evidenceRefs,
    sourceAuthority: args.sourceAuthority,
    sourceVersion: args.sourceVersion,
    significanceClass,
    confidenceClass: args.confidenceClass,
    status: args.initialStatus,
    detectedAt: args.detectedAt,
    effectiveAt: args.effectiveAt,
    recordedAt: args.recordedAt,
    validUntil: null,
    supersedesChangeId: args.supersedesChangeId,
    limitations: args.limitations,
    evidenceHash,
    version: 1,
  };

  const write = await insertBusinessChangeEvent(row, db);
  const affectedChangeIds: string[] = [];

  if (write.inserted) {
    // Revert/contradiction scan: an active change on the same subject whose
    // compared VALUES are exactly swapped (canonical value fingerprints —
    // version-independent) is contradicted by this new change (the world
    // reverted); both rows persist and the conflict stays visible.
    if (args.contradictScan) {
      const siblings = await listChanges(
        userId,
        { businessId, subjectType: args.subjectType, subjectId: args.subjectId, limit: 100 },
        db
      );
      for (const sibling of siblings) {
        if (sibling.changeId === changeId) continue;
        if (!["DETECTED", "CONFIRMED", "PROVISIONAL"].includes(sibling.status)) continue;
        if (sibling.previousStateValueFingerprint !== args.currentValueFingerprint) continue;
        if (sibling.currentStateValueFingerprint !== args.previousValueFingerprint) continue;
        const inserted = await mintLifecycleFact({
          db,
          userId,
          changeId: sibling.changeId,
          lifecycleType: "contradiction",
          targetStatus: "CONTRADICTED",
          successorChangeId: changeId,
          sourceIdentity: args.currentRef.sourceIdentity,
          occurredAt: args.recordedAt,
          reasonCode: "REVERTED_BY_NEWER_COMPARISON",
        });
        if (inserted || sibling.status !== "CONTRADICTED") {
          await applyStatusTransition({ db, userId, changeId: sibling.changeId, targetStatus: "CONTRADICTED", occurredAt: args.recordedAt });
          affectedChangeIds.push(sibling.changeId);
        }
      }
    }
    await emitChangeAudit({ db, userId, businessId, change: write.row });
    return { change: write.row, duplicateClassification: "none", corroborated: false, affectedChangeIds };
  }

  if (write.duplicateClassification === "corroborating_replay") {
    // Independent corroboration: same compared states from a different
    // source authority. Exactly one confirmation fact; CAS to CONFIRMED.
    const existing = write.row;
    const facts = await listChangeLifecycleEvents(userId, existing.changeId, db);
    if (!facts.some((f) => f.lifecycleType === "confirmation")) {
      await mintLifecycleFact({
        db,
        userId,
        changeId: existing.changeId,
        lifecycleType: "confirmation",
        targetStatus: "CONFIRMED",
        successorChangeId: null,
        sourceIdentity: args.currentRef.sourceIdentity,
        occurredAt: args.recordedAt,
        reasonCode: "CORROBORATED_BY_INDEPENDENT_SOURCE",
      });
      await applyStatusTransition({ db, userId, changeId: existing.changeId, targetStatus: "CONFIRMED", occurredAt: args.recordedAt });
      const refreshed = await getChangeByChangeId(userId, existing.changeId, db);
      return { change: refreshed ?? existing, duplicateClassification: "corroborating_replay", corroborated: true, affectedChangeIds };
    }
    return { change: existing, duplicateClassification: "corroborating_replay", corroborated: false, affectedChangeIds };
  }

  return { change: write.row, duplicateClassification: "idempotent_replay", corroborated: false, affectedChangeIds };
}

// ─── evaluate (governed new-state path) ───

/**
 * Evaluate one governed new-state observation against the current R8-A
 * memory anchor for the subject. Idempotent; corroboration/contradiction
 * lineage effects are insert-first and replay-safe.
 */
export async function evaluateBusinessChange(
  executor: BusinessChangeStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string,
  deps: BusinessChangeServiceDeps = {}
): Promise<EvaluateBusinessChangeResult> {
  const userId = ctx.userId;
  const db = resolveBusinessChangeDb(executor);
  const parsed: BusinessChangeEvaluateInput = buildBusinessChangeEvaluateInput(input, now);
  await assertBusinessOwnership(db, userId, parsed.businessId);

  const consumed = await loadNewChangeState(userId, parsed.businessId, parsed.subjectType, parsed.sourceAuthority, parsed.sourceIdentity, db);
  if (consumed.subjectId !== parsed.subjectId) {
    throw new BusinessChangeInputError(
      "CHANGE_SUBJECT_SOURCE_MISMATCH",
      `source ${parsed.sourceAuthority}:${parsed.sourceIdentity} resolves to subject ${consumed.subjectId}, not ${parsed.subjectId}.`
    );
  }

  const memoryPort = deps.memoryPort ?? createBusinessChangeMemoryPort(now);
  const previous = await resolvePreviousState({
    db,
    memoryPort,
    userId,
    businessId: parsed.businessId,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
  });

  const detected = detectChange({ subjectType: parsed.subjectType, previous: previous.view, current: consumed.view });
  if (!detected) {
    return { change: null, duplicateClassification: "none", corroborated: false, affectedChangeIds: [] };
  }

  const confidence = capConfidenceForAnchor(consumed.confidenceClass, previous.assumptionAnchored);
  const { ref: currentRef, fingerprint: currentFingerprint } = buildCurrentRef(consumed);
  const changeDomain = BUSINESS_CHANGE_SUBJECT_DOMAIN[parsed.subjectType];
  const recordedAt = parsed.recordedAt ?? now;
  const effectiveAt = parsed.observedAt ?? consumed.observedAt;

  return persistDetectedChange({
    db,
    userId,
    businessId: parsed.businessId,
    subjectType: parsed.subjectType,
    subjectId: parsed.subjectId,
    changeDomain,
    changeType: detected.changeType,
    previousRef: previous.ref,
    currentRef,
    currentFingerprint,
    previousValueFingerprint: deriveStateValueFingerprint(previous.view.template, previous.view.fields),
    currentValueFingerprint: deriveStateValueFingerprint(consumed.view.template, consumed.view.fields),
    evidenceRefs: consumed.evidenceRefs,
    sourceAuthority: consumed.sourceAuthority,
    sourceVersion: consumed.sourceVersion,
    confidenceClass: confidence,
    significanceInput: {
      changeType: detected.changeType,
      budgetDeltaMinor: detected.budgetDeltaMinor,
      setChangeCount: detected.setChangeCount,
      previousApprovedTotalMinor:
        previous.view.template === "BUDGET_ENVELOPE_STATE" ? Number(previous.view.fields.approvedTotalMinor ?? 0) : null,
      ordinalDistance: detected.ordinalDistance,
    },
    detectedAt: now,
    effectiveAt,
    recordedAt,
    supersedesChangeId: null,
    limitations: [
      "Change evidence is a deterministic before/after comparison of authoritative states; it asserts detection, not causation, and is not a recommendation.",
      consumed.upstreamTerminalNegative
        ? "The new-state upstream row is currently terminal-negative (e.g. contradicted); treat this change as review-oriented."
        : "Derived from governed upstream evidence loaded server-side.",
    ],
    initialStatus: "DETECTED",
    contradictScan: true,
  });
}

// ─── attest (operator-attested new-state path, OBJECTIVE subject) ───

function deriveAttestationCoordinates(input: {
  tenantUserId: number;
  businessId: number;
  subjectType: string;
  subjectId: string;
  objectiveText: string;
}): string {
  return `att1:${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      objectiveText: input.objectiveText,
    })
  )}`;
}

/**
 * Evaluate one operator-attested observation (bounded, protected-trait
 * scanned, untrusted content) against the current memory anchor. Operator
 * evidence is PROVISIONAL by construction — it can never mint a CONFIRMED
 * change and its significance is confidence-capped.
 */
export async function attestBusinessChange(
  executor: BusinessChangeStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string,
  deps: BusinessChangeServiceDeps = {}
): Promise<EvaluateBusinessChangeResult> {
  const userId = ctx.userId;
  const db = resolveBusinessChangeDb(executor);
  const parsed: BusinessChangeAttestInput = buildBusinessChangeAttestInput(input, now);
  await assertBusinessOwnership(db, userId, parsed.businessId);

  const memoryPort = deps.memoryPort ?? createBusinessChangeMemoryPort(now);
  const previous = await resolvePreviousState({
    db,
    memoryPort,
    userId,
    businessId: parsed.businessId,
    subjectType: "OBJECTIVE",
    subjectId: parsed.subjectId,
  });

  const currentView = buildObjectiveStateView(parsed.observedState.objectiveText ?? "");
  const detected = detectChange({ subjectType: "OBJECTIVE", previous: previous.view, current: currentView });
  if (!detected) {
    return { change: null, duplicateClassification: "none", corroborated: false, affectedChangeIds: [] };
  }

  const objectiveText = String(currentView.fields.objectiveText ?? "");
  const coordinates = deriveAttestationCoordinates({
    tenantUserId: userId,
    businessId: parsed.businessId,
    subjectType: "OBJECTIVE",
    subjectId: parsed.subjectId,
    objectiveText,
  });
  const currentFingerprint = deriveStateFingerprint({
    authority: "operator_attestation",
    identity: coordinates,
    version: BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation,
    template: currentView.template,
    fields: currentView.fields,
  });
  const currentRef: BusinessChangeStateRef = {
    authority: "operator_attestation",
    memoryId: NO_MEMORY_SENTINEL,
    sourceIdentity: coordinates,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation,
    statementType: "FACT",
    stateFingerprint: currentFingerprint,
  };
  const confidence: BusinessChangeConfidenceClass =
    parsed.basis.basisType === "PENDING_VERIFICATION" ? "UNVERIFIED" : "PROVISIONAL";
  const recordedAt = parsed.recordedAt ?? now;
  const effectiveAt = parsed.observedAt ?? recordedAt;

  return persistDetectedChange({
    db,
    userId,
    businessId: parsed.businessId,
    subjectType: "OBJECTIVE",
    subjectId: parsed.subjectId,
    changeDomain: "BUSINESS_OBJECTIVE",
    changeType: detected.changeType,
    previousRef: previous.ref,
    currentRef,
    currentFingerprint,
    previousValueFingerprint: deriveStateValueFingerprint(previous.view.template, previous.view.fields),
    currentValueFingerprint: deriveStateValueFingerprint(currentView.template, currentView.fields),
    evidenceRefs: [coordinates],
    sourceAuthority: "operator_attestation",
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation,
    confidenceClass: confidence,
    significanceInput: { changeType: detected.changeType },
    detectedAt: now,
    effectiveAt,
    recordedAt,
    supersedesChangeId: null,
    limitations: [
      ...parsed.limitations,
      "Operator-attested observation (untrusted bounded content); PROVISIONAL by construction — confirmation requires independent governed-source corroboration.",
    ],
    initialStatus: "PROVISIONAL",
    contradictScan: true,
  });
}

// ─── correct (superseding correction, B5/B9.18) ───

/**
 * Correct a prior change: re-load the corrected current state for the same
 * subject, compare against the SAME previous-state anchor, and mint a
 * successor change bound by supersedesChangeId. The predecessor is
 * CAS-transitioned to SUPERSEDED with one immutable supersession fact —
 * history is never edited. Replaying the correction converges; correcting
 * with identical material is an idempotent replay of the successor.
 */
export async function correctBusinessChange(
  executor: BusinessChangeStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string,
  deps: BusinessChangeServiceDeps = {}
): Promise<EvaluateBusinessChangeResult> {
  const userId = ctx.userId;
  const db = resolveBusinessChangeDb(executor);
  const parsed: BusinessChangeCorrectInput = buildBusinessChangeCorrectInput(input, now);

  const original = await getChangeByChangeId(userId, parsed.changeId, db);
  if (!original) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `change ${parsed.changeId} not found for the authenticated tenant.`);
  }
  if (!["DETECTED", "CONFIRMED", "PROVISIONAL"].includes(original.status)) {
    throw new BusinessChangeStateConflictError(
      "CHANGE_TRANSITION_INVALID",
      `change ${parsed.changeId} is ${original.status}; only active changes can be corrected (corrections are new rows, never edits).`
    );
  }
  const subjectType = original.subjectType as BusinessChangeEvaluateInput["subjectType"] | "OBJECTIVE";
  const businessId = Number(original.businessId);
  await assertBusinessOwnership(db, userId, businessId);
  if (subjectType === "OBJECTIVE" && parsed.sourceAuthority !== "operator_attestation") {
    throw new BusinessChangeInputError(
      "CHANGE_SUBJECT_SOURCE_MISMATCH",
      `subjectType OBJECTIVE consumes operator_attestation only; got ${parsed.sourceAuthority}.`
    );
  }

  // Rebuild the previous-state anchor exactly as the original change bound it.
  const memoryPort = deps.memoryPort ?? createBusinessChangeMemoryPort(now);
  const previous = await resolvePreviousState({
    db,
    memoryPort,
    userId,
    businessId,
    subjectType,
    subjectId: original.subjectId,
  });
  if (previous.ref.stateFingerprint !== original.previousStateFingerprint) {
    throw new BusinessChangeInputError(
      "CHANGE_STATE_FINGERPRINT_CONFLICT",
      "The previous-state anchor no longer reproduces the original change's bound fingerprint; refusing to build a correction on drifted ground."
    );
  }

  // Load the corrected current state.
  let currentView: ChangeStateView;
  let currentRef: BusinessChangeStateRef;
  let currentFingerprint: string;
  let evidenceRefs: string[];
  let sourceVersion: string;
  let confidence: BusinessChangeConfidenceClass;
  if (parsed.sourceAuthority === "operator_attestation") {
    currentView = buildObjectiveStateView(parsed.observedState?.objectiveText ?? "");
    const objectiveText = String(currentView.fields.objectiveText ?? "");
    const coordinates = deriveAttestationCoordinates({
      tenantUserId: userId,
      businessId: businessId,
      subjectType,
      subjectId: original.subjectId,
      objectiveText,
    });
    currentFingerprint = deriveStateFingerprint({
      authority: "operator_attestation",
      identity: coordinates,
      version: BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation,
      template: currentView.template,
      fields: currentView.fields,
    });
    currentRef = {
      authority: "operator_attestation",
      memoryId: NO_MEMORY_SENTINEL,
      sourceIdentity: coordinates,
      sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation,
      statementType: "FACT",
      stateFingerprint: currentFingerprint,
    };
    evidenceRefs = [coordinates];
    sourceVersion = BUSINESS_CHANGE_SOURCE_VERSIONS.operator_attestation;
    confidence = "PROVISIONAL";
  } else {
    const consumed = await loadNewChangeState(userId, businessId, subjectType, parsed.sourceAuthority, parsed.sourceIdentity ?? "", db);
    if (consumed.subjectId !== original.subjectId) {
      throw new BusinessChangeInputError(
        "CHANGE_SUBJECT_SOURCE_MISMATCH",
        `Corrected source resolves to subject ${consumed.subjectId}, not ${original.subjectId}.`
      );
    }
    currentView = consumed.view;
    const built = buildCurrentRef(consumed);
    currentRef = built.ref;
    currentFingerprint = built.fingerprint;
    evidenceRefs = consumed.evidenceRefs;
    sourceVersion = consumed.sourceVersion;
    confidence = capConfidenceForAnchor(consumed.confidenceClass, previous.assumptionAnchored);
  }

  const detected = detectChange({ subjectType, previous: previous.view, current: currentView });
  if (!detected) {
    // Corrected state equals the previous anchor — the correction retracts
    // the change. The original is contradicted (revert), not superseded.
    return { change: null, duplicateClassification: "none", corroborated: false, affectedChangeIds: [] };
  }
  if (
    currentFingerprint === original.currentStateFingerprint &&
    detected.changeType === original.changeType
  ) {
    // Correction reproduces the original change exactly — idempotent replay.
    return { change: original, duplicateClassification: "idempotent_replay", corroborated: false, affectedChangeIds: [] };
  }

  const recordedAt = parsed.recordedAt ?? now;
  const result = await persistDetectedChange({
    db,
    userId,
    businessId,
    subjectType,
    subjectId: original.subjectId,
    changeDomain: original.changeDomain,
    changeType: detected.changeType,
    previousRef: previous.ref,
    currentRef,
    currentFingerprint,
    previousValueFingerprint: deriveStateValueFingerprint(previous.view.template, previous.view.fields),
    currentValueFingerprint: deriveStateValueFingerprint(currentView.template, currentView.fields),
    evidenceRefs,
    sourceAuthority: parsed.sourceAuthority,
    sourceVersion,
    confidenceClass: confidence,
    significanceInput: {
      changeType: detected.changeType,
      budgetDeltaMinor: detected.budgetDeltaMinor,
      setChangeCount: detected.setChangeCount,
      previousApprovedTotalMinor:
        previous.view.template === "BUDGET_ENVELOPE_STATE" ? Number(previous.view.fields.approvedTotalMinor ?? 0) : null,
      ordinalDistance: detected.ordinalDistance,
    },
    detectedAt: now,
    effectiveAt: parsed.observedAt ?? recordedAt,
    recordedAt,
    supersedesChangeId: original.changeId,
    limitations: [...(original.limitations as string[])],
    initialStatus: parsed.sourceAuthority === "operator_attestation" ? "PROVISIONAL" : "DETECTED",
    contradictScan: false,
  });

  if (result.change && result.duplicateClassification === "none") {
    const inserted = await mintLifecycleFact({
      db,
      userId,
      changeId: original.changeId,
      lifecycleType: "supersession",
      targetStatus: "SUPERSEDED",
      successorChangeId: result.change.changeId,
      sourceIdentity: currentRef.sourceIdentity,
      occurredAt: recordedAt,
      reasonCode: "CORRECTED_BY_NEWER_COMPARISON",
    });
    if (inserted || original.status !== "SUPERSEDED") {
      await applyStatusTransition({ db, userId, changeId: original.changeId, targetStatus: "SUPERSEDED", occurredAt: recordedAt });
    }
    result.affectedChangeIds.push(original.changeId);
  }

  return result;
}

// ─── sweepExpiry (bounded tenant-scoped temporal materialization) ───

/**
 * Materialize EXPIRED for changes whose validUntil has passed. Idempotent:
 * the EXPIRY fact is insert-first (deterministic bcl1: identity), replays
 * converge, and the CAS transition swallows races. Sweep changes status only
 * — never content.
 */
export async function sweepBusinessChangeExpiry(
  executor: BusinessChangeStoreExecutor | undefined,
  ctx: { userId: number },
  input: { businessId?: number },
  now: string
): Promise<SweepBusinessChangeExpiryResult> {
  const userId = ctx.userId;
  const db = resolveBusinessChangeDb(executor);
  const filters: { businessId?: number; limit?: number } = { limit: 500 };
  if (input.businessId !== undefined) {
    await assertBusinessOwnership(db, userId, input.businessId);
    filters.businessId = input.businessId;
  }
  const candidates = await listChanges(userId, filters, db);
  const expiredChangeIds: string[] = [];
  for (const change of candidates) {
    if (change.validUntil === null || change.validUntil === undefined) continue;
    if (Date.parse(change.validUntil) >= Date.parse(now)) continue;
    if (["SUPERSEDED", "CONTRADICTED", "INVALIDATED"].includes(change.status)) continue;
    const inserted = await mintLifecycleFact({
      db,
      userId,
      changeId: change.changeId,
      lifecycleType: "expiry",
      targetStatus: "EXPIRED",
      successorChangeId: null,
      sourceIdentity: null,
      occurredAt: now,
      reasonCode: "VALIDITY_WINDOW_ENDED",
    });
    if (inserted) {
      expiredChangeIds.push(change.changeId);
      await applyStatusTransition({ db, userId, changeId: change.changeId, targetStatus: "EXPIRED", occurredAt: now });
    }
  }
  return { expiredChangeIds };
}
