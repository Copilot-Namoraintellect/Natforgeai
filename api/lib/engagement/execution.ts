/**
 * Exact-Once Engagement Execution (WBS-R5-C3/C6/C7).
 *
 * The governed execution engine. Every external engagement effect flows
 * through here at most once:
 *
 * - POLICY GATE (C3): the R5-E `assertMarketingActionExecutable` verdict is
 *   the only execution authority, re-asserted at execution time against the
 *   CURRENT policy version and the durable approval binding. DENY / ESCALATE
 *   / NO_ACTION never execute; REQUIRE_APPROVAL without the exact bound
 *   approval never executes; stale policy/context/expired bindings fail
 *   closed. No policy rule lives in this file.
 * - EXACT-ONCE (C6): the DB is the only authority — unique actionRequestId on
 *   executions, unique executionId / providerOperationIdentity on receipts,
 *   and a conditional-claim lease for single-writer concurrency. Ambiguous
 *   provider outcomes are NEVER blindly resent: the reconciler probes the
 *   provider by operation identity first. Crash windows resolve through the
 *   disposition resolver + reconciler, never through in-memory state.
 * - RECEIPTS (C7): one immutable receipt per execution, carrying the full
 *   lineage identity set and a bounded provider acknowledgement. No provider
 *   tokens, no raw social text — opaque references only.
 *
 * Billing: the R5-E billing identity authorizes the reservation
 * (reservationReference = billingIdentity, unique per user); settlement
 * happens only on confirmed external success; transient/permanent failures
 * release the hold; ambiguous outcomes release the hold too (the settlement
 * itself is keyed deterministically, so a reconciled success still charges
 * exactly once). Denied / escalated / no-action paths never reach this
 * engine and are non-billable.
 */

import { createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  approvalRequests,
  socialIntegrations,
  engagementResponseContents,
} from "@db/schema";
import { decryptToken } from "../crypto";
import {
  reserveWalletCredits,
  settleWalletCredits,
  releaseWalletCredits,
} from "../billing/credit-reservation-engine";
import { createAuditEvent, type AuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import { getDecisionById } from "../policy/policy-decision-store";
import type { PolicyDecision } from "../policy/decision-engine";
import { getActivePolicy } from "../policy/policy-store";
import {
  assertMarketingActionExecutable,
  type MarketingActionExecutionVerdict,
} from "../policy/marketing-action-approval";
import {
  getExecutionByActionRequest,
  getExecutionById,
  getReceiptByExecutionId,
  claimEngagementExecution,
  updateEngagementExecutionState,
  persistEngagementReceipt,
  listExecutionsNeedingAttention,
  type EngagementExecutionRecord,
  type EngagementReceiptRecord,
  type EngagementStoreExecutor,
} from "./execution-store";
import {
  assertEngagementCapabilitySupported,
  resolveEngagementBinding,
  deriveProviderOperationIdentity,
  ProviderTransientError,
  ProviderAmbiguousError,
  ProviderPermanentError,
  EngagementProviderError,
  type EngagementProviderGateway,
} from "./provider-boundary";

export const ENGAGEMENT_EXECUTION_CONTRACT_VERSION = "engagement/execution@v1";
export const ENGAGEMENT_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const ENGAGEMENT_RETRY_BACKOFF_MS = 60 * 1000;
export const ENGAGEMENT_MAX_RETRIES = 3;

export class EngagementExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementExecutionError";
    this.code = code;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Canonical deterministic receipt identity. */
export function deriveEngagementReceiptId(input: {
  executionId: string;
  providerOperationIdentity: string;
}): string {
  return (
    "erec_" +
    sha256Hex([input.executionId, input.providerOperationIdentity].join("|")).slice(0, 40)
  );
}

function buildSettleKey(billingIdentity: string): string {
  return `${billingIdentity}:settle`;
}

function buildReleaseKey(billingIdentity: string): string {
  return `${billingIdentity}:release`;
}

// ─── Audit (loud, retry-safe, fingerprint-deduplicated) ───

async function auditEngagement(event: AuditEvent): Promise<void> {
  try {
    await persistAuditEvent(event);
  } catch (err) {
    console.error(
      `[Engagement] Failed to persist ${event.eventType} audit event:`,
      (err as Error)?.message
    );
  }
}

function buildReceiptAuditEvent(input: {
  receipt: EngagementReceiptRecord;
  occurredAt: string;
}): AuditEvent {
  return createAuditEvent({
    eventType: "engagement_receipt",
    occurredAt: input.occurredAt,
    userId: Number(input.receipt.userId),
    source: "workflow",
    outcome: "succeeded",
    businessId: Number(input.receipt.businessId),
    approvalRequestId: input.receipt.approvalRequestId ?? null,
    metadata: {
      engagementReceiptId: input.receipt.engagementReceiptId,
      executionId: input.receipt.executionId,
      actionRequestId: input.receipt.actionRequestId,
      policyDecisionId: input.receipt.policyDecisionId,
      signalId: input.receipt.signalId,
      interpretationId: input.receipt.interpretationId,
      provider: input.receipt.provider,
      providerOperationIdentity: input.receipt.providerOperationIdentity,
      externalTarget: input.receipt.externalTarget,
      status: input.receipt.status,
      executedAt: input.receipt.executedAt,
    },
  });
}

function buildTerminalAuditEvent(input: {
  execution: EngagementExecutionRecord;
  occurredAt: string;
  outcome: "failed" | "skipped";
}): AuditEvent {
  return createAuditEvent({
    eventType: "engagement_execution",
    occurredAt: input.occurredAt,
    userId: Number(input.execution.userId),
    source: "workflow",
    outcome: input.outcome,
    businessId: Number(input.execution.businessId),
    approvalRequestId: input.execution.approvalRequestId ?? null,
    metadata: {
      executionId: input.execution.executionId,
      actionRequestId: input.execution.actionRequestId,
      policyDecisionId: input.execution.policyDecisionId,
      signalId: input.execution.signalId,
      interpretationId: input.execution.interpretationId,
      provider: input.execution.provider,
      status: input.execution.status,
      failureClass: input.execution.failureClass ?? null,
      lastError: input.execution.lastError ?? null,
    },
  });
}

// ─── Dependencies (all injectable for deterministic tests) ───

export interface EngagementBilling {
  reserve: typeof reserveWalletCredits;
  settle: typeof settleWalletCredits;
  release: typeof releaseWalletCredits;
}

export interface EngagementExecutionDeps {
  executor?: EngagementStoreExecutor;
  gateway?: EngagementProviderGateway;
  billing?: Partial<EngagementBilling>;
  /** Loads the pre-decrypted provider access token for a binding. */
  loadAccessToken?: (input: { integrationId: number }) => Promise<string>;
}

interface ResolvedDeps {
  executor: EngagementStoreExecutor;
  gateway?: EngagementProviderGateway;
  billing: EngagementBilling;
  loadAccessToken: (input: { integrationId: number }) => Promise<string>;
}

function defaultDeps(deps?: EngagementExecutionDeps): ResolvedDeps {
  const executor = deps?.executor ?? (getDb() as unknown as EngagementStoreExecutor);
  return {
    executor,
    gateway: deps?.gateway,
    billing: {
      reserve: deps?.billing?.reserve ?? reserveWalletCredits,
      settle: deps?.billing?.settle ?? settleWalletCredits,
      release: deps?.billing?.release ?? releaseWalletCredits,
    },
    loadAccessToken:
      deps?.loadAccessToken ??
      (async ({ integrationId }: { integrationId: number }) => {
        const db = getDb();
        const [row] = await db
          .select({
            pageAccessTokenEncrypted: socialIntegrations.pageAccessTokenEncrypted,
            accessTokenEncrypted: socialIntegrations.accessTokenEncrypted,
          })
          .from(socialIntegrations)
          .where(eq(socialIntegrations.id, integrationId))
          .limit(1);
        const encrypted = row?.pageAccessTokenEncrypted ?? row?.accessTokenEncrypted;
        if (!encrypted) {
          throw new EngagementProviderError(
            "PROVIDER_BINDING_MISMATCH",
            "Provider binding carries no usable credential; failing closed."
          );
        }
        return decryptToken(encrypted);
      }),
  };
}

// ─── Policy gate (C3) ───

interface GateResult {
  verdict: MarketingActionExecutionVerdict;
  decision: PolicyDecision | null;
}

/**
 * The mandatory pre-action authority check. Loads the durable decision and
 * (when required) the bound approval row, then defers entirely to R5-E's
 * gate. No local policy interpretation.
 */
async function assertExecutable(
  execution: EngagementExecutionRecord,
  now: string,
  executor: EngagementStoreExecutor
): Promise<GateResult> {
  const decision = await getDecisionById(execution.policyDecisionId, executor);
  if (!decision) {
    return {
      verdict: { executable: false, reason: "APPROVAL_NOT_FOUND", permanent: true },
      decision: null,
    };
  }

  let approval: { id: number; status: "pending" | "approved" | "rejected" | "edited"; context: unknown } | null =
    null;
  if (execution.approvalRequestId != null) {
    const [row] = (await executor
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, execution.approvalRequestId))
      .limit(1)) as Array<{ id: number; status: string; context: unknown }>;
    if (row) {
      approval = {
        id: row.id,
        status: row.status as "pending" | "approved" | "rejected" | "edited",
        context: row.context,
      };
    }
  }

  const activePolicy = await getActivePolicy(Number(execution.businessId), executor);
  const verdict = assertMarketingActionExecutable({
    decision,
    approval,
    currentPolicyVersion: activePolicy?.policyVersion ?? null,
    now,
  });
  return { verdict, decision };
}

