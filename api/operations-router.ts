/**
 * R5-F: Operator surface (WBS-R5 Stream F).
 *
 * Admin-scoped operator surface over the canonical R5 operations projection
 * (`projectR5BusinessOperations`). F4 read endpoints (getBusinessOperations,
 * listOperationalStates, getOperationsSummary) are READ-ONLY; F5 adds the
 * single governed recovery adapter (`retryOperation`). Every procedure is
 * `adminQuery` (authenticated + OTP/2FA-verified + role admin); operator
 * reads may cross businesses by design (contract §6), while recovery binds
 * ownership from durable rows only — never from client input.
 *
 * Conventions (mirror the admin control plane):
 * - Bounded errors only: never leak raw exception text; NOT_FOUND for a
 *   missing operation; typed authority errors mapped to closed codes.
 * - Secret-free: the projection's column allow-list is inherited unchanged;
 *   no token/credential/payload fields are added.
 * - Governed recovery delegates to existing authorities (terminal replay D1,
 *   next-cycle persistence/dispatcher); no new recovery authority, no
 *   client-supplied lifecycle state or recovery identity.
 * - Bounded reads: cross-business listings page over `businesses` with
 *   limit/offset and project ONLY the rows in the requested window.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses, campaigns, publishingQueue, queueTerminalFailures } from "@db/schema";
import { logError } from "./lib/logger";
import {
  requestTerminalFailureReplay,
  TerminalReplayInvalidTransitionError,
  TerminalReplayKeyConflictError,
  TerminalReplayRequestNotFoundError,
  TerminalReplayTargetNotFoundError,
} from "./lib/queue/terminal-replay";
import {
  parseNextCycleInstruction,
  type NextCycleInstructionStatus,
} from "./lib/learning/learning-strategy-consumption";
import type { NextCycleDispatchDeps } from "./lib/workflow/next-cycle-dispatcher";
import {
  extractAdminRequestId,
  recordAdminMutationAudit,
} from "./lib/governance/admin-audit";
import {
  projectR5BusinessOperations,
  R5_OPERATIONAL_HEALTH,
  type R5BusinessOperationsProjection,
} from "./lib/governance/r5-operations-projection";
import { summarizeR5Operations } from "./lib/governance/r5-operations-summary";

// ─── WBS-R5-F5: Governed recovery adapter ───
// Narrow operator ADAPTERS over existing governed authorities only (contract
// §7): terminal replay D1 (`requestTerminalFailureReplay`), the next-cycle
// CAS retry (`retryFailedNextCycleInstruction`) and the next-cycle dispatcher
// (`dispatchNextCycleInstruction`). R4's manual recovery policy leaves
// `mutationAuthorized: false` for failed publishing items — the ONLY sanctioned
// recovery path for a failed/terminal queue item is terminal replay, so no
// failed→retrying UPDATE path exists here and none may be added (contract §8).

const R5_OPERATION_KINDS = [
  "publishing_queue_item",
  "terminal_failure",
  "next_cycle_instruction",
] as const;
type R5OperationKind = (typeof R5_OPERATION_KINDS)[number];

type R5RetryOutcome = "requeued" | "dispatched" | "already_recovering" | "noop";

/** Server-derived binding: ownership and current state from durable rows only. */
type R5OperationBinding =
  | {
      kind: "publishing_queue_item";
      ownerUserId: number;
      businessId: number | null;
      campaignId: number;
      currentStatus: string;
    }
  | {
      kind: "terminal_failure";
      ownerUserId: number;
      businessId: number | null;
      campaignId: number | null;
      currentStatus: string;
    }
  | {
      kind: "next_cycle_instruction";
      ownerUserId: number;
      businessId: number | null;
      campaignId: number;
      currentStatus: NextCycleInstructionStatus;
      instructionId: string;
    };

// Default-OFF kill switch for mutating recovery operations, mirroring the
// terminal-replay control plane (`TERMINAL_REPLAY_ADMIN_ENABLED`).
function requireR5OperationRetryEnabled(): void {
  if (process.env.R5_OPERATION_RETRY_ADMIN_ENABLED !== "true") {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "R5 operation recovery is disabled.",
    });
  }
}

/**
 * Bounded error mapping for the recovery adapter: never leak raw exception
 * text to the client; only known error authorities contribute a closed code.
 * Structured identifiers live in logs only.
 */
