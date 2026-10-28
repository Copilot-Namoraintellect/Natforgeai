// ─── R7-B Attribution Intelligence — service orchestration ───
//
// The deterministic evaluation pipeline: strict boundary → outcome authority
// (frozen R7-A seam) → server-side gates (terminal outcome, business
// ownership, privacy stop) → window derivation → score-mediated lead chain →
// journey reconstruction → closed-model credit allocation → evidence
// classification → deterministic identity → insert-first exact-once
// persistence → supersession lineage → deterministic audit. No LLM, no
// client authority, no upstream mutation. `now` is always explicit (no clock
// in this module).

import { and, eq } from "drizzle-orm";
import { businesses, leadPrivacyStates } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  ATTRIBUTION_MODEL_VERSIONS,
  ATTRIBUTION_PRIVACY_STOP_STATE_SET,
  ATTRIBUTION_TERMINAL_OUTCOME_STATUS_SET,
  AttributionOwnershipError,
  AttributionStateError,
  type AttributionEvaluateInput,
  type AttributionModelType,
  type AttributionSourceVersions,
  buildAttributionInput,
  canonicalJson,
  sha256Hex,
  type AttributionDuplicateClassification,
} from "./attribution-contract";
import { deriveAttributionKey, deriveJourneyHash, deriveRecordHash, toAttributionId } from "./attribution-identity";
import { assertModelAllowed, resolveAttributionPolicy } from "./attribution-policy";
import { deriveAttributionWindow, parseTimestampMs } from "./attribution-window";
import { reconstructJourney } from "./attribution-journey";
import { gatherJourneySources, resolveLeadChain, type JourneyStoreExecutor } from "./attribution-journey-store";
import { applyAttributionModel } from "./attribution-models";
import { classifyEvidence, confidenceForEvidence } from "./attribution-evidence";
import { createOutcomeAuthorityPort, type OutcomeAuthorityPort } from "./attribution-outcome-seam";
import {
  findSupersedeTarget,
  insertAttributionLifecycleEvent,
  insertAttributionResult,
  type AttributionStoreExecutor,
} from "./attribution-store";
import { buildAttributionLearningProjection } from "./attribution-projection";
import type { AttributionResultRow, InsertAttributionResultRow } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import type { AuditDbExecutor } from "../audit/audit-store";

export interface AttributionServiceDeps {
  readonly outcomeAuthority?: OutcomeAuthorityPort;
}

type Executor = JourneyStoreExecutor & AttributionStoreExecutor & Partial<AuditDbExecutor>;

const ATTRIBUTION_IDEMPOTENT_MESSAGE = "Attribution evaluation converged to the durable result (idempotent_replay).";

export interface EvaluateAttributionResult {
  readonly result: AttributionResultRow;
  readonly duplicateClassification: AttributionDuplicateClassification;
  readonly projection: ReturnType<typeof buildAttributionLearningProjection>;
}

async function emitAttributionAudit(args: {
  db: Partial<AuditDbExecutor>;
  userId: number;
  businessId: number;
  result: AttributionResultRow;
  eventType: "attribution_calculated" | "attribution_superseded";
  extra?: Record<string, unknown>;
  occurredAt: string;
}): Promise<void> {
  try {
    const event = createAuditEvent({
      eventType: args.eventType,
      occurredAt: args.occurredAt,
      userId: args.userId,
      source: "system",
      outcome: "succeeded",
      businessId: args.businessId,
      artifactId: args.result.attributionId,
      metadata: {
        attributionId: args.result.attributionId,
        outcomeId: args.result.outcomeId,
        conversionId: args.result.conversionId,
        modelType: args.result.modelType,
        modelVersion: args.result.modelVersion,
        evidenceClass: args.result.evidenceClass,
        confidenceClass: args.result.confidenceClass,
        totalCreditBps: Number(args.result.totalCreditBps),
        journeyHash: args.result.journeyHash,
        ...args.extra,
      },
    });
    await persistAuditEvent(event, args.db as never);
  } catch (err) {
    // Loud, retry-safe failure: the attribution stays durable; the
    // fingerprint-deduped ledger cannot duplicate the event on retry.
    console.error(
      `[Attribution] Failed to persist ${args.eventType} audit event for ${args.result.attributionId}:`,
      (err as Error)?.message
    );
  }
}

async function verifyBusinessOwnership(
  db: Executor,
  userId: number,
  businessId: number
): Promise<void> {
  const [row] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);
  if (!row) {
    throw new AttributionOwnershipError(
      "OWNERSHIP_MISMATCH",
      `Business ${businessId} is not owned by the authenticated tenant.`
    );
  }
}