// ─── Disposition resolver (pure decision over durable state) ───

export type ExecutionDisposition =
  | { kind: "replay"; receipt: EngagementReceiptRecord }
  | { kind: "in_flight" }
  | { kind: "claim" }
  | { kind: "wait_retry"; until: Date | null }
  | { kind: "reconcile" }
  | { kind: "terminal" };

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed_terminal",
  "blocked",
  "never_execute",
  "internal_only",
]);

export function resolveExecutionDisposition(input: {
  execution: EngagementExecutionRecord;
  receipt: EngagementReceiptRecord | null;
  now: Date;
}): ExecutionDisposition {
  const { execution, receipt, now } = input;
  if (receipt) return { kind: "replay", receipt };
  if (TERMINAL_STATUSES.has(execution.status)) return { kind: "terminal" };
  if (execution.status === "ambiguous") return { kind: "reconcile" };
  if (execution.status === "executing") {
    const expiresAt = execution.claimExpiresAt ? new Date(execution.claimExpiresAt) : null;
    if (expiresAt && expiresAt > now) return { kind: "in_flight" };
    return { kind: "reconcile" }; // crashed attempt — probe before any resend
  }
  if (execution.status === "failed_retryable") return { kind: "claim" };
  if (execution.status === "pending_retry" || execution.status === "pending_claim") {
    const due = execution.nextRetryAt ? new Date(execution.nextRetryAt) : null;
    if (due && due > now) return { kind: "wait_retry", until: due };
    return { kind: "claim" };
  }
  return { kind: "terminal" };
}

// ─── Outcome types ───

export type ExecutionOutcome =
  | { kind: "executed"; classification: "none" | "idempotent_replay"; receipt: EngagementReceiptRecord }
  | { kind: "not_executable"; reason: string; permanent: boolean; status: string }
  | { kind: "in_flight" }
  | { kind: "wait_retry"; until: Date | null }
  | { kind: "reconciled"; receipt?: EngagementReceiptRecord; status: string }
  | { kind: "retry_scheduled"; nextRetryAt: Date | null }
  | { kind: "internal_only" };

// ─── The gated provider attempt (shared by execute + reconciler) ───

interface AttemptContext {
  execution: EngagementExecutionRecord;
  verdict: Extract<MarketingActionExecutionVerdict, { executable: true }>;
  decision: PolicyDecision;
  content: { content: string; contentHash: string };
  binding: Awaited<ReturnType<typeof resolveEngagementBinding>>;
  accessToken: string;
  gateway: EngagementProviderGateway;
  billing: EngagementBilling;
  now: Date;
  executor: EngagementStoreExecutor;
}

