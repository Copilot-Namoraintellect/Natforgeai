/**
 * Cost-pause provenance authority (WBS-R1.4).
 *
 * When the autonomous workflow is paused for an affordability reason
 * (pauseWorkflowForCostLimit in billing/cost-control), the durable
 * continuation coordinates are recorded in the campaign's
 * workflowContext.costPause:
 *
 *   {
 *     kind:             agent_run_complete | strategy_approval |
 *                       launch_audience_intelligence,
 *     continuationId:   the runId / approvalId to resume from,
 *     reason:           the affordability reason recorded at pause time,
 *     recordedAt:       ISO timestamp of the pause,
 *     workflowState:    the campaign workflowState BEFORE the pause mutated it
 *   }
 *
 * The provenance is strict and fail-closed: a malformed payload is never
 * guessed. Recording preserves every other workflowContext field, replays
 * idempotently for an identical pause, and fails closed when a different
 * pause is already recorded — a campaign has at most ONE pending cost pause.
 */

import { and, eq } from "drizzle-orm";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { NextCycleDbExecutor } from "./next-cycle-persistence";

export const COST_PAUSE_CONTEXT_KEY = "costPause";

export const WORKFLOW_CONTINUATION_KINDS = [
  "agent_run_complete",
  "strategy_approval",
  "launch_audience_intelligence",
] as const;

export type WorkflowContinuationKind = (typeof WORKFLOW_CONTINUATION_KINDS)[number];

export interface CostPauseProvenance {
  kind: WorkflowContinuationKind;
  /** runId for agent_run_complete; approvalId for the approval kinds. */
  continuationId: number;
  /** Affordability reason recorded at pause time. */
  reason: string;
  /** ISO timestamp of the pause. */
  recordedAt: string;
  /** Campaign workflowState captured BEFORE the pause mutated it. */
  workflowState: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function buildCostPauseProvenance(input: {
  kind: WorkflowContinuationKind;
  continuationId: number;
  reason: string;
  workflowState: string;
  recordedAt?: string;
}): CostPauseProvenance {
  if (!WORKFLOW_CONTINUATION_KINDS.includes(input.kind)) {
    throw new Error(`cost pause kind must be one of ${WORKFLOW_CONTINUATION_KINDS.join(", ")}`);
  }
  if (!Number.isInteger(input.continuationId) || input.continuationId <= 0) {
    throw new Error("cost pause continuationId must be a positive integer");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new Error("cost pause reason must be a non-blank string");
  }
  if (typeof input.workflowState !== "string" || input.workflowState.trim().length === 0) {
    throw new Error("cost pause workflowState must be a non-blank string");
  }
  return {
    kind: input.kind,
    continuationId: input.continuationId,
    reason: input.reason,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    workflowState: input.workflowState,
  };
}

/**
 * Strict, fail-closed parser for a persisted costPause payload. Returns null
 * unless the payload is a complete, exactly-shaped provenance record.
 */
export function parseCostPauseProvenance(value: unknown): CostPauseProvenance | null {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (!["kind", "continuationId", "reason", "recordedAt", "workflowState"].includes(key)) {
      return null;
    }
  }
  if (!WORKFLOW_CONTINUATION_KINDS.includes(value.kind as WorkflowContinuationKind)) return null;
  if (
    !Number.isInteger(value.continuationId) ||
    (value.continuationId as number) <= 0
  ) {
    return null;
  }
  for (const field of ["reason", "recordedAt", "workflowState"] as const) {
    if (typeof value[field] !== "string" || (value[field] as string).trim().length === 0) {
      return null;
    }
  }
  return {
    kind: value.kind as WorkflowContinuationKind,
    continuationId: value.continuationId as number,
    reason: value.reason as string,
    recordedAt: value.recordedAt as string,
    workflowState: value.workflowState as string,
  };
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

/**
 * Records the durable cost-pause provenance on the owner-scoped campaign.
 * An identical pause replays idempotently; a conflicting pending pause fails
 * closed. Returns null when the campaign does not exist.
 */
export async function recordWorkflowCostPause(input: {
  userId: number;
  campaignId: number;
  provenance: CostPauseProvenance;
  executor?: NextCycleDbExecutor;
}): Promise<{ recorded: boolean } | null> {
  const executor = input.executor ?? getDb();

  const [campaign] = await executor
    .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);

  if (!campaign) {
    return null;
  }

  const context = parseWorkflowContextObject(campaign.workflowContext);
  const existingRaw = context[COST_PAUSE_CONTEXT_KEY];

  if (existingRaw !== undefined) {
    const existing = parseCostPauseProvenance(existingRaw);
    if (
      existing &&
      existing.kind === input.provenance.kind &&
      existing.continuationId === input.provenance.continuationId
    ) {
      // Identical pause already recorded (e.g. duplicate trigger): idempotent.
      return { recorded: false };
    }
    // A different pause is already pending: authority is never overwritten.
    throw new Error(
      `campaign ${input.campaignId} already records a different pending cost pause`
    );
  }

  await executor
    .update(campaigns)
    .set({
      workflowContext: {
        ...context,
        [COST_PAUSE_CONTEXT_KEY]: input.provenance,
      } as unknown,
    })
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)));

  return { recorded: true };
}