function mapR5RecoveryError(
  err: unknown,
  adminUserId: number,
  identifiers: { operationKind: R5OperationKind; operationId: number }
): TRPCError {
  const errorCode = (err as { code?: unknown } | null | undefined)?.code;
  logError("[R5] Operation recovery failed", {
    event: "r5_operation_retry_error",
    adminUserId,
    operationKind: identifiers.operationKind,
    operationId: identifiers.operationId,
    errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
  });

  if (err instanceof TerminalReplayTargetNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: "Operation target not found." });
  }
  if (err instanceof TerminalReplayRequestNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: "Replay request not found." });
  }
  if (err instanceof TerminalReplayKeyConflictError) {
    return new TRPCError({ code: "CONFLICT", message: "Replay identity conflict." });
  }
  if (err instanceof TerminalReplayInvalidTransitionError) {
    return new TRPCError({ code: "CONFLICT", message: "Operation recovery conflict." });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Operation recovery failed.",
  });
}

/**
 * Best-effort audit for a privileged recovery whose governed step FAILED. The
 * failure audit never masks the original error: an audit failure here is
 * logged and swallowed so the caller still receives the authoritative mapped
 * error. Used only around delegated authority calls; the SUCCESS audit below
 * propagates its failures (fail closed).
 */
async function recordFailedR5OperationAudit(
  ctx: { req: unknown },
  actorUserId: number,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await recordAdminMutationAudit({
      actorUserId,
      action: "admin.r5_operation_retry",
      targetType: "r5_operation",
      outcome: "failed",
      occurredAt: new Date(),
      metadata,
      requestId: extractAdminRequestId(ctx.req),
    });
  } catch (auditErr) {
    const errorCode = (auditErr as { code?: unknown } | null | undefined)?.code;
    logError("[R5] Failed to record r5 operation audit event", {
      event: "r5_operation_audit_record_failed",
      adminUserId: actorUserId,
      errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
    });
  }
}

/**
 * Exactly one canonical audit event per REAL recovery mutation (contract §9).
 * The delegated authorities run outside an explicit transaction here, so an
 * audit failure propagates loudly: a privileged mutation can never silently
 * skip the ledger (the deterministic replay key / instruction CAS makes the
 * retry converge).
 */
async function recordR5OperationRetryAudit(
  ctx: { req: unknown; user: { id: number } },
  input: {
    operationKind: R5OperationKind;
    operationId: number;
    reason?: string | undefined;
  },
  binding: R5OperationBinding,
  outcome: "requeued" | "dispatched"
): Promise<void> {
  await recordAdminMutationAudit({
    actorUserId: ctx.user.id,
    action: "admin.r5_operation_retry",
    targetType: "r5_operation",
    targetId: `${input.operationKind}:${input.operationId}`,
    businessId: binding.businessId ?? null,
    campaignId: binding.campaignId,
    reason: input.reason ?? null,
    occurredAt: new Date(),
    metadata: {
      operationKind: input.operationKind,
      operationId: input.operationId,
      outcome,
      currentStatusBefore: binding.currentStatus,
    },
    requestId: extractAdminRequestId(ctx.req),
  });
}

function parseWorkflowContextObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

type R5Db = ReturnType<typeof getDb>;

async function resolvePublishingQueueItemBinding(
  db: R5Db,
  operationId: number
): Promise<Extract<R5OperationBinding, { kind: "publishing_queue_item" }>> {
  const [row] = await db
    .select({
      id: publishingQueue.id,
      status: publishingQueue.status,
      campaignId: publishingQueue.campaignId,
      retryCount: publishingQueue.retryCount,
      maxRetries: publishingQueue.maxRetries,
    })
    .from(publishingQueue)
    .where(eq(publishingQueue.id, operationId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "publishing queue item not found" });
  }
  const [campaign] = await db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      businessId: campaigns.businessId,
    })
    .from(campaigns)
    .where(eq(campaigns.id, row.campaignId))
    .limit(1);
  if (!campaign) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "queue item has no resolvable campaign",
    });
  }
  return {
    kind: "publishing_queue_item",
    ownerUserId: campaign.userId,
    businessId: campaign.businessId ?? null,
    campaignId: campaign.id,
    currentStatus: row.status,
  };
}

