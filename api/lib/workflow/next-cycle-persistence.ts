/**
 * Next-cycle instruction persistence authority (WBS-R1.2B).
 *
 * persistNextCycleInstruction durably records ONE next-cycle instruction
 * envelope ({ instructionId, status: "ready" }) inside the owning campaign's
 * workflowContext.nextCycle, so a future dispatcher has a single fail-closed
 * authority for what the next governed Strategy cycle was seeded from.
 *
 * Authority semantics:
 * - The campaign is always scoped by id + userId: a next-cycle instruction
 *   is never read or written across an ownership boundary.
 * - The write is a single conditional UPDATE matched on id + userId AND on
 *   workflowContext.nextCycle still being ABSENT. A concurrent writer can
 *   therefore win the slot exactly once; a zero-row UPDATE is reconciled by
 *   rereading the campaign and accepting ONLY a winner carrying the same
 *   instructionId. Any other winner fails closed.
 * - An existing nextCycle is validated with the strict fail-closed
 *   parseNextCycleInstruction contract (learning-strategy-consumption). An
 *   exact instructionId replay returns idempotently; a different instructionId
 *   or any malformed state fails closed — authority is never overwritten.
 * - workflowContext is a preserved-superset write: every existing field is
 *   carried over untouched; only the nextCycle key is added.
 * - Lifecycle transitions are exact-instruction CAS moves from "ready" to a
 *   terminal status ("dispatched" | "failed"), matched on id + userId AND on
 *   the current ready instruction. An already-completed identical transition
 *   replays idempotently; a zero-row UPDATE is reconciled by rereading and
 *   accepting only an identical instruction already in the target status.
 *   Absent, malformed, conflicting or wrongly-statused state fails closed —
 *   authority is never overwritten.
 *
 * This module performs NO Strategy execution, NO approval creation and NO
 * schema or migration change. The only mutation target is the owning
 * campaign's workflowContext JSON column.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  parseNextCycleInstruction,
  type NextCycleInstruction,
} from "../learning/learning-strategy-consumption";

type NextCycleDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam. The default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape, so callers can run
 * next-cycle persistence inside their own transaction.
 */
export interface NextCycleDbExecutor {
  select: NextCycleDb["select"];
  update: NextCycleDb["update"];
}

function resolveExecutor(executor?: NextCycleDbExecutor): NextCycleDbExecutor {
  return executor ?? getDb();
}

export interface PersistNextCycleInstructionResult {
  /** The durable instruction authority after this call. */
  instruction: NextCycleInstruction;
  /** True when this call performed the conditional write, false on replay. */
  persisted: boolean;
}

function assertPositiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
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

