// ─── R7-A Conversion Outcome Intelligence — record/verify orchestration ───
//
// Orchestrates business-outcome recording and verification: pure validation →
// server-side ownership re-verification → deterministic classification →
// evidence-authority derivation → value verification → deterministic identity
// → insert-first persistence → lineage effects (immutable facts + guarded CAS
// transitions) → deterministic audit. Every step is idempotent (durable unique
// anchors + replay), so a crash/restart converges to one durable outcome.
// Emits no leads, no conversions, no billing effects, no attribution.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  OutcomeInputError,
  OutcomeStateConflictError,
  type OutcomeDuplicateClassification,
  type OutcomeLifecycleType,
  type OutcomeRecordInput,
  type OutcomeStatus,
  type OutcomeVerifyInput,
  buildOutcomeRecordInput,
  buildOutcomeVerifyInput,
} from "./outcome-contract";
import { deriveEvidenceAuthority, deriveInitialOutcomeStatus, isValueAuthorityClass } from "./outcome-evidence";
import { classifyOutcomeType } from "./outcome-classification";
import {
  outcomeContainsPaymentCredential,
  validateOutcomeAmount,
  validateOutcomeCurrency,
  validateOutcomeMetric,
} from "./outcome-value";
import {
  buildOutcomeLifecycleEventId,
  deriveOutcomeEvidenceHash,
  deriveOutcomeId,
  deriveOutcomeKey,
  deriveOutcomeLifecycleKey,
} from "./outcome-identity";
import {
  isReversalOutcomeType,
  REVERSAL_LIFECYCLE_TYPE,
  REVERSAL_TARGET_STATUS,
} from "./outcome-lifecycle";
import {
  getOutcomeByOutcomeId,
  insertBusinessOutcome,
  insertOutcomeLifecycleEvent,
  resolveOutcomeDb,
  transitionOutcomeStatus,
  type OutcomeStoreExecutor,
} from "./outcome-store";
import { assertOutcomeOwnership, type OutcomeOwnershipResult } from "./outcome-ownership";
import type {
  BusinessOutcomeRow,
  InsertBusinessOutcomeRow,
  InsertBusinessOutcomeLifecycleEventRow,
} from "@db/schema";

const MAX_CAS_ATTEMPTS = 5;

export interface RecordOutcomeDeps {
  /**
   * Optional ownership-verifier override (tests may inject; production never
   * does). Defaults to the durable-row server-side verifier.
   */
  assertOwnership?: (
    db: OutcomeStoreExecutor,
    userId: number,
    input: OutcomeRecordInput
  ) => Promise<OutcomeOwnershipResult>;
}

export interface RecordOutcomeResult {
  outcome: BusinessOutcomeRow;
  duplicateClassification: OutcomeDuplicateClassification;
}