async function resolveTerminalFailureBinding(
  db: R5Db,
  operationId: number
): Promise<Extract<R5OperationBinding, { kind: "terminal_failure" }>> {
  const [row] = await db
    .select({
      id: queueTerminalFailures.id,
      status: queueTerminalFailures.status,
      userId: queueTerminalFailures.userId,
      campaignId: queueTerminalFailures.campaignId,
      queueName: queueTerminalFailures.queueName,
      terminalReason: queueTerminalFailures.terminalReason,
    })
    .from(queueTerminalFailures)
    .where(eq(queueTerminalFailures.id, operationId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "terminal failure not found" });
  }
  let businessId: number | null = null;
  if (row.campaignId !== null) {
    const [campaign] = await db
      .select({ businessId: campaigns.businessId })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .limit(1);
    businessId = campaign?.businessId ?? null;
  }
  return {
    kind: "terminal_failure",
    ownerUserId: row.userId,
    businessId,
    campaignId: row.campaignId,
    currentStatus: row.status,
  };
}

async function resolveNextCycleBinding(
  db: R5Db,
  operationId: number
): Promise<Extract<R5OperationBinding, { kind: "next_cycle_instruction" }>> {
  // operationId IS the campaign id for this kind.
  const [campaign] = await db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      businessId: campaigns.businessId,
      workflowContext: campaigns.workflowContext,
    })
    .from(campaigns)
    .where(eq(campaigns.id, operationId))
    .limit(1);
  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "campaign not found" });
  }
  const rawNextCycle = parseWorkflowContextObject(campaign.workflowContext).nextCycle;
  if (rawNextCycle === undefined) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "campaign records no next-cycle instruction",
    });
  }
  let instruction: { instructionId: string; status: NextCycleInstructionStatus };
  try {
    instruction = parseNextCycleInstruction(rawNextCycle);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "campaign records a malformed next-cycle instruction; refusing to recover",
    });
  }
  return {
    kind: "next_cycle_instruction",
    ownerUserId: campaign.userId,
    businessId: campaign.businessId ?? null,
    campaignId: campaign.id,
    currentStatus: instruction.status,
    instructionId: instruction.instructionId,
  };
}

// The next-cycle dispatcher's external strategy/review boundaries are
// injectable by design (see next-cycle-dispatcher). Production leaves them
// unset so the real governed strategy pathway runs; tests substitute benign
// boundaries so the real dispatcher orchestration runs against the fake db
// without any provider calls.
type NextCycleDispatchBoundaries = Pick<
  NextCycleDispatchDeps,
  "runStrategy" | "createStrategyReview"
>;
const defaultNextCycleDispatchBoundaries: NextCycleDispatchBoundaries = {};
let activeNextCycleDispatchBoundaries = defaultNextCycleDispatchBoundaries;

/** Test-only seam. Never used by production callers. */
export function __setNextCycleDispatchBoundariesForTests(
  boundaries: NextCycleDispatchBoundaries | null
): void {
  activeNextCycleDispatchBoundaries = boundaries ?? defaultNextCycleDispatchBoundaries;
}