async function readScopedCampaign(
  executor: NextCycleDbExecutor,
  campaignId: number,
  userId: number
): Promise<{ id: number; workflowContext: unknown } | null> {
  const [campaign] = await executor
    .select({
      id: campaigns.id,
      workflowContext: campaigns.workflowContext,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  return campaign ?? null;
}

/**
 * Persists { instructionId, status: "ready" } as the campaign's sole
 * workflowContext.nextCycle authority.
 *
 * Returns null when the campaign does not exist for (campaignId, userId).
 * Throws (fail closed) on conflicting or malformed existing nextCycle state
 * and when a zero-row conditional UPDATE cannot be reconciled against an
 * identical-instructionId winner.
 */
export async function persistNextCycleInstruction(input: {
  userId: number;
  campaignId: number;
  instructionId: string;
  executor?: NextCycleDbExecutor;
}): Promise<PersistNextCycleInstructionResult | null> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.campaignId, "campaignId");
  if (typeof input.instructionId !== "string" || input.instructionId.trim().length === 0) {
    throw new Error("instructionId must be a non-blank string");
  }

  const executor = resolveExecutor(input.executor);

  const campaign = await readScopedCampaign(executor, input.campaignId, input.userId);
  if (!campaign) {
    return null;
  }

  const context = parseJsonObject(campaign.workflowContext);
  const existingNextCycle = context.nextCycle;

  if (existingNextCycle !== undefined) {
    // Fail-closed strict parse: malformed stored state throws here.
    const instruction = parseNextCycleInstruction(existingNextCycle);
    if (instruction.instructionId === input.instructionId) {
      // Exact replay of the already-persisted instruction: idempotent no-op.
      return { instruction, persisted: false };
    }
    throw new Error(
      `campaign ${input.campaignId} already persists a different next-cycle instruction`
    );
  }

  const nextContext = {
    ...context,
    nextCycle: { instructionId: input.instructionId, status: "ready" as const },
  };

  const updateResult = await executor
    .update(campaigns)
    .set({ workflowContext: nextContext as unknown })
    .where(
      and(
        eq(campaigns.id, input.campaignId),
        eq(campaigns.userId, input.userId),
        isNull(sql`JSON_EXTRACT(${campaigns.workflowContext}, '$.nextCycle')`)
      )
    );

  // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element.
  const affectedRows =
    (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;

  if (affectedRows > 0) {
    return {
      instruction: { instructionId: input.instructionId, status: "ready" },
      persisted: true,
    };
  }

  // A concurrent writer won the absent-nextCycle slot between our read and
  // this write. Reread through the same scoped authority and accept ONLY an
  // identical instructionId winner; anything else fails closed.
  const winner = await readScopedCampaign(executor, input.campaignId, input.userId);
  if (!winner) {
    throw new Error(
      `campaign ${input.campaignId} disappeared during next-cycle persistence reconciliation`
    );
  }
  const winnerInstruction = parseNextCycleInstruction(
    parseJsonObject(winner.workflowContext).nextCycle
  );
  if (winnerInstruction.instructionId !== input.instructionId) {
    throw new Error(
      `campaign ${input.campaignId} already persists a different next-cycle instruction`
    );
  }
  return { instruction: winnerInstruction, persisted: false };
}

export interface TransitionNextCycleInstructionResult {
  /** The durable instruction authority after this call. */
  instruction: NextCycleInstruction;
  /** True when this call performed the CAS write, false on replay. */
  transitioned: boolean;
}

/**
 * Exact-instruction CAS transition of the campaign's workflowContext.nextCycle
 * from "ready" to `toStatus` ("dispatched" | "failed").
 *
 * The campaign is owner-scoped, the instructionId must match exactly, and the
 * conditional UPDATE is matched on the current ready state, so a concurrent
 * transition wins the slot at most once. A zero-row UPDATE is reconciled by
 * rereading and accepting only an identical instruction already in
 * `toStatus`. Absent, malformed, conflicting or wrongly-statused state fails
 * closed. All other workflowContext fields are preserved.
 */
async function transitionNextCycleInstructionTo(input: {
  userId: number;
  campaignId: number;
  instructionId: string;
  toStatus: "dispatched" | "failed";
  executor?: NextCycleDbExecutor;
}): Promise<TransitionNextCycleInstructionResult | null> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.campaignId, "campaignId");
  if (typeof input.instructionId !== "string" || input.instructionId.trim().length === 0) {
    throw new Error("instructionId must be a non-blank string");
  }

  const executor = resolveExecutor(input.executor);

  const campaign = await readScopedCampaign(executor, input.campaignId, input.userId);
  if (!campaign) {
    return null;
  }

  const context = parseJsonObject(campaign.workflowContext);
  const existingNextCycle = context.nextCycle;

  if (existingNextCycle === undefined) {
    throw new Error(`campaign ${input.campaignId} has no next-cycle instruction`);
  }

  // Fail-closed strict parse: malformed stored state throws here.
  const instruction = parseNextCycleInstruction(existingNextCycle);

  if (instruction.instructionId !== input.instructionId) {
    throw new Error(
      `campaign ${input.campaignId} already persists a different next-cycle instruction`
    );
  }

  if (instruction.status === input.toStatus) {
    // Exact replay of an already-completed transition: idempotent no-op.
    return { instruction, transitioned: false };
  }

  if (instruction.status !== "ready") {
    throw new Error(
      `next-cycle instruction for campaign ${input.campaignId} is "${instruction.status}" and cannot transition to ${input.toStatus}`
    );
  }

  const nextContext = {
    ...context,
    nextCycle: { instructionId: input.instructionId, status: input.toStatus },
  };

  const updateResult = await executor
    .update(campaigns)
    .set({ workflowContext: nextContext as unknown })
    .where(
      and(
        eq(campaigns.id, input.campaignId),
        eq(campaigns.userId, input.userId),
        eq(
          sql`JSON_UNQUOTE(JSON_EXTRACT(${campaigns.workflowContext}, '$.nextCycle.instructionId'))`,
          input.instructionId
        ),
        eq(
          sql`JSON_UNQUOTE(JSON_EXTRACT(${campaigns.workflowContext}, '$.nextCycle.status'))`,
          "ready"
        )
      )
    );

  // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element.
  const affectedRows =
    (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;

  if (affectedRows > 0) {
    return {
      instruction: { instructionId: input.instructionId, status: input.toStatus },
      transitioned: true,
    };
  }

  // A concurrent transition won the ready slot between our read and this
  // write. Reread through the same scoped authority and accept ONLY an
  // identical instruction already in the target status; anything else fails
  // closed.
  const winner = await readScopedCampaign(executor, input.campaignId, input.userId);
  if (!winner) {
    throw new Error(
      `campaign ${input.campaignId} disappeared during next-cycle transition reconciliation`
    );
  }
  const winnerInstruction = parseNextCycleInstruction(
    parseJsonObject(winner.workflowContext).nextCycle
  );
  if (
    winnerInstruction.instructionId === input.instructionId &&
    winnerInstruction.status === input.toStatus
  ) {
    return { instruction: winnerInstruction, transitioned: false };
  }
  throw new Error(
    `next-cycle instruction for campaign ${input.campaignId} changed concurrently and cannot transition to ${input.toStatus}`
  );
}

/**
 * CAS transition of the campaign's next-cycle instruction from "ready" to
 * "dispatched". Exact-instructionId, owner-scoped, idempotent on identical
 * replay, fail-closed on every other state.
 */
export async function markNextCycleInstructionDispatched(input: {
  userId: number;
  campaignId: number;
  instructionId: string;
  executor?: NextCycleDbExecutor;
}): Promise<TransitionNextCycleInstructionResult | null> {
  return transitionNextCycleInstructionTo({ ...input, toStatus: "dispatched" });
}