async function settleHeldReservation(input: {
  billing: EngagementBilling;
  reservationId: string | null;
  billingIdentity: string | null;
  asOf: string;
}): Promise<void> {
  if (!input.reservationId || !input.billingIdentity) return;
  try {
    await input.billing.settle({
      reservationId: input.reservationId,
      settleKey: buildSettleKey(input.billingIdentity),
      asOf: input.asOf,
    });
  } catch (err) {
    // Settlement failure is loud but non-destructive: the deterministic
    // settle key makes any retry converge; the receipt is the authority.
    console.error(
      `[Engagement] Settlement failed for ${input.billingIdentity}:`,
      (err as Error)?.message
    );
  }
}

async function releaseHeldReservation(input: {
  billing: EngagementBilling;
  reservationId: string | null;
  billingIdentity: string | null;
  reason: string;
}): Promise<void> {
  if (!input.reservationId || !input.billingIdentity) return;
  try {
    await input.billing.release({
      reservationId: input.reservationId,
      releaseKey: buildReleaseKey(input.billingIdentity),
      reason: input.reason,
    });
  } catch (err) {
    console.error(
      `[Engagement] Reservation release failed for ${input.billingIdentity}:`,
      (err as Error)?.message
    );
  }
}

async function attemptProviderCall(ctx: AttemptContext): Promise<ExecutionOutcome> {
  const { execution } = ctx;
  const operationIdentity = deriveProviderOperationIdentity({
    provider: ctx.binding.provider,
    providerAccountRef: ctx.binding.providerAccountRef,
    externalTarget: execution.externalTarget,
    contentHash: ctx.content.contentHash,
  });

  // Record the operation identity BEFORE the provider call so a crash after
  // provider success can be probed by identity during reconciliation.
  await updateEngagementExecutionState(
    {
      executionId: execution.executionId,
      expectedStatus: "executing",
      patch: { providerOperationIdentity: operationIdentity },
    },
    ctx.executor
  );

  const billingIdentity = ctx.verdict.authorization.billingIdentity;
  let reservationId: string | null = null;
  if (billingIdentity) {
    try {
      const reserved = await ctx.billing.reserve({
        userId: Number(execution.userId),
        campaignId: null,
        reservationReference: billingIdentity,
        amount: ctx.decision.estimatedCredits,
        reason: "engagement action execution",
        artifactId: execution.actionRequestId,
        agentType: "engagement",
        provider: ctx.binding.provider,
        asOf: ctx.now.toISOString(),
      });
      reservationId = reserved.reservation.reservationId;
      await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          expectedStatus: "executing",
          patch: { billingReservationId: reservationId },
        },
        ctx.executor
      );
    } catch (err) {
      await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          expectedStatus: "executing",
          patch: {
            status: "blocked",
            failureClass: "governance",
            lastError: `BILLING_RESERVATION_FAILED: ${(err as Error)?.message ?? String(err)}`.slice(0, 512),
          },
        },
        ctx.executor
      );
      return {
        kind: "not_executable",
        reason: "BILLING_RESERVATION_FAILED",
        permanent: true,
        status: "blocked",
      };
    }
  }

  try {
    const result = await ctx.gateway.replyToComment({
      operationIdentity,
      accessToken: ctx.accessToken,
      providerAccountRef: ctx.binding.providerAccountRef ?? "",
      externalTarget: execution.externalTarget,
      content: ctx.content.content,
    });

    const executedAt = ctx.now.toISOString();
    const { record: receipt } = await persistEngagementReceipt(
      {
        engagementReceiptId: deriveEngagementReceiptId({
          executionId: execution.executionId,
          providerOperationIdentity: operationIdentity,
        }),
        executionId: execution.executionId,
        businessId: execution.businessId,
        userId: execution.userId,
        signalId: execution.signalId,
        interpretationId: execution.interpretationId,
        actionRequestId: execution.actionRequestId,
        policyDecisionId: execution.policyDecisionId,
        approvalRequestId: execution.approvalRequestId,
        responseContentId: execution.responseContentId,
        responseContentVersion: execution.responseContentVersion,
        provider: ctx.binding.provider,
        integrationId: execution.integrationId,
        providerAccountRef: ctx.binding.providerAccountRef,
        externalTarget: execution.externalTarget,
        providerOperationIdentity: operationIdentity,
        providerExternalReceipt: result.providerExternalReceipt,
        executedAt,
        status: "succeeded",
        reconciliationState: "none",
      },
      ctx.executor
    );
    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        expectedStatus: "executing",
        patch: {
          status: "succeeded",
          reconciliationState: "resolved",
          failureClass: null,
          lastError: null,
        },
      },
      ctx.executor
    );
    await settleHeldReservation({
      billing: ctx.billing,
      reservationId,
      billingIdentity,
      asOf: executedAt,
    });
    await auditEngagement(buildReceiptAuditEvent({ receipt, occurredAt: executedAt }));
    return { kind: "executed", classification: "none", receipt };
  } catch (err) {
    if (err instanceof ProviderAmbiguousError) {
      // Outcome unknown: NEVER blind resend. Release the hold (settlement is
      // deterministically keyed, so a reconciled success still charges
      // exactly once) and flag a provider probe.
      await releaseHeldReservation({
        billing: ctx.billing,
        reservationId,
        billingIdentity,
        reason: "provider_ambiguous_outcome",
      });
      await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          expectedStatus: "executing",
          patch: {
            status: "ambiguous",
            reconciliationState: "needed",
            failureClass: "ambiguous",
            lastError: err.message.slice(0, 512),
          },
        },
        ctx.executor
      );
      return {
        kind: "not_executable",
        reason: "PROVIDER_AMBIGUOUS",
        permanent: false,
        status: "ambiguous",
      };
    }

    const transient =
      err instanceof ProviderTransientError || !(err instanceof ProviderPermanentError);
    await releaseHeldReservation({
      billing: ctx.billing,
      reservationId,
      billingIdentity,
      reason: transient ? "provider_transient_failure" : "provider_permanent_failure",
    });

    const nextAttempt = Number(execution.attempt ?? 0) + 1;
    if (transient && nextAttempt <= ENGAGEMENT_MAX_RETRIES) {
      const nextRetryAt = new Date(ctx.now.getTime() + nextAttempt * ENGAGEMENT_RETRY_BACKOFF_MS);
      await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          expectedStatus: "executing",
          patch: {
            status: "pending_retry",
            nextRetryAt,
            failureClass: "transient",
            lastError: (err as Error).message.slice(0, 512),
          },
        },
        ctx.executor
      );
      return { kind: "retry_scheduled", nextRetryAt };
    }

    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        expectedStatus: "executing",
        patch: {
          status: "failed_terminal",
          failureClass: transient ? "transient" : "permanent",
          lastError: (err as Error).message.slice(0, 512),
        },
      },
      ctx.executor
    );
    const failed = await getExecutionById(execution.executionId, ctx.executor);
    if (failed) {
      await auditEngagement(
        buildTerminalAuditEvent({
          execution: failed,
          occurredAt: ctx.now.toISOString(),
          outcome: "failed",
        })
      );
    }
    return {
      kind: "not_executable",
      reason: transient ? "PROVIDER_TRANSIENT_EXHAUSTED" : "PROVIDER_PERMANENT",
      permanent: !transient,
      status: "failed_terminal",
    };
  }
}