export const operationsRouter = createRouter({
  // Single-business canonical projection. Answers operator questions 1-10 by
  // construction (health, blockers, safe next action, staleness, evidence).
  getBusinessOperations: adminQuery
    .input(z.object({ businessId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const projection = await projectR5BusinessOperations({
        businessId: input.businessId,
      });
      if (!projection.business) {
        throw new TRPCError({ code: "NOT_FOUND", message: "business not found" });
      }
      return projection;
    }),

  // Bounded cross-business state listing, most recent businesses first.
  listOperationalStates: adminQuery
    .input(
      z.object({
        health: z.enum(R5_OPERATIONAL_HEALTH).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const now = new Date();

      const rows = await db
        .select({
          id: businesses.id,
          userId: businesses.userId,
          name: businesses.name,
        })
        .from(businesses)
        .orderBy(desc(businesses.id))
        .limit(input.limit)
        .offset(input.offset);

      const items: {
        business: { id: number; userId: number; name: string };
        health: R5BusinessOperationsProjection["health"];
        blockers: R5BusinessOperationsProjection["blockers"];
        safeNextAction: R5BusinessOperationsProjection["safeNextAction"];
        staleness: R5BusinessOperationsProjection["staleness"];
        capabilitiesPresent: number;
      }[] = [];

      for (const row of rows) {
        try {
          const projection = await projectR5BusinessOperations({
            businessId: row.id,
            now,
          });
          if (input.health && projection.health !== input.health) continue;
          items.push({
            business: { id: row.id, userId: row.userId, name: row.name },
            health: projection.health,
            blockers: projection.blockers,
            safeNextAction: projection.safeNextAction,
            staleness: projection.staleness,
            capabilitiesPresent: projection.capabilitiesPresent,
          });
        } catch (err) {
          // A single unreadable business must not take down the listing.
          logError("[R5] Failed to project business for operational state listing", {
            event: "r5_list_operational_states_business_failed",
            businessId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      const totalRows = await db.select({ id: businesses.id }).from(businesses);
      return {
        items,
        total: totalRows.length,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  // Platform-level aggregate over the same bounded projection window used by
  // the readiness surface (shared helper keeps the two consistent).
  getOperationsSummary: adminQuery.query(async () => {
    const db = getDb();
    const now = new Date();
    const summary = await summarizeR5Operations(db, now);
    return {
      generatedAt: now.toISOString(),
      projectedCount: summary.projectedCount,
      totalBusinesses: summary.totalBusinesses,
      truncated: summary.truncated,
      healthCounts: summary.healthCounts,
      blockerClassCounts: summary.blockerClassCounts,
    };
  }),

  // WBS-R5-F5: governed operator recovery. A narrow adapter over the existing
  // governed authorities (contract §7): server-derived binding from durable
  // rows, ownership + staleness assertions, idempotent convergence, bounded
  // errors, exactly one canonical admin audit event per real mutation (§9).
  // There is deliberately NO client-supplied lifecycle state or recovery
  // identity, and no failed→retrying UPDATE path — a failed publishing item
  // recovers ONLY through the durable terminal-replay authority (R4 policy).
  retryOperation: adminQuery
    .input(
      z.object({
        operationKind: z.enum(R5_OPERATION_KINDS),
        operationId: z.number().int().positive(),
        // Staleness assertion only; never trusted for binding.
        expectedStatus: z.string().max(64).optional(),
        // Ownership assertion only; NEVER trusted for binding.
        businessId: z.number().int().positive().optional(),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireR5OperationRetryEnabled();
      const adminUserId = ctx.user.id;
      const db = getDb();

      // 1. Server-side binding: ownership + current state derived from
      //    durable rows only, resolved per kind BEFORE any delegation.
      const binding: R5OperationBinding =
        input.operationKind === "publishing_queue_item"
          ? await resolvePublishingQueueItemBinding(db, input.operationId)
          : input.operationKind === "terminal_failure"
            ? await resolveTerminalFailureBinding(db, input.operationId)
            : await resolveNextCycleBinding(db, input.operationId);

      // 2. Ownership assertion — never reveals the real businessId.
      if (input.businessId !== undefined && binding.businessId !== input.businessId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "business assertion mismatch" });
      }

      // 3. Staleness assertion (bounded message).
      if (input.expectedStatus !== undefined && input.expectedStatus !== binding.currentStatus) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `stale operation state: expected ${input.expectedStatus}, current ${binding.currentStatus}`,
        });
      }

      const respond = (
        outcome: R5RetryOutcome,
        replayRequestId?: number
      ) => ({
        outcome,
        operationKind: binding.kind,
        operationId: input.operationId,
        currentStatus: binding.currentStatus,
        ...(replayRequestId != null ? { replayRequestId } : {}),
      });

      if (binding.kind === "publishing_queue_item") {
        // R4 manual-recovery rationale (publication-recovery-policy):
        // published never requeues; approval-blocked items resolve through
        // the approval flow; retrying is owned by an in-flight replay.
        if (binding.currentStatus === "retrying") {
          // Idempotent convergence: nothing mutated. Per the R4 audit pattern
          // no-op convergence writes NO admin_mutation event (the ledger
          // fingerprint-dedupes real mutations anyway).
          return respond("already_recovering");
        }
        if (binding.currentStatus === "published") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Queue item is already published; requeueing it would duplicate publication.",
          });
        }
        if (
          binding.currentStatus === "pending_approval" ||
          binding.currentStatus === "safety_blocked"
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Queue item is blocked on content approval authority, not a terminal failure; resolve it through the approval flow.",
          });
        }
        if (binding.currentStatus !== "failed") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Queue item status "${binding.currentStatus}" is not a terminal failed state.`,
          });
        }
        const [terminalFailure] = await db
          .select({ id: queueTerminalFailures.id })
          .from(queueTerminalFailures)
          .where(
            and(
              eq(queueTerminalFailures.publishingQueueItemId, input.operationId),
              eq(queueTerminalFailures.status, "open")
            )
          )
          .limit(1);
        if (!terminalFailure) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "No durable terminal failure anchors a replay for this queue item.",
          });
        }
        // Replay identity is derived deterministically server-side; the
        // unique replayKey is the idempotency authority.
        let replay: Awaited<ReturnType<typeof requestTerminalFailureReplay>>;
        try {
          replay = await requestTerminalFailureReplay({
            terminalFailureId: terminalFailure.id,
            replayKey: `r5f:op-retry:pqi:${input.operationId}`,
            requestedByUserId: binding.ownerUserId,
            reason: input.reason,
          });
        } catch (err) {
          await recordFailedR5OperationAudit(ctx, adminUserId, {
            operationKind: binding.kind,
            operationId: input.operationId,
            currentStatusBefore: binding.currentStatus,
          });
          throw mapR5RecoveryError(err, adminUserId, input);
        }
        if (replay.alreadyRequested) {
          // No-op convergence on the durable replay row: no new mutation, no
          // admin_mutation event (R4 pattern).
          return respond("already_recovering", replay.record.id);
        }
        await recordR5OperationRetryAudit(ctx, input, binding, "requeued");
        return respond("requeued", replay.record.id);
      }

      if (binding.kind === "terminal_failure") {
        if (binding.currentStatus !== "open") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "terminal failure is not open",
          });
        }
        let replay: Awaited<ReturnType<typeof requestTerminalFailureReplay>>;
        try {
          replay = await requestTerminalFailureReplay({
            terminalFailureId: input.operationId,
            replayKey: `r5f:op-retry:tf:${input.operationId}`,
            requestedByUserId: binding.ownerUserId,
            reason: input.reason,
          });
        } catch (err) {
          await recordFailedR5OperationAudit(ctx, adminUserId, {
            operationKind: binding.kind,
            operationId: input.operationId,
            currentStatusBefore: binding.currentStatus,
          });
          throw mapR5RecoveryError(err, adminUserId, input);
        }
        if (replay.alreadyRequested) {
          return respond("already_recovering", replay.record.id);
        }
        await recordR5OperationRetryAudit(ctx, input, binding, "requeued");
        return respond("requeued", replay.record.id);
      }

      // binding.kind === "next_cycle_instruction"
      if (binding.currentStatus === "dispatched") {
        // Already consumed by its cycle: nothing to recover, no audit.
        return respond("noop");
      }

      const { retryFailedNextCycleInstruction } = await import(
        "./lib/workflow/next-cycle-persistence"
      );
      const { dispatchNextCycleInstruction } = await import(
        "./lib/workflow/next-cycle-dispatcher"
      );

      if (binding.currentStatus === "failed") {
        let retry: Awaited<ReturnType<typeof retryFailedNextCycleInstruction>>;
        try {
          retry = await retryFailedNextCycleInstruction({
            userId: binding.ownerUserId,
            campaignId: input.operationId,
            instructionId: binding.instructionId,
          });
        } catch (err) {
          await recordFailedR5OperationAudit(ctx, adminUserId, {
            operationKind: binding.kind,
            operationId: input.operationId,
            currentStatusBefore: binding.currentStatus,
          });
          throw mapR5RecoveryError(err, adminUserId, input);
        }
        if (!retry) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "campaign not found for next-cycle retry",
          });
        }
        if (!retry.retried) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `next-cycle instruction cannot be retried: ${retry.reason}`,
          });
        }
      }

      // "ready" (or just CAS-retried from "failed"): dispatch exactly once.
      let dispatch: Awaited<ReturnType<typeof dispatchNextCycleInstruction>>;
      try {
        dispatch = await dispatchNextCycleInstruction({
          userId: binding.ownerUserId,
          campaignId: input.operationId,
          instructionId: binding.instructionId,
          deps: activeNextCycleDispatchBoundaries,
        });
      } catch (err) {
        // The CAS retry above may have committed before the dispatch failed:
        // best-effort failed audit (log+swallow) so the authoritative bounded
        // error reaches the client.
        await recordFailedR5OperationAudit(ctx, adminUserId, {
          operationKind: binding.kind,
          operationId: input.operationId,
          currentStatusBefore: binding.currentStatus,
        });
        throw mapR5RecoveryError(err, adminUserId, input);
      }
      if (dispatch.outcome === "already_dispatched") {
        // Convergence: a concurrent dispatcher consumed the instruction; this
        // call produced no new end-to-end mutation, so no admin_mutation event.
        return respond("noop");
      }
      await recordR5OperationRetryAudit(ctx, input, binding, "dispatched");
      return respond("dispatched");
    }),
});
