/**
 * Stale agent-run classification and terminalisation (WBS-R1.6, WBS-R4E).
 *
 * Forward reliability only: when a process dies between inserting an agent
 * run and completing it, the agentRuns row stays "running" forever,
 * polluting status-based dedup and workflow status displays. This module
 * classifies such runs (still running, started before the staleness TTL)
 * and terminalises them through an exact-once conditional write
 * (running → failed with an explicit stale reason).
 *
 * WBS-R4E: the staleness policy now covers every governed workflow agent
 * run type, not only strategy. A stuck audience/distribution run previously
 * blocked the forward chain permanently (the status-based dedup guards in
 * triggers/agent-router skip campaigns whose latest run is still
 * "running"), and the stuck row was never reaped because the reaper was
 * strategy-only. Terminalising it unblocks an idempotent retry of the same
 * logical step, which replays the same caller-stable billing identity and
 * therefore settles or releases at most once.
 *
 * Deliberately narrow: this is NOT a general historical-data recovery
 * executor. It only terminalises runs matching the staleness policy for a
 * specific owner-scoped campaign at a forward boundary; anything else is
 * left untouched.
 */

import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@db/schema";
import { getDb } from "../../queries/connection";

/** A run older than this while still "running" is stale. */
export const STALE_STRATEGY_RUN_TTL_MS = 30 * 60 * 1000;

/**
 * Governed workflow agent run types eligible for stale terminalisation.
 * Audience-intelligence runs persist agentType "audience" and are covered
 * by that entry.
 */
export type GovernedAgentRunType =
  | "strategy"
  | "creative"
  | "audience"
  | "distribution"
  | "engagement"
  | "sales"
  | "optimisation";

export const STALE_AGENT_RUN_TYPES: readonly GovernedAgentRunType[] = [
  "strategy",
  "creative",
  "audience",
  "distribution",
  "engagement",
  "sales",
  "optimisation",
];

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
 * Pure staleness classification. Only a run of an eligible agent type still
 * in "running" status can be stale; completed/failed rows are historical
 * evidence and are never touched.
 */
export function isStaleStrategyRun(input: {
  agentType: string;
  status: string;
  startedAt: unknown;
  now: Date;
  ttlMs?: number;
  agentTypes?: readonly GovernedAgentRunType[];
}): boolean {
  const eligibleTypes = input.agentTypes ?? ["strategy"];
  if (!eligibleTypes.includes(input.agentType as GovernedAgentRunType)) return false;
  if (input.status !== "running") return false;
  const startedAt = toEpochMillis(input.startedAt);
  if (startedAt === null) return false;
  const ttlMs = input.ttlMs ?? STALE_STRATEGY_RUN_TTL_MS;
  return input.now.getTime() - startedAt >= ttlMs;
}

/**
 * Terminalises the owner-scoped campaign's stale agent runs. Each
 * terminalisation is a conditional UPDATE matched on the row still being
 * "running", so a concurrent terminaliser cannot double-terminalise and an
 * already-completed run is never overwritten.
 *
 * agentTypes defaults to every governed workflow agent type (WBS-R4E): the
 * forward-chain dedup guards key on the latest run's status regardless of
 * type, so reaping only strategy runs left audience/distribution stalls
 * permanent. Callers that need the legacy strategy-only behaviour can pass
 * `agentTypes: ["strategy"]`.
 */
export async function terminaliseStaleStrategyRuns(input: {
  userId: number;
  campaignId: number;
  now?: Date;
  ttlMs?: number;
  agentTypes?: readonly GovernedAgentRunType[];
  executor?: StaleStrategyRunDbExecutor;
}): Promise<StaleStrategyRunSummary> {
  const executor = input.executor ?? getDb();
  const now = input.now ?? new Date();
  const agentTypes = input.agentTypes ?? STALE_AGENT_RUN_TYPES;

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
        inArray(agentRuns.agentType, [...agentTypes])
      )
    );

  let examined = 0;
  let terminalised = 0;

  for (const row of rows) {
    if (!isStaleStrategyRun({ ...row, now, ttlMs: input.ttlMs, agentTypes })) continue;
    examined += 1;

    const updateResult = await executor
      .update(agentRuns)
      .set({
        status: "failed",
        error: `Stale agent run terminalised: still running ${Math.round(
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
