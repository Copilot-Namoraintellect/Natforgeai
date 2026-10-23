/**
 * Governed next-cycle dispatcher (WBS-R1.2E).
 *
 * dispatchNextCycleInstruction consumes ONE durable next-cycle instruction
 * (workflowContext.nextCycle, ready) and turns it into a NEW governed
 * Strategy cycle:
 *
 * - Exact-once: the instruction is claimed with the ready→dispatched CAS
 *   transition BEFORE any strategy work. A concurrent dispatcher that wins
 *   the slot first turns this call into an idempotent
 *   { outcome: "already_dispatched" } no-op — the strategy pathway is never
 *   invoked twice for one instruction.
 * - Existing Strategy authority: the run goes through the existing
 *   runStrategyAgent pathway, so the future Strategy is a NEW governed
 *   Strategy snapshot/version (new agent run, new snapshot version) and the
 *   run inherits the existing cost control and approved-Learning-envelope
 *   handling. No old Strategy, Business DNA, Learning, Creative or
 *   publication artefact is mutated.
 * - Normal strategy_review governance: after a successful run exactly one
 *   pending strategy_review approval request is created for the new run
 *   (older pending requests superseded, lineage bound to the immutable
 *   snapshot authority) — the same approval type and flow as every other
 *   strategy regeneration. No new approval type or workflow state is
 *   invented.
 * - Consistent terminal state: a failed strategy run durably records the
 *   dispatcher-owned dispatched→failed transition so retries fail closed
 *   instead of re-running. A successful run restores the dispatched marker
 *   next to the new strategy projections (the strategy pathway rewrites
 *   workflowContext) together with the strategy_review lineage.
 *
 * External boundaries (strategy run, review-request creation) are injectable
 * so the orchestration is testable without providers or a database.
 */

