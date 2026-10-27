// ─── R6-E Conversion Tracking — ingest orchestration ───
//
// Orchestrates one conversion ingest: pure validation → server-derived trust
// → value validation → ownership re-verification → deterministic identity →
// insert-first persistence → reversal lifecycle effects → audit. Reversal rows
// and the target lifecycle update flow through the SAME executor and every
// step is idempotent (durable unique anchors + replay), so a crash/restart
// converges to one durable outcome. Emits no leads, no scores, no outreach.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  ConversionStateConflictError,
  type ConversionDuplicateClassification,
  type ConversionIngestInput,
  type ConversionOutcomeStatus,
  buildConversionInput,
} from "./conversion-contract";
import {
  buildLifecycleEventId,
  deriveConversionId,
  deriveConversionKey,
  deriveEvidenceHash,
  deriveLifecycleEventId,
} from "./conversion-identity";
import {
  deriveInitialOutcomeStatus,
  deriveTrustClass,
} from "./conversion-trust";
import {
  assertNoPaymentCredential,
  assertAmountCurrencyPair,
  validateConversionAmount,
  validateConversionCurrency,
} from "./conversion-value";
import {
  getConversionByConversionId,
  insertConversionEvent,
  insertLifecycleEvent,
  resolveConversionDb,
  transitionOutcomeStatus,
  type ConversionStoreExecutor,
} from "./conversion-store";
import { assertConversionOwnership, type ConversionOwnershipResult } from "./conversion-ownership";
import type {
  ConversionEventRow,
  InsertConversionEventRow,
  InsertConversionLifecycleEventRow,
} from "@db/schema";

/** Reversal conversion type → lifecycle fact minted on the target. */
const REVERSAL_LIFECYCLE_TYPE: Readonly<Record<string, string>> = {
  refund: "refund",
  cancellation: "cancellation",
  reversal: "reversal",
};

/** Reversal conversion type → target outcome status. */
const REVERSAL_TARGET_STATUS: Readonly<Record<string, ConversionOutcomeStatus>> = {
  refund: "REFUNDED",
  cancellation: "CANCELLED",
  reversal: "REVERSED",
};

export interface IngestConversionDeps {
  /**
   * Optional ownership-verifier override (tests may inject; production never
   * does). Defaults to the durable-row server-side verifier.
   */
  assertOwnership?: (
    db: ConversionStoreExecutor,
    userId: number,
    input: ConversionIngestInput
  ) => Promise<ConversionOwnershipResult>;
}

export interface IngestConversionResult {
  conversion: ConversionEventRow;
  duplicateClassification: ConversionDuplicateClassification;
}

const MAX_CAS_ATTEMPTS = 5;

async function applyReversalToTarget(args: {
  db: ConversionStoreExecutor;
  userId: number;
  reversal: ConversionEventRow;
  target: ConversionEventRow;
}): Promise<void> {
  const { db, userId, reversal, target } = args;
  const lifecycleType = REVERSAL_LIFECYCLE_TYPE[reversal.conversionType];
  const targetStatus = REVERSAL_TARGET_STATUS[reversal.conversionType];
  const amount = reversal.amount === null || reversal.amount === undefined ? null : Number(reversal.amount);
  const currency = reversal.currency ?? null;
  // The reversal's external conversion id IS the provider lifecycle id, so
  // provider reversal retries converge on cle_external_uidx.
  const externalLifecycleId = reversal.externalConversionId;

  const lifecycleRow: InsertConversionLifecycleEventRow = {
    lifecycleEventId: buildLifecycleEventId(
      deriveLifecycleEventId({
        conversionId: target.conversionId,
        lifecycleType,
        outcomeStatus: targetStatus,
        amount,
        currency,
        externalLifecycleId,
        occurredAt: reversal.occurredAt,
        reasonCode: null,
      })
    ),
    conversionId: target.conversionId,
    userId,
    lifecycleType,
    outcomeStatus: targetStatus,
    amount,
    currency,
    externalLifecycleId,
    occurredAt: reversal.occurredAt,
    reasonCode: null,
  };
  // Lifecycle insert-first: a reversal replay converges here before the CAS.
  await insertLifecycleEvent(lifecycleRow, db);

  // CAS the target to the mapped status; swallow a race only when the stored
  // status already equals the target (another writer won with the same fact).
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const fresh = await getConversionByConversionId(userId, target.conversionId, db);
    if (!fresh) {
      throw new ConversionStateConflictError(
        "CONVERSION_STALE_STATE",
        `reversal target ${target.conversionId} vanished during transition.`
      );
    }
    if (fresh.outcomeStatus === targetStatus) return;
    try {
      await transitionOutcomeStatus(userId, target.conversionId, Number(fresh.version), targetStatus, db);
      return;
    } catch (err) {
      if (err instanceof ConversionStateConflictError) continue; // re-read, retry
      throw err;
    }
  }
  throw new ConversionStateConflictError(
    "CONVERSION_STALE_STATE",
    `could not transition ${target.conversionId} to ${targetStatus} after ${MAX_CAS_ATTEMPTS} attempts.`
  );
}