async function markGateBlocked(
  execution: EngagementExecutionRecord,
  verdict: Extract<MarketingActionExecutionVerdict, { executable: false }>,
  now: Date,
  executor: EngagementStoreExecutor
): Promise<ExecutionOutcome> {
  const status = verdict.permanent ? "never_execute" : "blocked";
  await updateEngagementExecutionState(
    {
      executionId: execution.executionId,
      patch: {
        status,
        failureClass: "governance",
        lastError: `${verdict.reason}${verdict.permanent ? " (permanent)" : ""}`.slice(0, 512),
      },
    },
    executor
  );
  const current = await getExecutionById(execution.executionId, executor);
  if (current && status === "never_execute") {
    await auditEngagement(
      buildTerminalAuditEvent({
        execution: current,
        occurredAt: now.toISOString(),
        outcome: "skipped",
      })
    );
  }
  return { kind: "not_executable", reason: verdict.reason, permanent: verdict.permanent, status };
}

// ─── Public entry points ───

/**
 * Execute one governed engagement action. Idempotent and safe under
 * concurrent triggers, process crashes, and provider ambiguity — the
 * durable rows decide every path.
 */
export async function executeEngagementAction(
  input: { actionRequestId: string; now?: Date },
  deps?: EngagementExecutionDeps
): Promise<ExecutionOutcome> {
  const d = defaultDeps(deps);
  const now = input.now ?? new Date();

  const execution = await getExecutionByActionRequest(input.actionRequestId, d.executor);
  if (!execution) {
    throw new EngagementExecutionError(
      "EXECUTION_NOT_FOUND",
      "No execution exists for this action request."
    );
  }

  return runExecutionWithDisposition(execution, now, d);
}

