import { TRPCError } from "@trpc/server";
import { isStaleStrategyRun } from "./stale-strategy-run";

/**
 * Strategy-entry duplicate/precondition guards (WBS-R4 A2-1).
 *
 * Pure classification helpers extracted from runStrategyAgent so the entry
 * semantics are unit-testable without harnessing the full agent. The
 * staleness rule is reused verbatim from stale-strategy-run.ts (WBS-R1.6):
 * only a strategy-type run still "running" past the 30-minute TTL is stale;
 * anything else live blocks re-entry with a CONFLICT.
 */

export interface StrategyEntryRunRecord {
  readonly id: number;
  readonly agentType: string;
  readonly status: string;
  readonly startedAt: unknown;
}

export interface StrategyEntryCampaignRecord {
  readonly id?: number;
  readonly businessId?: number | null;
}

export interface StrategyEntryGatesInput {
  readonly userId: number;
  readonly campaignId: number;
  readonly campaign: StrategyEntryCampaignRecord | null | undefined;
  readonly strategyRuns: readonly StrategyEntryRunRecord[];
  readonly now?: Date;
}

/**
 * Resolves the governed business linkage for the campaign, failing closed
 * when the campaign is not linked to a business (the historical NaN crash
 * inside snapshot materialization).
 */
export function resolveStrategyEntryBusinessId(
  campaign: StrategyEntryCampaignRecord | null | undefined
): number {
  const businessId = Number(campaign?.businessId);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "campaign must be linked to a business before strategy generation",
    });
  }
  return businessId;
}

/**
 * Returns the blocking non-stale running strategy run, if any. Stale rows are
 * deliberately ignored here: the WBS-R1.6 sweep terminalises them exactly
 * once at a forward boundary, and this guard must not delete or rewrite
 * historical evidence itself.
 */
export function findBlockingStrategyRun(
  strategyRuns: readonly StrategyEntryRunRecord[],
  now?: Date
): StrategyEntryRunRecord | null {
  const effectiveNow = now ?? new Date();
  for (const run of strategyRuns) {
    if (run.agentType !== "strategy") continue;
    if (run.status !== "running") continue;
    if (isStaleStrategyRun({ ...run, now: effectiveNow })) continue;
    return run;
  }
  return null;
}

/**
 * Enforces both entry guards before any run-row/evidence insert:
 *  1. the campaign must be linked to a positive-integer business, and
 *  2. no non-stale strategy run may already be in progress for the campaign.
 *
 * Returns the validated businessId on success.
 */
export function assertStrategyEntryGates(input: StrategyEntryGatesInput): {
  businessId: number;
} {
  const businessId = resolveStrategyEntryBusinessId(input.campaign);

  const blockingRun = findBlockingStrategyRun(input.strategyRuns, input.now);
  if (blockingRun) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `strategy run already in progress for campaign ${input.campaignId}`,
    });
  }

  return { businessId };
}