async function emitConversionAudit(args: {
  db: ConversionStoreExecutor;
  userId: number;
  businessId: number;
  campaignId: number | null;
  conversion: ConversionEventRow;
}): Promise<void> {
  try {
    // Deterministic per durable conversion (occurredAt + id/class metadata
    // only): replays and concurrent losers reproduce the byte-identical
    // canonical event, so the fingerprint-deduped audit ledger converges to
    // exactly one conversion_recorded row per conversion.
    const event = createAuditEvent({
      eventType: "conversion_recorded",
      occurredAt: args.conversion.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      campaignId: args.campaignId,
      artifactId: args.conversion.conversionId,
      metadata: {
        conversionId: args.conversion.conversionId,
        businessId: args.businessId,
        sourceSystem: args.conversion.sourceSystem,
        conversionType: args.conversion.conversionType,
        trustClass: args.conversion.sourceTrustClass,
        outcomeStatus: args.conversion.outcomeStatus,
      },
    });
    await persistAuditEvent(event, args.db);
  } catch (err) {
    // Loud, retry-safe failure: the conversion stays durable; the audit ledger
    // is fingerprint-deduplicated so a later retry cannot duplicate it.
    console.error(
      `[Conversion] Failed to persist conversion_recorded audit event for ${args.conversion.conversionId}:`,
      (err as Error)?.message
    );
  }
}

/**
 * Ingest one conversion outcome. `now` is an explicit ISO 8601 string (no
 * clock here). Idempotent: retries/replays converge to the durable row and
 * re-apply reversal effects safely.
 */
export async function ingestConversion(
  executor: ConversionStoreExecutor | undefined,
  deps: IngestConversionDeps,
  ctx: { userId: number },
  input: unknown,
  now: string
): Promise<IngestConversionResult> {
  const userId = ctx.userId;
  const db = resolveConversionDb(executor);

  // 1. Pure validation (strict boundary + client-authority guard + timestamps).
  const parsed = buildConversionInput(input, now);

  // 2. Trust class is server-derived; the client can never supply it.
  const trustClass = deriveTrustClass(parsed.sourceSystem);

  // 3. Value validation (bounds, currency pair, credential leak guard).
  assertAmountCurrencyPair(parsed.amount ?? null, parsed.currency ?? null);
  if (parsed.amount !== undefined) {
    validateConversionAmount(parsed.amount, parsed.conversionType);
  }
  if (parsed.currency !== undefined) {
    validateConversionCurrency(parsed.currency);
  }
  assertNoPaymentCredential(parsed.externalConversionId, "externalConversionId");
  if (parsed.evidenceReference !== undefined) {
    assertNoPaymentCredential(parsed.evidenceReference, "evidenceReference");
  }

  // 4. Ownership re-verification from durable rows (fail closed).
  const assertOwnership = deps.assertOwnership ?? assertConversionOwnership;
  const { target } = await assertOwnership(db, userId, parsed);

  // 5. Deterministic identity + evidence hash; observedAt defaults to now.
  const observedAt = parsed.observedAt ?? now;
  const conversionId = deriveConversionId(
    deriveConversionKey({
      tenantUserId: userId,
      sourceSystem: parsed.sourceSystem,
      externalConversionId: parsed.externalConversionId,
    })
  );
  const evidenceHash = deriveEvidenceHash({
    userId,
    businessId: parsed.businessId,
    leadId: parsed.leadId ?? null,
    leadIdentityVersion: parsed.leadIdentityVersion ?? null,
    externalConversionId: parsed.externalConversionId,
    sourceSystem: parsed.sourceSystem,
    conversionType: parsed.conversionType,
    occurredAt: parsed.occurredAt,
    observedAt,
    amount: parsed.amount ?? null,
    currency: parsed.currency ?? null,
    sourceOpportunityId: parsed.sourceOpportunityId ?? null,
    sourceEngagementReceiptId: parsed.sourceEngagementReceiptId ?? null,
    sourceSignalId: parsed.sourceSignalId ?? null,
    sourceCampaignId: parsed.sourceCampaignId ?? null,
    sourcePublicationId: parsed.sourcePublicationId ?? null,
    evidenceReference: parsed.evidenceReference ?? null,
    reversesConversionId: parsed.reversesConversionId ?? null,
  });

  // 6. Initial outcome status is derived from the trust class.
  const outcomeStatus = deriveInitialOutcomeStatus(trustClass);

  const row: InsertConversionEventRow = {
    conversionId,
    userId,
    businessId: parsed.businessId,
    leadId: parsed.leadId ?? null,
    leadIdentityVersion: parsed.leadIdentityVersion ?? null,
    externalConversionId: parsed.externalConversionId,
    sourceSystem: parsed.sourceSystem,
    sourceTrustClass: trustClass,
    conversionType: parsed.conversionType,
    occurredAt: parsed.occurredAt,
    observedAt,
    amount: parsed.amount ?? null,
    currency: parsed.currency ?? null,
    outcomeStatus,
    reversesConversionId: parsed.reversesConversionId ?? null,
    sourceOpportunityId: parsed.sourceOpportunityId ?? null,
    sourceEngagementReceiptId: parsed.sourceEngagementReceiptId ?? null,
    sourceSignalId: parsed.sourceSignalId ?? null,
    sourceCampaignId: parsed.sourceCampaignId ?? null,
    sourcePublicationId: parsed.sourcePublicationId ?? null,
    evidenceReference: parsed.evidenceReference ?? null,
    evidenceHash,
    version: 1,
  };

  // 7. Insert-first persistence (retries/concurrency converge).
  const write = await insertConversionEvent(row, db);
  const conversion = write.row;

  // 8. Reversal effects: deterministic lifecycle on the target, then CAS.
  if (target) {
    await applyReversalToTarget({ db, userId, reversal: conversion, target });
  }

  // 9. Audit (ids/classes/hashes only — no PII). Failure is loud, never rolled back.
  await emitConversionAudit({
    db,
    userId,
    businessId: parsed.businessId,
    campaignId: parsed.sourceCampaignId ?? null,
    conversion,
  });

  return { conversion, duplicateClassification: write.duplicateClassification };
}