async function runExecutionWithDisposition(
  execution: EngagementExecutionRecord,
  now: Date,
  d: ResolvedDeps
): Promise<ExecutionOutcome> {
  const receipt = await getReceiptByExecutionId(execution.executionId, d.executor);
  const disposition = resolveExecutionDisposition({ execution, receipt, now });

  switch (disposition.kind) {
    case "replay":
      return { kind: "executed", classification: "idempotent_replay", receipt: disposition.receipt };
    case "terminal":
      return {
        kind: "not_executable",
        reason: `TERMINAL:${execution.status}`,
        permanent: true,
        status: execution.status,
      };
    case "in_flight":
      return { kind: "in_flight" };
    case "wait_retry":
      return { kind: "wait_retry", until: disposition.until };
    case "reconcile":
      return reconcileEngagementExecution({ executionId: execution.executionId, now }, d);
    case "claim": {
      const { claimed, record } = await claimEngagementExecution(
        {
          executionId: execution.executionId,
          leaseMs: ENGAGEMENT_CLAIM_LEASE_MS,
          attempt: Number(execution.attempt ?? 0) + 1,
          claimableStatuses: ["pending_claim", "failed_retryable", "pending_retry"],
          staleLeaseNow: now,
        },
        d.executor
      );
      if (!claimed || !record) {
        return { kind: "in_flight" };
      }
      return runClaimedExecution(record, now, d);
    }
  }
}

async function resolveAcceptedContent(
  execution: EngagementExecutionRecord,
  executor: EngagementStoreExecutor
): Promise<{ content: string; contentHash: string } | null> {
  const [row] = (await executor
    .select()
    .from(engagementResponseContents)
    .where(
      and(
        eq(engagementResponseContents.responseContentId, execution.responseContentId),
        eq(engagementResponseContents.version, execution.responseContentVersion)
      )
    )
    .limit(1)) as Array<{ content: string; contentHash: string; status: string }>;
  if (!row || row.status !== "accepted") return null;
  return { content: row.content, contentHash: row.contentHash };
}