import { and, eq } from "drizzle-orm";
import { approvalRequests, businesses, campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import { runStrategyAgent, chargeForStrategyRun } from "../agents/strategy-agent";
import { buildGroundedCreativeBrief } from "../creative/brief-grounding";
import { getStrategySnapshotByStrategyRunId } from "../strategy/strategy-snapshot-db-store";
import { createApprovalRequest } from "./engine";
import {
  buildStrategyApprovalLineage,
  type StrategyApprovalLineage,
} from "./strategy-approval";
import {
  markDispatchedNextCycleInstructionFailed,
  markNextCycleInstructionDispatched,
  type NextCycleDbExecutor,
} from "./next-cycle-persistence";

/** Business authority input accepted by the existing strategy pathway. */
export interface NextCycleStrategyBusinessInput {
  name: string;
  industry?: string | null;
  location?: string | null;
  productOrService?: string | null;
  targetCustomer?: string | null;
  brandTone?: string | null;
  mainGoal?: string | null;
  monthlyBudget?: number | null;
  preferredPlatforms?: string | null;
  website?: string | null;
  websiteEvidence?: unknown;
}

export interface NextCycleDispatchDeps {
  /** Executor for campaign/instruction authority reads and writes. */
  executor?: NextCycleDbExecutor;
  /** Strategy run boundary (defaults to the existing runStrategyAgent pathway). */
  runStrategy?: (input: {
    userId: number;
    campaignId: number;
    business: NextCycleStrategyBusinessInput;
  }) => Promise<{ runId: number }>;
  /** strategy_review governance boundary (defaults to the existing request flow). */
  createStrategyReview?: (input: {
    userId: number;
    campaignId: number;
    strategyRunId: number;
    campaignName: string;
    campaign: unknown;
    business: unknown;
  }) => Promise<{ approvalRequestId: number; lineage: StrategyApprovalLineage }>;
}

export type NextCycleDispatchResult =
  | {
      outcome: "dispatched";
      instructionId: string;
      strategyRunId: number;
      approvalRequestId: number;
    }
  | { outcome: "already_dispatched"; instructionId: string };

type BusinessRow = typeof businesses.$inferSelect;
type CampaignRow = typeof campaigns.$inferSelect;

function toStrategyBusinessInput(business: BusinessRow): NextCycleStrategyBusinessInput {
  return {
    name: business.name,
    industry: business.industry ?? null,
    location: business.location || null,
    productOrService: business.productOrService ?? null,
    targetCustomer: business.targetCustomer ?? null,
    brandTone: business.brandTone ?? null,
    mainGoal: business.mainGoal ?? null,
    monthlyBudget: business.monthlyBudget ?? null,
    preferredPlatforms: business.preferredPlatforms ?? null,
    website: business.website ?? null,
    websiteEvidence: business.websiteEvidence ?? null,
  };
}

async function defaultRunStrategy(input: {
  userId: number;
  campaignId: number;
  business: NextCycleStrategyBusinessInput;
}): Promise<{ runId: number }> {
  const result = await runStrategyAgent({
    userId: input.userId,
    campaignId: input.campaignId,
    business: input.business,
  });

  // WBS-R4 X3.2 (Stream E contract §5): this dispatch path is now a live
  // production caller, so the fresh Strategy run is charged exactly once
  // under the stable server-derived identity strategy-run-${runId} — the
  // same treatment as the campaign-create flow. A charge failure must not
  // strand the lifecycle (the reuse/reconcile paths recover a missing
  // durable charge later), so it is logged and dispatch still advances.
  try {
    await chargeForStrategyRun(input.userId, input.campaignId, result);
  } catch (chargeError: any) {
    console.error(
      `[NextCycle] Strategy charge failed for campaign ${input.campaignId}:`,
      chargeError?.message ?? chargeError
    );
  }

  return { runId: result.runId };
}

/**
 * Normal strategy_review governance for a newly generated strategy run:
 * supersede older pending strategy_review requests, create exactly one
 * pending request for the new run, and bind the immutable snapshot authority
 * into the returned lineage. The caller persists the lineage.
 */
async function defaultCreateStrategyReview(input: {
  userId: number;
  campaignId: number;
  strategyRunId: number;
  campaignName: string;
  campaign: unknown;
  business: unknown;
}): Promise<{ approvalRequestId: number; lineage: StrategyApprovalLineage }> {
  const snapshotAuthority = await getStrategySnapshotByStrategyRunId(input.strategyRunId);
  if (
    !snapshotAuthority ||
    snapshotAuthority.userId !== input.userId ||
    snapshotAuthority.campaignId !== input.campaignId
  ) {
    throw new Error(
      "The Strategy run is missing or does not match immutable Strategy snapshot authority. Regenerate the strategy before requesting approval."
    );
  }

  const db = getDb();

  const existingPendingRequests = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.campaignId, input.campaignId),
        eq(approvalRequests.userId, input.userId),
        eq(approvalRequests.approvalType, "strategy_review"),
        eq(approvalRequests.status, "pending")
      )
    );

  for (const oldRequest of existingPendingRequests) {
    await db
      .update(approvalRequests)
      .set({
        status: "rejected",
        rejectedAt: new Date(),
        description: `${oldRequest.description || ""}\n\nSuperseded: a new strategy was generated for the next governed cycle.`.trim(),
      })
      .where(eq(approvalRequests.id, oldRequest.id));
  }

  const { id: approvalRequestId } = await createApprovalRequest({
    userId: input.userId,
    campaignId: input.campaignId,
    approvalType: "strategy_review",
    title: `Approve Strategy: ${input.campaignName}`,
    description: `The strategy for "${input.campaignName}" has been regenerated for the next governed cycle from the current campaign brief. Review and approve to continue to creative content generation.`,
    aiRecommendation:
      "Based on the updated campaign brief, business profile and approved Learning recommendations, this strategy aligns with the current goal and target audience.",
    riskLevel: "low",
  });

  const fingerprint = buildGroundedCreativeBrief({
    campaign: input.campaign,
    business: input.business,
  }).fingerprint;

  const lineage = buildStrategyApprovalLineage(
    fingerprint,
    input.strategyRunId,
    approvalRequestId,
    "pending",
    {
      strategySnapshotId: snapshotAuthority.snapshotId,
      strategyVersion: snapshotAuthority.version,
      businessDnaSnapshotId: snapshotAuthority.businessDnaSnapshotId,
      strategyHashSha256: snapshotAuthority.strategyHashSha256,
    }
  );

  return { approvalRequestId, lineage };
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
 * Loads the full owner-scoped campaign row: the strategy pathway grounds on
 * the persisted brief, and the strategy_review lineage fingerprint must be
 * computed from the exact same material.
 */
async function readDispatchCampaign(
  executor: NextCycleDbExecutor,
  campaignId: number,
  userId: number
): Promise<CampaignRow | null> {
  const [campaign] = await executor
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  return campaign ?? null;
}

async function readDispatchBusiness(
  executor: NextCycleDbExecutor,
  businessId: number,
  userId: number
): Promise<BusinessRow | null> {
  const [business] = await executor
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.userId, userId)))
    .limit(1);

  return business ?? null;
}