async function assertPrivacyNotStopped(db: Executor, userId: number, leadId: number | null): Promise<void> {
  if (leadId === null) return;
  const [row] = await db
    .select({ privacyState: leadPrivacyStates.privacyState })
    .from(leadPrivacyStates)
    .where(and(eq(leadPrivacyStates.userId, userId), eq(leadPrivacyStates.leadId, leadId)))
    .orderBy(leadPrivacyStates.id)
    .limit(1);
  if (row && ATTRIBUTION_PRIVACY_STOP_STATE_SET.has(row.privacyState)) {
    throw new AttributionStateError(
      "ATTRIBUTION_PRIVACY_BLOCKED",
      `Lead ${leadId} privacy state ${row.privacyState} blocks attribution evaluation.`
    );
  }
}

interface PreparedAttribution {
  readonly row: InsertAttributionResultRow;
  readonly identity: { attributionId: string; attributionKey: string };
  readonly sourceVersions: AttributionSourceVersions;
}

/**
 * Run the deterministic evaluation pipeline up to (but not including)
 * persistence. Shared by evaluate (full pipeline) and the supersession paths.
 */
async function prepareAttribution(input: {
  db: Executor;
  deps: AttributionServiceDeps;
  userId: number;
  parsed: AttributionEvaluateInput;
  now: string;
  forcedZeroCredit: boolean;
  zeroCreditReason: string | null;
}): Promise<PreparedAttribution> {
  const { db, userId, parsed, now } = input;
  const policy = resolveAttributionPolicy();
  assertModelAllowed(parsed.modelType, policy);
  const modelVersion = ATTRIBUTION_MODEL_VERSIONS[parsed.modelType as AttributionModelType];
  const nowMs = Date.parse(now);

  const outcomePort = input.deps.outcomeAuthority ?? createOutcomeAuthorityPort();
  const outcome = await outcomePort.getOutcomeForAttribution(userId, parsed.outcomeId);
  if (!outcome) {
    // Never reveal outcome existence across tenants/businesses.
    throw new AttributionOwnershipError("FORBIDDEN", "Outcome not found for the authenticated tenant.");
  }

  // Terminal outcomes never receive a NEW positive evaluation. The
  // forced-zero-credit supersession path (synchronize on reversal) passes this
  // gate by design: it mints a zero-credit successor, never positive credit.
  if (!input.forcedZeroCredit && ATTRIBUTION_TERMINAL_OUTCOME_STATUS_SET.has(outcome.outcomeStatus)) {
    throw new AttributionStateError(
      "ATTRIBUTION_OUTCOME_NOT_ATTRIBUTABLE",
      `Outcome ${outcome.outcomeId} is in terminal state ${outcome.outcomeStatus}; no active positive attribution may be minted.`
    );
  }

  const window = deriveAttributionWindow(outcome.occurredAt, policy.windowDays, nowMs);
  const outcomeOccurredAtMs = parseTimestampMs(outcome.occurredAt)!;

  await verifyBusinessOwnership(db, userId, outcome.businessId);
  await assertPrivacyNotStopped(db, userId, outcome.leadId);

  const chain = await resolveLeadChain(userId, outcome.leadId, db);
  const sources = await gatherJourneySources({
    userId,
    conversionId: outcome.conversionId,
    validatedLids: chain.validatedLids,
    executor: db,
  });

  const journey = reconstructJourney({
    outcomeBusinessId: outcome.businessId,
    outcomeOccurredAtMs,
    window,
    validatedLids: chain.validatedLids,
    leadChainValidated: chain.leadChainValidated,
    futureSkewMs: policy.futureSkewMs,
    nowMs,
    sources,
  });

  const eligible = input.forcedZeroCredit ? [] : journey.eligible;
  const excluded = journey.excluded;
  const credited = input.forcedZeroCredit
    ? []
    : applyAttributionModel({
        modelType: parsed.modelType as AttributionModelType,
        touchpoints: eligible,
        windowEndMs: window.windowEndMs,
      });
  const totalCreditBps = credited.reduce((sum, t) => sum + t.creditBps, 0);

  const evidenceClass = input.forcedZeroCredit
    ? "INSUFFICIENT_EVIDENCE"
    : classifyEvidence({
        outcomeStatus: outcome.outcomeStatus,
        eligible: credited,
        excluded,
        leadChainValidated: chain.leadChainValidated,
        provisionalAllowed: policy.allowProvisionalOutcomes,
      });
  const confidenceClass = confidenceForEvidence(evidenceClass);

  const journeyHash = deriveJourneyHash(credited);
  const sourceVersions: AttributionSourceVersions = {
    outcomeProjectionVersion: "conversion-outcome/v1",
    conversionProjectionVersion: "conversion-to-attribution/v1",
    attributionContractVersion: "attribution/v1",
    policyVersion: policy.policyVersion,
  };

  const attributionKey = deriveAttributionKey({
    tenantUserId: userId,
    businessId: outcome.businessId,
    outcomeId: outcome.outcomeId,
    modelType: parsed.modelType,
    modelVersion,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    journeyHash,
    totalCreditBps,
    confidenceClass,
    evidenceClass,
    outcomeStatus: outcome.outcomeStatus,
    policyVersion: policy.policyVersion,
  });
  const attributionId = toAttributionId(attributionKey);

  const partialRow = {
    attributionId,
    attributionKey,
    userId,
    businessId: outcome.businessId,
    outcomeId: outcome.outcomeId,
    leadId: outcome.leadId,
    leadIdentityVersion: outcome.leadIdentityVersion,
    conversionId: outcome.conversionId,
    outcomeType: outcome.outcomeType,
    outcomeStatus: outcome.outcomeStatus,
    outcomeAmountMinor: outcome.amountMinor,
    outcomeCurrency: outcome.currency,
    modelType: parsed.modelType,
    modelVersion,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    journeyHash,
    touchpoints: credited,
    excludedTouchpoints: excluded,
    totalCreditBps,
    confidenceClass,
    evidenceClass,
    policyVersion: policy.policyVersion,
    sourceVersions,
    supersedesAttributionId: null as string | null,
    calculatedAt: now,
  };

  return { row: partialRow as InsertAttributionResultRow, identity: { attributionId, attributionKey }, sourceVersions };
}