/** The full gated path for exactly one claim holder. */
async function runClaimedExecution(
  execution: EngagementExecutionRecord,
  now: Date,
  d: ResolvedDeps
): Promise<ExecutionOutcome> {
  // Non-provider routings never touch a provider.
  if (execution.provider === "none") {
    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        expectedStatus: "executing",
        patch: { status: "internal_only", failureClass: null, lastError: null },
      },
      d.executor
    );
    return { kind: "internal_only" };
  }

  // 1. Provider capability (C5) — transport-grounded, fail closed.
  try {
    assertEngagementCapabilitySupported({
      actionType: execution.actionType,
      platform: execution.platform,
    });
  } catch (err) {
    if (err instanceof EngagementProviderError) {
      await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          expectedStatus: "executing",
          patch: {
            status: "blocked",
            failureClass: err.code === "UNSUPPORTED_PROVIDER_CAPABILITY" ? "unsupported" : "governance",
            lastError: err.message.slice(0, 512),
          },
        },
        d.executor
      );
      const current = await getExecutionById(execution.executionId, d.executor);
      if (current) {
        await auditEngagement(
          buildTerminalAuditEvent({
            execution: current,
            occurredAt: now.toISOString(),
            outcome: "skipped",
          })
        );
      }
      return {
        kind: "not_executable",
        reason: err.code,
        permanent: true,
        status: "blocked",
      };
    }
    throw err;
  }

  // 2. Binding ownership re-verification (C5).
  let binding;
  try {
    binding = await resolveEngagementBinding(
      {
        integrationId: Number(execution.integrationId),
        businessId: Number(execution.businessId),
        userId: Number(execution.userId),
        platform: execution.platform,
      },
      d.executor
    );
  } catch (err) {
    const permanent =
      err instanceof EngagementProviderError &&
      (err.code === "OWNERSHIP_MISMATCH" || err.code === "PROVIDER_BINDING_MISMATCH");
    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        expectedStatus: "executing",
        patch: {
          status: permanent ? "never_execute" : "blocked",
          failureClass: permanent ? "governance" : "unsupported",
          lastError: (err as Error).message.slice(0, 512),
        },
      },
      d.executor
    );
    const current = await getExecutionById(execution.executionId, d.executor);
    if (current && permanent) {
      await auditEngagement(
        buildTerminalAuditEvent({
          execution: current,
          occurredAt: now.toISOString(),
          outcome: "skipped",
        })
      );
    }
    return {
      kind: "not_executable",
      reason: (err as EngagementProviderError).code ?? "PROVIDER_BINDING_MISMATCH",
      permanent,
      status: permanent ? "never_execute" : "blocked",
    };
  }

  // 3. R5-E policy gate (C3) — the only execution authority.
  const gate = await assertExecutable(execution, now.toISOString(), d.executor);
  if (!gate.verdict.executable) {
    return markGateBlocked(execution, gate.verdict, now, d.executor);
  }
  if (!gate.decision) {
    throw new EngagementExecutionError("DECISION_MISSING", "Executable verdict without a durable decision.");
  }

  // 4. Immutable accepted content bound to this execution.
  const content = await resolveAcceptedContent(execution, d.executor);
  if (!content) {
    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        expectedStatus: "executing",
        patch: {
          status: "never_execute",
          failureClass: "governance",
          lastError:
            "RESPONSE_CONTENT_NOT_ACCEPTED: no immutable accepted content bound to this execution.",
        },
      },
      d.executor
    );
    return {
      kind: "not_executable",
      reason: "RESPONSE_CONTENT_NOT_ACCEPTED",
      permanent: true,
      status: "never_execute",
    };
  }

  // 5. Provider attempt under the claim (C6 exact-once mechanics inside).
  if (!d.gateway) {
    throw new EngagementExecutionError(
      "GATEWAY_REQUIRED",
      "No provider gateway supplied for a provider-capable action."
    );
  }
  const accessToken = await d.loadAccessToken({ integrationId: Number(execution.integrationId) });

  return attemptProviderCall({
    execution,
    verdict: gate.verdict,
    decision: gate.decision,
    content,
    binding,
    accessToken,
    gateway: d.gateway,
    billing: d.billing,
    now,
    executor: d.executor,
  });
}

/**
 * Reconcile one execution after ambiguous provider outcomes or crashes.
 * Probes the provider by operation identity — NEVER blind resends.
 */
