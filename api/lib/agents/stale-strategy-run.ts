/**
 * Stale strategy-run classification and terminalisation (WBS-R1.6).
 *
 * Forward reliability only: when a process dies between inserting a strategy
 * agent run and completing it, the agentRuns row stays "running" forever,
 * polluting status-based dedup and workflow status displays. This module
 * classifies such runs (strategy type, still running, started before the
 * staleness TTL) and terminalises them through an exact-once conditional
 * write (running → failed with an explicit stale reason).
 *
 * Deliberately narrow: this is NOT a general historical-data recovery
 * executor. It only terminalises strategy runs matching the staleness policy
 * for a specific owner-scoped campaign at a forward boundary; anything else
 * is left untouched.
 */

import { and, eq } from "drizzle-orm";
import { agentRuns } from "@db/schema";
import { getDb } from "../../queries/connection";

/** A strategy run older than this while still "running" is stale. */
export const STALE_STRATEGY_RUN_TTL_MS = 30 * 60 * 1000;

type StrategyRunDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam. The default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape.
 */
export interface StaleStrategyRunDbExecutor {
  select: StrategyRunDb["select"];
  update: StrategyRunDb["update"];
}

export interface StaleStrategyRunSummary {
  examined: number;
  terminalised: number;
}

function toEpochMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? null : millis;
  }
  if (typeof value === "string" || typeof value === "number") {
    const millis = new Date(value).getTime();
    return Number.isNaN(millis) ? null : millis;
  }
  return null;
}

/**
 * Pure staleness classification. Only a strategy-type run still in "running"
 * status can be stale; completed/failed rows are historical evidence and are
 * never touched.
 */
export function isStaleStrategyRun(input: {
  agentType: string;
  status: string;
  startedAt: unknown;
  now: Date;
  ttlMs?: number;
}): boolean {
  if (input.agentType !== "strategy") return false;
  if (input.status !== "running") return false;
  const startedAt = toEpochMillis(input.startedAt);
  if (startedAt === null) return false;
  const ttlMs = input.ttlMs ?? STALE_STRATEGY_RUN_TTL_MS;
  return input.now.getTime() - startedAt >= ttlMs;
}

/**
 * Terminalises the owner-scoped campaign's stale strategy runs. Each
 * terminalisation is a conditional UPDATE matched on the row still being
 * "running", so a concurrent terminaliser cannot double-terminalise and an
 * already-completed run is never overwritten.
 */
export async function terminaliseStaleStrategyRuns(input: {
  userId: number;
  campaignId: number;
  now?: Date;
  ttlMs?: number;
  executor?: StaleStrategyRunDbExecutor;
}): Promise<StaleStrategyRunSummary> {
  const executor = input.executor ?? getDb();
  const now = input.now ?? new Date();

  const rows = await executor
    .select({
      id: agentRuns.id,
      agentType: agentRuns.agentType,
      status: agentRuns.status,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, input.userId),
        eq(agentRuns.campaignId, input.campaignId),
        eq(agentRuns.agentType, "strategy")
      )
    );

  let examined = 0;
  let terminalised = 0;

  for (const row of rows) {
    if (!isStaleStrategyRun({ ...row, now, ttlMs: input.ttlMs })) continue;
    examined += 1;

    const updateResult = await executor
      .update(agentRuns)
      .set({
        status: "failed",
        error: `Stale strategy run terminalised: still running ${Math.round(
          (now.getTime() - (toEpochMillis(row.startedAt) ?? now.getTime())) / 1000
        )}s after start.`,
        completedAt: now,
      })
      .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, "running")));

    const affectedRows =
      (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;
    if (affectedRows > 0) {
      terminalised += 1;
    }
  }

  return { examined, terminalised };
}
