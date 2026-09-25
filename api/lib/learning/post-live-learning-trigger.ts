/**
 * Governed post-live Learning trigger (WBS15.7, section E).
 *
 * The existing post-live reconciliation/scheduler can DETECT durable Learning
 * evidence and move a campaign into optimisation_active, but it never RUNS the
 * evaluation itself. This module closes that gap inside the SAME scheduler
 * architecture — no second scheduler is introduced.
 *
 * For every eligible post-live campaign (engagement_active or
 * leads_converting — the states that await Learning evidence), one governed
 * WBS15 Learning cycle is attempted BEFORE the lifecycle reconciliation of
 * that campaign, so a pass that produces durable Learning evidence can
 * transition the campaign in the same run.
 *
 * Safety properties:
 * - No fabricated Learning: the governed cycle fails closed when Strategy
 *   authority is missing and reports insufficient_data when no factual
 *   observations exist; neither outcome writes anything.
 * - No endless re-evaluation loop: the cycle is idempotent per
 *   (campaign, learning-v2, window); once the record exists, further passes
 *   replay it (idempotentReplay) instead of writing duplicates.
 * - Worker/scheduler restart-safe: the idempotency key carries a unique
 *   index and concurrent duplicate inserts resolve by re-reading the winner.
 * - No direct Strategy mutation: the only write target is learning_records.
 * - Failures are contained: an unexpected error is reported as an outcome,
 *   never thrown into the reconciliation pass.
 */

import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  runGovernedLearningCycle,
  type GovernedLearningCycleDeps,
  type GovernedLearningCycleResult,
} from "./learning-cycle-service";

/** Post-live states that await durable Learning evidence. */
export const POST_LIVE_LEARNING_ELIGIBLE_STATES = [
  "engagement_active",
  "leads_converting",
] as const;

export type PostLiveLearningTriggerOutcome =
  | {
      outcome: "recorded";
      campaignId: number;
      learningRecordId: number | null;
      idempotentReplay: boolean;
    }
  | { outcome: "insufficient_data"; campaignId: number; reason: string }
  | { outcome: "authority_missing"; campaignId: number; reason: string }
  | { outcome: "skipped_ineligible_state"; campaignId: number; workflowState: string }
  | { outcome: "campaign_not_found"; campaignId: number }
  | { outcome: "failed"; campaignId: number; reason: string };

export interface PostLiveLearningTriggerDeps {
  loadCampaignState?(campaignId: number): Promise<{
    id: number;
    userId: number;
    workflowState: string;
  } | null>;
  runCycle?(input: {
    userId: number;
    campaignId: number;
    trigger: "api";
    deps?: GovernedLearningCycleDeps;
  }): Promise<GovernedLearningCycleResult>;
}

async function loadCampaignStateFromDb(campaignId: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      workflowState: campaigns.workflowState,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return row ?? null;
}

/**
 * Attempts one governed Learning evaluation for a post-live campaign when
 * factual performance evidence may exist. Never throws; the outcome enum
 * carries every terminal state.
 */
export async function runGovernedPostLiveLearningTrigger(input: {
  campaignId: number;
  deps?: PostLiveLearningTriggerDeps;
}): Promise<PostLiveLearningTriggerOutcome> {
  if (!Number.isInteger(input.campaignId) || input.campaignId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "campaignId must be a positive integer",
    });
  }

  const loadState = input.deps?.loadCampaignState ?? loadCampaignStateFromDb;
  const campaign = await loadState(input.campaignId);
  if (!campaign) {
    return { outcome: "campaign_not_found", campaignId: input.campaignId };
  }

  if (
    !(POST_LIVE_LEARNING_ELIGIBLE_STATES as readonly string[]).includes(
      campaign.workflowState
    )
  ) {
    return {
      outcome: "skipped_ineligible_state",
      campaignId: input.campaignId,
      workflowState: campaign.workflowState,
    };
  }

  const runCycle = input.deps?.runCycle ?? runGovernedLearningCycle;
  try {
    const result = await runCycle({
      userId: campaign.userId,
      campaignId: input.campaignId,
      trigger: "api",
    });
    switch (result.status) {
      case "recorded":
        return {
          outcome: "recorded",
          campaignId: input.campaignId,
          learningRecordId: result.record.id,
          idempotentReplay: result.idempotentReplay,
        };
      case "insufficient_data":
        return {
          outcome: "insufficient_data",
          campaignId: input.campaignId,
          reason: result.reason,
        };
      case "authority_missing":
        return {
          outcome: "authority_missing",
          campaignId: input.campaignId,
          reason: result.reason,
        };
    }
  } catch (error) {
    // An unresolvable evaluation window (campaign without dates and without
    // any persisted observations) is an insufficient-data condition, not a
    // failure; the cycle itself reports it as a thrown BAD_REQUEST from the
    // dataset loader.
    if (
      error instanceof TRPCError &&
      error.code === "BAD_REQUEST" &&
      error.message.includes("No evaluation window could be resolved")
    ) {
      return {
        outcome: "insufficient_data",
        campaignId: input.campaignId,
        reason: error.message,
      };
    }
    // Contain every other unexpected failure: the reconciliation pass must
    // not fail because Learning could not run.
    return {
      outcome: "failed",
      campaignId: input.campaignId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