export async function reconcileEngagementExecution(
  input: { executionId: string; now?: Date },
  deps?: EngagementExecutionDeps | ResolvedDeps
): Promise<ExecutionOutcome> {
  const d: ResolvedDeps =
    deps && "billing" in deps && "loadAccessToken" in deps
      ? (deps as ResolvedDeps)
      : defaultDeps(deps as EngagementExecutionDeps | undefined);
  const now = input.now ?? new Date();

  const execution = await getExecutionById(input.executionId, d.executor);
  if (!execution) {
    throw new EngagementExecutionError("EXECUTION_NOT_FOUND", "Execution not found.");
  }
  const receipt = await getReceiptByExecutionId(execution.executionId, d.executor);
  if (receipt) {
    return { kind: "executed", classification: "idempotent_replay", receipt };
  }
  if (!d.gateway) {
    return {
      kind: "not_executable",
      reason: "GATEWAY_REQUIRED",
      permanent: false,
      status: execution.status,
    };
  }

  const operationIdentity = execution.providerOperationIdentity;
  if (!operationIdentity) {
    // No provider attempt was ever recorded — fall back to the normal path.
    return runExecutionWithDisposition(execution, now, d);
  }

  const binding = await resolveEngagementBinding(
    {
      integrationId: Number(execution.integrationId),
      businessId: Number(execution.businessId),
      userId: Number(execution.userId),
      platform: execution.platform,
    },
    d.executor
  );
  const accessToken = await d.loadAccessToken({ integrationId: Number(execution.integrationId) });
  const probe = await d.gateway.probeOperation({
    accessToken,
    providerAccountRef: binding.providerAccountRef ?? "",
    operationIdentity,
  });

  if (probe.status === "confirmed_success") {
    const executedAt = now.toISOString();
    const { record } = await persistEngagementReceipt(
      {
        engagementReceiptId: deriveEngagementReceiptId({
          executionId: execution.executionId,
          providerOperationIdentity: operationIdentity,
        }),
        executionId: execution.executionId,
        businessId: execution.businessId,
        userId: execution.userId,
        signalId: execution.signalId,
        interpretationId: execution.interpretationId,
        actionRequestId: execution.actionRequestId,
        policyDecisionId: execution.policyDecisionId,
        approvalRequestId: execution.approvalRequestId,
        responseContentId: execution.responseContentId,
        responseContentVersion: execution.responseContentVersion,
        provider: binding.provider,
        integrationId: execution.integrationId,
        providerAccountRef: binding.providerAccountRef,
        externalTarget: execution.externalTarget,
        providerOperationIdentity: operationIdentity,
        providerExternalReceipt: probe.providerExternalReceipt,
        executedAt,
        status: "succeeded",
        reconciliationState: "resolved",
      },
      d.executor
    );
    await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        patch: {
          status: "succeeded",
          reconciliationState: "resolved",
          failureClass: null,
          lastError: null,
        },
      },
      d.executor
    );
    await auditEngagement(buildReceiptAuditEvent({ receipt: record, occurredAt: executedAt }));
    return { kind: "reconciled", receipt: record, status: "succeeded" };
  }

  if (probe.status === "confirmed_absent") {
    // Provider confirms no effect: safe to re-attempt through the full gate.
    const reset = await updateEngagementExecutionState(
      {
        executionId: execution.executionId,
        patch: { status: "pending_claim", reconciliationState: "resolved", failureClass: null },
      },
      d.executor
    );
    if (!reset.updated) return { kind: "in_flight" };
    const after = await getExecutionById(execution.executionId, d.executor);
    if (!after) return { kind: "in_flight" };
    return runExecutionWithDisposition(after, now, d);
  }

  // unknown: leave ambiguous for a later pass.
  return { kind: "reconciled", status: execution.status };
}

/**
 * Boot/cron sweep: reconciliation-first, then due retries. Error-isolated
 * per item; the durable rows keep every decision idempotent.
 */
export async function runEngagementReconciliationSweep(
  input: { limit?: number; now?: Date },
  deps?: EngagementExecutionDeps
): Promise<{ scanned: number; reconciled: number; executed: number; failed: number }> {
  const d = defaultDeps(deps);
  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;

  const rows = await listExecutionsNeedingAttention({ limit, now }, d.executor);
  let reconciled = 0;
  let executed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const receipt = await getReceiptByExecutionId(row.executionId, d.executor);
      const disposition = resolveExecutionDisposition({ execution: row, receipt, now });
      if (disposition.kind === "reconcile") {
        const outcome = await reconcileEngagementExecution({ executionId: row.executionId, now }, d);
        if (outcome.kind === "reconciled" || outcome.kind === "executed") reconciled += 1;
      } else if (disposition.kind === "claim") {
        const outcome = await executeEngagementAction({ actionRequestId: row.actionRequestId, now }, d);
        if (outcome.kind === "executed") executed += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[Engagement] Sweep failed for execution ${row.executionId}:`,
        (err as Error)?.message
      );
    }
  }

  return { scanned: rows.length, reconciled, executed, failed };
}