/**
 * Evaluate one attribution. Idempotent: identical replays and concurrent
 * duplicates converge to the single durable result (`idempotent_replay`);
 * new evidence, model/policy change, or outcome lifecycle change mints a new
 * supersession-linked result. History is never overwritten.
 */
export async function evaluateAttribution(
  executor: Executor | undefined,
  deps: AttributionServiceDeps,
  ctx: { userId: number },
  rawInput: unknown,
  now: string
): Promise<EvaluateAttributionResult> {
  const db = (executor ?? getDb()) as Executor;
  const userId = ctx.userId;
  const parsed = buildAttributionInput(rawInput);

  const prepared = await prepareAttribution({
    db,
    deps,
    userId,
    parsed,
    now,
    forcedZeroCredit: false,
    zeroCreditReason: null,
  });

  // Supersession link: the active chain head for this outcome + model +
  // version (excluding the row being calculated) is superseded by the new
  // result. The exclusion keeps replay lineage byte-identical (convergence).
  const target = await findSupersedeTarget(
    userId,
    prepared.row.outcomeId,
    prepared.row.modelType,
    prepared.row.modelVersion,
    prepared.identity.attributionId,
    db
  );
  const supersedes = target && target.attributionId !== prepared.identity.attributionId
    ? target.attributionId
    : null;

  const recordHash = deriveRecordHash({ ...prepared.row, supersedesAttributionId: supersedes } as never);
  const finalRow = { ...prepared.row, supersedesAttributionId: supersedes } as InsertAttributionResultRow;

  const write = await insertAttributionResult({ ...finalRow, recordHash }, db);

  if (write.inserted) {
    if (supersedes) {
      const lifecycleEventId =
        "atf1:" +
        sha256Hex(
          canonicalJson({
            v: 1,
            attributionId: prepared.identity.attributionId,
            priorAttributionId: supersedes,
            userId,
            lifecycleType: "supersession",
            occurredAt: prepared.row.calculatedAt,
          })
        );
      await insertAttributionLifecycleEvent(
        {
          attributionLifecycleEventId: lifecycleEventId,
          attributionId: prepared.identity.attributionId,
          priorAttributionId: supersedes,
          userId,
          lifecycleType: "supersession",
          occurredAt: prepared.row.calculatedAt,
        },
        db
      );
      await emitAttributionAudit({
        db,
        userId,
        businessId: prepared.row.businessId,
        result: write.row,
        eventType: "attribution_superseded",
        extra: { priorAttributionId: supersedes, reason: "evidence_or_policy_change" },
        occurredAt: prepared.row.calculatedAt,
      });
    }
    await emitAttributionAudit({
      db,
      userId,
      businessId: prepared.row.businessId,
      result: write.row,
      eventType: "attribution_calculated",
      occurredAt: prepared.row.calculatedAt,
    });
  }

  return {
    result: write.row,
    duplicateClassification: write.duplicateClassification,
    projection: buildAttributionLearningProjection(write.row),
  };
}

