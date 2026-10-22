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