export interface VerifyOutcomeResult {
  outcome: BusinessOutcomeRow;
  duplicateClassification: OutcomeDuplicateClassification;
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitOutcomeAudit(args: {
  db: OutcomeStoreExecutor;
  userId: number;
  businessId: number;
  outcome: BusinessOutcomeRow;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "business_outcome_recorded",
      occurredAt: args.outcome.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.outcome.outcomeId,
      metadata: {
        outcomeId: args.outcome.outcomeId,
        businessId: args.businessId,
        conversionId: args.outcome.conversionId,
        outcomeType: args.outcome.outcomeType,
        outcomeStatus: args.outcome.outcomeStatus,
        valueType: args.outcome.valueType,
        evidenceAuthority: args.outcome.evidenceAuthority,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    // Loud, retry-safe failure: the outcome stays durable; the audit ledger
    // is fingerprint-deduplicated so a later retry cannot duplicate it.
    console.error(
      `[Outcome] Failed to persist business_outcome_recorded audit event for ${args.outcome.outcomeId}:`,
      (err as Error)?.message
    );
  }
}

async function emitOutcomeLifecycleAudit(args: {
  db: OutcomeStoreExecutor;
  userId: number;
  businessId: number;
  targetOutcomeId: string;
  lifecycleType: string;
  outcomeStatus: string;
  sourceOutcomeId: string | null;
  occurredAt: string;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: "business_outcome_lifecycle",
      occurredAt: args.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.targetOutcomeId,
      metadata: {
        outcomeId: args.targetOutcomeId,
        lifecycleType: args.lifecycleType,
        outcomeStatus: args.outcomeStatus,
        sourceOutcomeId: args.sourceOutcomeId,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    console.error(
      `[Outcome] Failed to persist business_outcome_lifecycle audit event for ${args.targetOutcomeId}:`,
      (err as Error)?.message
    );
  }
}

// ─── Lineage effects (immutable facts + guarded CAS transitions) ───

/**
 * Apply the lineage effects of a freshly recorded outcome: mint one
 * deterministic immutable lifecycle fact on the target outcome and CAS its
 * status. Replay-safe: fact insert converges first; the CAS swallows a race
 * only when the stored status already equals the post-fact status.
 */
async function applyLineageEffects(args: {
  db: OutcomeStoreExecutor;
  userId: number;
  businessId: number;
  outcome: BusinessOutcomeRow;
  target: BusinessOutcomeRow;
}): Promise<void> {
  const { db, userId, businessId, outcome, target } = args;

  const isReversal = outcome.reversesOutcomeId !== null && outcome.reversesOutcomeId !== undefined;
  const isRenewal = outcome.renewsOutcomeId !== null && outcome.renewsOutcomeId !== undefined;
  const isSupersession = outcome.supersedesOutcomeId !== null && outcome.supersedesOutcomeId !== undefined;

  let lifecycleType: OutcomeLifecycleType;
  let postFactStatus: OutcomeStatus;
  let amountMinor: number | null = null;
  let currency: string | null = null;

  if (isReversal) {
    lifecycleType = REVERSAL_LIFECYCLE_TYPE[outcome.outcomeType] as OutcomeLifecycleType;
    const fullStatus = REVERSAL_TARGET_STATUS[outcome.outcomeType];
    amountMinor = outcome.amountMinor === null || outcome.amountMinor === undefined ? null : Number(outcome.amountMinor);
    currency = outcome.currency ?? null;
    // Full reversal flips the target to its terminal reversal status; a partial
    // reversal leaves the target at its current (VERIFIED/PROVISIONAL/OBSERVED)
    // status with the fact recorded — net-value accounting is downstream's own
    // derivation.
    const targetAmount =
      target.amountMinor === null || target.amountMinor === undefined ? null : Number(target.amountMinor);
    const reversalFull =
      amountMinor !== null &&
      targetAmount !== null &&
      Math.abs(amountMinor) === Math.abs(targetAmount);
    postFactStatus = reversalFull ? fullStatus : (target.outcomeStatus as OutcomeStatus);
  } else if (isRenewal) {
    lifecycleType = "renewal";
    // A renewal is a new positive outcome, not a correction: the target keeps
    // its status; the fact records the renewed value for lineage.
    postFactStatus = target.outcomeStatus as OutcomeStatus;
    amountMinor = outcome.amountMinor === null || outcome.amountMinor === undefined ? null : Number(outcome.amountMinor);
    currency = outcome.currency ?? null;
  } else if (isSupersession) {
    lifecycleType = "supersession";
    postFactStatus = "SUPERSEDED";
  } else {
    return;
  }

  const factRow: InsertBusinessOutcomeLifecycleEventRow = {
    outcomeLifecycleEventId: buildOutcomeLifecycleEventId(
      deriveOutcomeLifecycleKey({
        outcomeId: target.outcomeId,
        lifecycleType,
        outcomeStatus: postFactStatus,
        amountMinor,
        currency,
        externalLifecycleId: outcome.evidenceIdentity,
        occurredAt: outcome.occurredAt,
        reasonCode: null,
      })
    ),
    outcomeId: target.outcomeId,
    userId,
    lifecycleType,
    outcomeStatus: postFactStatus,
    amountMinor,
    currency,
    externalLifecycleId: outcome.evidenceIdentity,
    occurredAt: outcome.occurredAt,
    reasonCode: null,
  };
  // Lifecycle insert-first: a replay of the same lineage effect converges here
  // before the CAS.
  const fact = await insertOutcomeLifecycleEvent(factRow, db);

  if (fact.inserted) {
    await emitOutcomeLifecycleAudit({
      db,
      userId,
      businessId,
      targetOutcomeId: target.outcomeId,
      lifecycleType,
      outcomeStatus: postFactStatus,
      sourceOutcomeId: outcome.outcomeId,
      occurredAt: outcome.occurredAt,
    });
  }

  if (postFactStatus === target.outcomeStatus) {
    return; // e.g. partial reversal / renewal: status unchanged.
  }
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const fresh = await getOutcomeByOutcomeId(userId, target.outcomeId, db);
    if (!fresh) {
      throw new OutcomeStateConflictError(
        "OUTCOME_STALE_STATE",
        `lineage target ${target.outcomeId} vanished during transition.`
      );
    }
    if (fresh.outcomeStatus === postFactStatus) return;
    try {
      await transitionOutcomeStatus(userId, target.outcomeId, Number(fresh.version), postFactStatus, db);
      return;
    } catch (err) {
      if (err instanceof OutcomeStateConflictError) continue; // re-read, retry
      throw err;
    }
  }
  throw new OutcomeStateConflictError(
    "OUTCOME_STALE_STATE",
    `could not transition ${target.outcomeId} to ${postFactStatus} after ${MAX_CAS_ATTEMPTS} attempts.`
  );
}

// ─── record ───

/**
 * Record one business outcome from a canonical R6-E conversion. `now` is an
 * explicit ISO 8601 string (no clock here). Idempotent: retries/replays
 * converge to the durable row and re-apply lineage effects safely.
 */
export async function recordOutcome(
  executor: OutcomeStoreExecutor | undefined,
  deps: RecordOutcomeDeps,
  ctx: { userId: number },
  input: unknown,
  now: string
): Promise<RecordOutcomeResult> {
  const userId = ctx.userId;
  const db = resolveOutcomeDb(executor);

  // 1. Pure validation (strict boundary + client-authority guard + timestamps
  //    + value-shape + lineage exclusivity).
  const parsed = buildOutcomeRecordInput(input, now);

  // 2. Credential leak guard on the evidence identity (bounded reference only).
  if (outcomeContainsPaymentCredential(parsed.evidenceIdentity)) {
    throw new OutcomeInputError(
      "OUTCOME_PAYMENT_CREDENTIAL_REJECTED",
      "evidenceIdentity contains a payment-credential-shaped digit run and must never be persisted."
    );
  }

  // 3. Ownership re-verification from durable rows (fail closed): business,
  //    canonical conversion, lead binding, stale-evidence check, R6-E amount
  //    revalidation, lineage target.
  const assertOwnership = deps.assertOwnership ?? assertOutcomeOwnership;
  const { conversion, target } = await assertOwnership(db, userId, parsed);

  // 4. Deterministic, rule-first classification (no model authority).
  const outcomeType = classifyOutcomeType(conversion.conversionType, parsed.outcomeTypeProposal);

  // 5. Lineage family consistency: reversal types require reversal lineage and
  //    reversal lineage requires reversal types; renewals require RENEWAL type.
  const hasReversalLineage = parsed.reversesOutcomeId !== undefined;
  const typeIsReversal = isReversalOutcomeType(outcomeType);
  if (typeIsReversal && !hasReversalLineage) {
    throw new OutcomeInputError(
      "OUTCOME_REVERSAL_TARGET_REQUIRED",
      `outcome type ${outcomeType} requires reversesOutcomeId.`
    );
  }
  if (!typeIsReversal && hasReversalLineage) {
    throw new OutcomeInputError(
      "OUTCOME_LINEAGE_INVALID",
      `reversesOutcomeId is only permitted for reversal outcome types (REFUND, REVERSAL, CANCELLATION); classified type is ${outcomeType}.`
    );
  }
  if (parsed.renewsOutcomeId !== undefined && outcomeType !== "RENEWAL") {
    throw new OutcomeInputError(
      "OUTCOME_LINEAGE_INVALID",
      `renewsOutcomeId requires outcome type RENEWAL; classified type is ${outcomeType}.`
    );
  }
  if (parsed.supersedesOutcomeId !== undefined && typeIsReversal) {
    throw new OutcomeInputError(
      "OUTCOME_LINEAGE_INVALID",
      "reversal outcome types cannot supersede another outcome."
    );
  }

  // 6. Value verification with the classified type (bounds, currency, polarity,
  //    metric shape).
  if (parsed.valueType === "MONETARY") {
    validateOutcomeAmount(parsed.amountMinor!, outcomeType);
    validateOutcomeCurrency(parsed.currency!);
  } else {
    validateOutcomeMetric(parsed.quantity!, parsed.metricUnit!);
  }

  // 7. Evidence authority and initial status are server-derived only.
  const evidenceAuthority = deriveEvidenceAuthority(parsed.evidenceSource);
  const outcomeStatus = deriveInitialOutcomeStatus(evidenceAuthority);

  // 8. Deterministic identity + immutable-core evidence hash.
  const recordedAt = parsed.recordedAt ?? now;
  const outcomeId = deriveOutcomeId(
    deriveOutcomeKey({
      tenantUserId: userId,
      businessId: parsed.businessId,
      conversionId: parsed.conversionId,
      evidenceSource: parsed.evidenceSource,
      evidenceIdentity: parsed.evidenceIdentity,
    })
  );
  const leadId = conversion.leadId === null || conversion.leadId === undefined ? null : Number(conversion.leadId);
  const evidenceHash = deriveOutcomeEvidenceHash({
    userId,
    businessId: parsed.businessId,
    leadId,
    leadIdentityVersion: conversion.leadIdentityVersion ?? null,
    conversionId: parsed.conversionId,
    outcomeType,
    valueType: parsed.valueType,
    amountMinor: parsed.valueType === "MONETARY" ? parsed.amountMinor! : null,
    currency: parsed.valueType === "MONETARY" ? parsed.currency! : null,
    quantity: parsed.valueType === "NON_MONETARY" ? parsed.quantity! : null,
    metricUnit: parsed.valueType === "NON_MONETARY" ? parsed.metricUnit! : null,
    evidenceSource: parsed.evidenceSource,
    evidenceAuthority,
    evidenceIdentity: parsed.evidenceIdentity,
    occurredAt: parsed.occurredAt,
    recordedAt,
    reversesOutcomeId: parsed.reversesOutcomeId ?? null,
    renewsOutcomeId: parsed.renewsOutcomeId ?? null,
    supersedesOutcomeId: parsed.supersedesOutcomeId ?? null,
  });

  const row: InsertBusinessOutcomeRow = {
    outcomeId,
    userId,
    businessId: parsed.businessId,
    leadId,
    leadIdentityVersion: conversion.leadIdentityVersion ?? null,
    conversionId: parsed.conversionId,
    outcomeType,
    outcomeStatus,
    valueType: parsed.valueType,
    amountMinor: parsed.valueType === "MONETARY" ? parsed.amountMinor! : null,
    currency: parsed.valueType === "MONETARY" ? parsed.currency! : null,
    quantity: parsed.valueType === "NON_MONETARY" ? parsed.quantity! : null,
    metricUnit: parsed.valueType === "NON_MONETARY" ? parsed.metricUnit! : null,
    evidenceSource: parsed.evidenceSource,
    evidenceAuthority,
    evidenceIdentity: parsed.evidenceIdentity,
    evidenceHash,
    occurredAt: parsed.occurredAt,
    recordedAt,
    reversesOutcomeId: parsed.reversesOutcomeId ?? null,
    renewsOutcomeId: parsed.renewsOutcomeId ?? null,
    supersedesOutcomeId: parsed.supersedesOutcomeId ?? null,
    version: 1,
  };

  // 9. Insert-first persistence (retries/concurrency converge).
  const write = await insertBusinessOutcome(row, db);
  const outcome = write.row;

  // 10. Lineage effects: deterministic immutable fact + guarded CAS transition.
  if (target) {
    await applyLineageEffects({ db, userId, businessId: parsed.businessId, outcome, target });
  }

  // 11. Audit: exactly one recorded event per inserted outcome; convergence
  // paths emit zero.
  if (write.inserted) {
    await emitOutcomeAudit({ db, userId, businessId: parsed.businessId, outcome });
  }

  return { outcome, duplicateClassification: write.duplicateClassification };
}

// ─── verify ───

/**
 * Governed verification transition (OBSERVED/PROVISIONAL → VERIFIED) bound to
 * corroborating authoritative evidence. `now` is explicit ISO 8601. The
 * corroborating evidence authority must be a VERIFIED_* class: user attestation
 * and unverified external evidence can never verify (acceptance: agent/client
 * cannot force VERIFIED). The transition mints one deterministic verification
 * fact, CAS-guarded; replays converge.
 */
export async function verifyOutcome(
  executor: OutcomeStoreExecutor | undefined,
  ctx: { userId: number },
  input: unknown,
  now: string
): Promise<VerifyOutcomeResult> {
  const userId = ctx.userId;
  const db = resolveOutcomeDb(executor);

  // 1. Pure validation (strict boundary + client-authority guard).
  const parsed: OutcomeVerifyInput = buildOutcomeVerifyInput(input, now);

  // 2. Credential leak guard.
  if (outcomeContainsPaymentCredential(parsed.evidenceIdentity)) {
    throw new OutcomeInputError(
      "OUTCOME_PAYMENT_CREDENTIAL_REJECTED",
      "evidenceIdentity contains a payment-credential-shaped digit run and must never be persisted."
    );
  }

  // 3. Corroborating evidence authority must be authoritative.
  const authority = deriveEvidenceAuthority(parsed.evidenceSource);
  if (!isValueAuthorityClass(authority)) {
    throw new OutcomeInputError(
      "OUTCOME_VERIFICATION_AUTHORITY_INVALID",
      `evidence source "${parsed.evidenceSource}" (${authority}) cannot verify an outcome; an authoritative VERIFIED_* evidence source is required.`
    );
  }

  // 4. Load the outcome (tenant-scoped).
  const outcome = await getOutcomeByOutcomeId(userId, parsed.outcomeId, db);
  if (!outcome) {
    throw new OutcomeInputError("FORBIDDEN", "Outcome not found for the authenticated user.");
  }

  // 5. Legal transition only (VERIFIED → VERIFIED and terminal states reject).
  if (outcome.outcomeStatus !== "OBSERVED" && outcome.outcomeStatus !== "PROVISIONAL") {
    throw new OutcomeStateConflictError(
      "OUTCOME_TRANSITION_INVALID",
      `outcome ${parsed.outcomeId} is in status ${outcome.outcomeStatus}; only OBSERVED or PROVISIONAL outcomes may be verified.`
    );
  }

  // 6. Deterministic verification fact (replay converges on the same id).
  const occurredAt = parsed.occurredAt ?? now;
  const amountMinor = outcome.amountMinor === null || outcome.amountMinor === undefined ? null : Number(outcome.amountMinor);
  const currency = outcome.currency ?? null;
  const factRow: InsertBusinessOutcomeLifecycleEventRow = {
    outcomeLifecycleEventId: buildOutcomeLifecycleEventId(
      deriveOutcomeLifecycleKey({
        outcomeId: outcome.outcomeId,
        lifecycleType: "verification",
        outcomeStatus: "VERIFIED",
        amountMinor,
        currency,
        externalLifecycleId: parsed.externalLifecycleId ?? null,
        occurredAt,
        reasonCode: null,
      })
    ),
    outcomeId: outcome.outcomeId,
    userId,
    lifecycleType: "verification",
    outcomeStatus: "VERIFIED",
    amountMinor,
    currency,
    externalLifecycleId: parsed.externalLifecycleId ?? null,
    occurredAt,
    reasonCode: null,
  };
  const fact = await insertOutcomeLifecycleEvent(factRow, db);

  if (fact.inserted) {
    await emitOutcomeLifecycleAudit({
      db,
      userId,
      businessId: Number(outcome.businessId),
      targetOutcomeId: outcome.outcomeId,
      lifecycleType: "verification",
      outcomeStatus: "VERIFIED",
      sourceOutcomeId: null,
      occurredAt,
    });
  }

  // 7. CAS transition to VERIFIED; swallow a race only when already verified.
  let current = outcome;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    if (current.outcomeStatus === "VERIFIED") {
      return { outcome: current, duplicateClassification: fact.duplicateClassification };
    }
    try {
      current = await transitionOutcomeStatus(userId, outcome.outcomeId, Number(current.version), "VERIFIED", db);
      return { outcome: current, duplicateClassification: fact.duplicateClassification };
    } catch (err) {
      if (err instanceof OutcomeStateConflictError) {
        const fresh = await getOutcomeByOutcomeId(userId, outcome.outcomeId, db);
        if (!fresh) throw err;
        current = fresh;
        continue;
      }
      throw err;
    }
  }
  throw new OutcomeStateConflictError(
    "OUTCOME_STALE_STATE",
    `could not verify ${outcome.outcomeId} after ${MAX_CAS_ATTEMPTS} attempts.`
  );
}
