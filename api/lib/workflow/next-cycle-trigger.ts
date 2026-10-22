/**
 * Learning promotion → next-cycle trigger (WBS-R1.2F).
 *
 * triggerNextCycleAfterLearningPromotion initiates the next governed Strategy
 * cycle ONLY from durable, human-approved Learning promotion authority:
 *
 * - Availability is fail-closed through resolveApprovedLearningPromotionsFor
 *   Strategy: pending or rejected proposals, tampered contexts, unsealed
 *   approvals and drifted learning authority produce no eligible input, so
 *   they can never trigger a cycle. Nothing is reclassified — every consumed
 *   promotion keeps its approved_recommendation provenance.
 * - The instruction identity is deterministic over the exact cycle material:
 *   the campaign, the authoritative current Strategy hash and the canonical
 *   sorted set of approved proposal fingerprints the next cycle will consume
 *   (the same scope-safe set the strategy pathway resolves). Identical
 *   material always yields the identical instruction, so repeated triggers or
 *   retries collapse onto one durable instruction instead of creating another
 *   cycle. Changed material while an instruction is pending fails closed at
 *   the persistence authority.
 * - The durable instruction is written through persistNextCycleInstruction:
 *   exactly-once, replay-idempotent, owner-scoped.
 *
 * This module performs NO Strategy execution and NO approval creation; it
 * only mints the identity and persists the ready instruction for the
 * governed dispatcher.
 */

import { and, eq } from "drizzle-orm";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  buildNextCycleIdentity,
  resolveApprovedLearningPromotionsForStrategy,
  type ApprovedLearningStrategyInput,
} from "../learning/learning-strategy-consumption";
import {
  persistNextCycleInstruction,
  type NextCycleDbExecutor,
} from "./next-cycle-persistence";

export interface NextCycleTriggerDeps {
  /** Executor for the owner-scoped campaign/instruction authority. */
  executor?: NextCycleDbExecutor;
  /**
   * Approved-promotion resolution boundary (defaults to the fail-closed
   * same-business resolver used by the strategy pathway itself).
   */
  resolveApprovedPromotions?: (input: {
    userId: number;
    campaignId: number;
  }) => Promise<ApprovedLearningStrategyInput>;
}

export type NextCycleTriggerResult =
  | { outcome: "created"; instructionId: string }
  | { outcome: "already_present"; instructionId: string }
  | { outcome: "no_approved_promotions" };

async function readStrategyHashAuthority(
  executor: NextCycleDbExecutor,
  campaignId: number,
  userId: number
): Promise<unknown> {
  const [campaign] = await executor
    .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) return null;
  const context =
    campaign.workflowContext && typeof campaign.workflowContext === "object"
      ? (campaign.workflowContext as Record<string, unknown>)
      : {};
  return context.strategyHashSha256;
}

/**
 * Mints the deterministic next-cycle instruction for the campaign's current
 * approved Learning material and persists it (ready) exactly once. Returns
 * null when the campaign does not exist for (campaignId, userId).
 */
export async function triggerNextCycleAfterLearningPromotion(input: {
  userId: number;
  campaignId: number;
  deps?: NextCycleTriggerDeps;
}): Promise<NextCycleTriggerResult | null> {
  const executor = input.deps?.executor ?? getDb();

  // Authoritative current Strategy hash for this campaign. Absent or invalid
  // authority fails closed (buildNextCycleIdentity validates the format).
  const strategyHashSha256 = await readStrategyHashAuthority(
    executor,
    input.campaignId,
    input.userId
  );
  if (strategyHashSha256 === null) {
    return null;
  }

  const resolveApprovedPromotions =
    input.deps?.resolveApprovedPromotions ??
    ((args: { userId: number; campaignId: number }) =>
      resolveApprovedLearningPromotionsForStrategy(args));

  // Fail-closed durable approval authority: pending/rejected/unsealed or
  // drifted promotions never appear here.
  const approved = await resolveApprovedPromotions({
    userId: input.userId,
    campaignId: input.campaignId,
  });

  if (approved.promotions.length === 0) {
    return { outcome: "no_approved_promotions" };
  }

  const proposalFingerprints = approved.promotions.map(p => p.proposalFingerprint);

  const instructionId = buildNextCycleIdentity({
    campaignId: input.campaignId,
    strategyHashSha256: strategyHashSha256 as string,
    proposalFingerprints,
  });

  const persisted = await persistNextCycleInstruction({
    userId: input.userId,
    campaignId: input.campaignId,
    instructionId,
    executor: input.deps?.executor,
  });
  if (!persisted) {
    return null;
  }

  return {
    outcome: persisted.persisted ? "created" : "already_present",
    instructionId,
  };
}