/**
 * Restores the durable terminal state after a successful run: the strategy
 * pathway rewrites workflowContext, so the dispatched instruction marker and
 * the strategy_review lineage are merged back over the freshest context.
 */
async function writeDispatchedTerminalState(
  executor: NextCycleDbExecutor,
  input: {
    campaignId: number;
    userId: number;
    instructionId: string;
    lineage: StrategyApprovalLineage;
  }
): Promise<void> {
  const [campaign] = await executor
    .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);
  if (!campaign) {
    throw new Error(`campaign ${input.campaignId} not found while recording next-cycle dispatch`);
  }

  const context = parseWorkflowContextObject(campaign.workflowContext);
  await executor
    .update(campaigns)
    .set({
      workflowContext: {
        ...context,
        nextCycle: { instructionId: input.instructionId, status: "dispatched" },
        strategyApprovalLineage: input.lineage,
      } as unknown,
    })
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)));
}

/**
 * Consumes a durable ready next-cycle instruction and dispatches exactly one
 * governed Strategy cycle for it. See the module doc for the full contract.
 */
export async function dispatchNextCycleInstruction(input: {
  userId: number;
  campaignId: number;
  instructionId: string;
  deps?: NextCycleDispatchDeps;
}): Promise<NextCycleDispatchResult> {
  // 1. Claim the instruction. Absent, malformed, conflicting, failed or
  //    concurrent-dispatched state fails closed here; an identical
  //    already-dispatched instruction replays without re-running.
  const claim = await markNextCycleInstructionDispatched({
    userId: input.userId,
    campaignId: input.campaignId,
    instructionId: input.instructionId,
    executor: input.deps?.executor,
  });
  if (!claim) {
    throw new Error(`campaign ${input.campaignId} not found for next-cycle dispatch`);
  }
  if (!claim.transitioned) {
    return { outcome: "already_dispatched", instructionId: input.instructionId };
  }

  const executor = input.deps?.executor ?? getDb();

  // 2. Owner-scoped campaign + business authority for the strategy run.
  const campaign = await readDispatchCampaign(executor, input.campaignId, input.userId);
  if (!campaign) {
    throw new Error(`campaign ${input.campaignId} not found for next-cycle dispatch`);
  }
  const business =
    typeof campaign.businessId === "number" &&
    Number.isInteger(campaign.businessId) &&
    campaign.businessId > 0
      ? await readDispatchBusiness(executor, campaign.businessId, input.userId)
      : null;
  if (!business) {
    try {
      await markDispatchedNextCycleInstructionFailed({
        userId: input.userId,
        campaignId: input.campaignId,
        instructionId: input.instructionId,
        executor: input.deps?.executor,
      });
    } catch {
      // The missing-business error below is authoritative for the caller.
    }
    throw new Error(
      `campaign ${input.campaignId} has no durable business authority for next-cycle dispatch`
    );
  }

  const runStrategy = input.deps?.runStrategy ?? defaultRunStrategy;
  const createStrategyReview = input.deps?.createStrategyReview ?? defaultCreateStrategyReview;

  // 3. The existing strategy pathway (cost control, approved-Learning
  //    envelopes and NEW governed snapshot versioning live inside it).
  let strategyRunId: number;
  try {
    const strategyResult = await runStrategy({
      userId: input.userId,
      campaignId: input.campaignId,
      business: toStrategyBusinessInput(business),
    });
    strategyRunId = strategyResult.runId;
  } catch (error) {
    try {
      await markDispatchedNextCycleInstructionFailed({
        userId: input.userId,
        campaignId: input.campaignId,
        instructionId: input.instructionId,
        executor: input.deps?.executor,
      });
    } catch {
      // The original run error is authoritative for the caller.
    }
    throw error;
  }

  // 4. Normal strategy_review governance for the new run.
  const review = await createStrategyReview({
    userId: input.userId,
    campaignId: input.campaignId,
    strategyRunId,
    campaignName: campaign.name,
    campaign: campaign,
    business,
  });

  // 5. Restore the terminal dispatched marker + lineage over the strategy
  //    pathway's rewritten workflowContext.
  await writeDispatchedTerminalState(executor, {
    campaignId: input.campaignId,
    userId: input.userId,
    instructionId: input.instructionId,
    lineage: review.lineage,
  });

  return {
    outcome: "dispatched",
    instructionId: input.instructionId,
    strategyRunId,
    approvalRequestId: review.approvalRequestId,
  };
}