/**
 * Synchronize attributions after an outcome lifecycle change. If the outcome
 * reversed/cancelled/superseded, any active positive attribution is replaced
 * by a zero-credit successor (history preserved, nothing overwritten). If the
 * outcome is attributable, a fresh evaluation supersedes stale state through
 * the normal pipeline.
 */
export async function synchronizeAttribution(
  executor: Executor | undefined,
  deps: AttributionServiceDeps,
  ctx: { userId: number },
  rawInput: unknown,
  now: string
): Promise<EvaluateAttributionResult> {
  const db = (executor ?? getDb()) as Executor;
  const userId = ctx.userId;
  const parsed = buildAttributionInput(rawInput);

  const outcomePort = deps.outcomeAuthority ?? createOutcomeAuthorityPort();
  const outcome = await outcomePort.getOutcomeForAttribution(userId, parsed.outcomeId);
  if (!outcome) {
    throw new AttributionOwnershipError("FORBIDDEN", "Outcome not found for the authenticated tenant.");
  }

  const terminal = ATTRIBUTION_TERMINAL_OUTCOME_STATUS_SET.has(outcome.outcomeStatus);
  if (!terminal) {
    // Attributable outcome: normal evaluation (supersedes via natural flow).
    return evaluateAttribution(executor, deps, ctx, rawInput, now);
  }

  // Prepare the zero-credit successor first (no side effects) so its
  // deterministic identity can drive the supersession-target lookup.
  const prepared = await prepareAttribution({
    db,
    deps,
    userId,
    parsed,
    now,
    forcedZeroCredit: true,
    zeroCreditReason: `outcome_${outcome.outcomeStatus.toLowerCase()}`,
  });

  const modelVersion = ATTRIBUTION_MODEL_VERSIONS[parsed.modelType as AttributionModelType];
  const target = await findSupersedeTarget(
    userId,
    outcome.outcomeId,
    parsed.modelType,
    modelVersion,
    prepared.identity.attributionId,
    db
  );
  if (!target) {
    // Nothing active to retire.
    throw new AttributionStateError(
      "ATTRIBUTION_OUTCOME_NOT_ATTRIBUTABLE",
      `Outcome ${outcome.outcomeId} is in terminal state ${outcome.outcomeStatus} and has no active attribution.`
    );
  }
  if (target.attributionId === prepared.identity.attributionId || Number(target.totalCreditBps) === 0) {
    // Already retired (by this exact zero-credit row or an equivalent one):
    // converge without minting anything new.
    return {
      result: target,
      duplicateClassification: "idempotent_replay",
      projection: buildAttributionLearningProjection(target),
    };
  }

  // Mint the zero-credit successor that retires the misleading active credit.
  const supersedes = target.attributionId;
  const recordHash = deriveRecordHash({ ...prepared.row, supersedesAttributionId: supersedes } as never);
  const finalRow = { ...prepared.row, supersedesAttributionId: supersedes } as InsertAttributionResultRow;
  const write = await insertAttributionResult({ ...finalRow, recordHash }, db);

  if (write.inserted) {
    const lifecycleEventId =
      "atf1:" +
      sha256Hex(
        canonicalJson({
          v: 1,
          attributionId: prepared.identity.attributionId,
          priorAttributionId: supersedes,
          userId,
          lifecycleType: "supersession",
          occurredAt: prepared.row.calculatedAt,
        })
      );
    await insertAttributionLifecycleEvent(
      {
        attributionLifecycleEventId: lifecycleEventId,
        attributionId: prepared.identity.attributionId,
        priorAttributionId: supersedes,
        userId,
        lifecycleType: "supersession",
        occurredAt: prepared.row.calculatedAt,
      },
      db
    );
    await emitAttributionAudit({
      db,
      userId,
      businessId: prepared.row.businessId,
      result: write.row,
      eventType: "attribution_superseded",
      extra: { priorAttributionId: supersedes, reason: `outcome_${outcome.outcomeStatus.toLowerCase()}` },
      occurredAt: prepared.row.calculatedAt,
    });
  }

  return {
    result: write.row,
    duplicateClassification: write.duplicateClassification,
    projection: buildAttributionLearningProjection(write.row),
  };
}

export { ATTRIBUTION_IDEMPOTENT_MESSAGE };
