import { getDb } from "../../queries/connection";
import {
  agentRuns,
  campaigns,
  businesses,
  approvalRequests,
  publishingQueue,
  creditTransactions,
  contentPosts,
  creativeGenerationClaims,
} from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { transitionCampaignState, createApprovalRequest } from "./engine";
import { resolveCreativeWorkflowState } from "./progress-logic";
import { runCreativeAgent } from "../agents/creative-agent";
import { runDistributionAgent } from "../agents/distribution-agent";
import { runAudienceAgent } from "../agents/audience-agent";
import { runAudienceIntelligenceAgent } from "../agents/audience-intelligence-agent";
import { checkAudienceAgentAccess } from "../audience/access";
import { canRunAutonomousWorkflow } from "../billing/cost-control";
import { ingestAudienceData } from "../audience/ingest";
import {
  acquireCreativeGenerationClaim,
  rearmCreativeGenerationClaim,
  generateOwnerToken,
  releaseClaimWithResult,
  calculateLeaseExpiresAt,
  createClaimHeartbeatController,
  type CreativeGenerationClaim,
  type CreativeGenerationClaimHeartbeatController,
} from "../creative/creative-generation-claim";
import { env } from "../env";
import {
  getStrategyApprovalStatus,
  buildStrategyApprovalLineage,
  validateStrategyRunForCampaign,
} from "./strategy-approval";

export async function onAgentRunComplete(runId: number) {
  const db = getDb();
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);

  if (!run || run.status !== "completed" || !run.campaignId) return;

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, run.campaignId))
    .limit(1);

  if (!campaign) return;

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, run.userId)))
        .limit(1)
    : [null];

  // Check cost control before auto-advancing
  const autoCheck = await canRunAutonomousWorkflow(run.userId, run.campaignId);
  if (!autoCheck.allowed) {
    console.log(`[Workflow] Auto-advance blocked for campaign ${run.campaignId}: ${autoCheck.reason}`);
    return;
  }

  const state = campaign.workflowState;

  // Auto-advance workflow based on agent completion
  if (state === "strategy_pending" && run.agentType === "strategy") {
    await transitionCampaignState(run.campaignId, run.userId, "generate_strategy");

    // Create strategy approval request
    const [updatedCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, run.campaignId))
      .limit(1);

    if (updatedCampaign) {
      const { id: approvalRequestId } = await createApprovalRequest({
        userId: run.userId,
        campaignId: run.campaignId,
        approvalType: "strategy_review",
        title: `Approve Strategy: ${updatedCampaign.name}`,
        description: `The strategy for "${updatedCampaign.name}" has been generated. Review and approve to continue to creative content generation.`,
        aiRecommendation: "Based on the campaign goal and target audience, this strategy aligns with best practices for the selected platforms.",
        riskLevel: "low",
      });

      const status = getStrategyApprovalStatus(updatedCampaign, business);
      await db
        .update(campaigns)
        .set({
          workflowContext: {
            ...(updatedCampaign.workflowContext || {}),
            strategyApprovalLineage: buildStrategyApprovalLineage(
              status.currentFingerprint,
              run.id,
              approvalRequestId
            ),
          } as any,
        })
        .where(eq(campaigns.id, run.campaignId));
    }
  } else if (["strategy_approved", "creatives_generating"].includes(state) && run.agentType === "creative") {
    if (state === "strategy_approved") {
      await transitionCampaignState(run.campaignId, run.userId, "generate_creatives");
    }

    const [latestCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, run.campaignId))
      .limit(1);

    // Verify that the creative agent actually saved posts before transitioning
    const ctx = ((latestCampaign?.workflowContext || campaign.workflowContext) || {}) as any;
    const savedPosts = ctx.savedPosts ?? 0;
    if (savedPosts === 0) {
      console.error(`[Workflow] Creative agent for campaign ${run.campaignId} completed but savedPosts=0. Not transitioning state.`);
      return;
    }

    const resolvedCreativeState = resolveCreativeWorkflowState({
      currentState: state,
      strategyApproved: state === "strategy_approved" || state === "creatives_generating",
      creativeRunStatus: "completed",
      savedPosts,
    });

    if (resolvedCreativeState === "creatives_ready") {
      await transitionCampaignState(run.campaignId, run.userId, "creatives_complete");
    }

    // Auto-trigger audience agent after creatives are ready — with dedup guard
    try {
      const existingAudience = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, run.campaignId),
            eq(agentRuns.agentType, "audience"),
            eq(agentRuns.userId, run.userId)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingAudience.length > 0 && ["running", "completed"].includes(existingAudience[0].status)) {
        console.log(`[Workflow] Skipping duplicate audience run for campaign ${run.campaignId}. Existing run ${existingAudience[0].id} is ${existingAudience[0].status}.`);
      } else {
        const audienceResult = await runAudienceAgent({
          userId: run.userId,
          campaignId: run.campaignId,
        });
        await onAgentRunComplete(audienceResult.runId);
      }
    } catch (err: any) {
      console.error("[Workflow] Auto-audience failed:", err.message);
    }
  } else if (state === "audience_generating" && run.agentType === "audience") {
    await transitionCampaignState(run.campaignId, run.userId, "audience_complete");

    // Auto-trigger distribution agent after audience is ready — with dedup guard
    try {
      const existingDist = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.campaignId, run.campaignId),
            eq(agentRuns.agentType, "distribution"),
            eq(agentRuns.userId, run.userId)
          )
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);

      if (existingDist.length > 0 && ["running", "completed"].includes(existingDist[0].status)) {
        console.log(`[Workflow] Skipping duplicate distribution run for campaign ${run.campaignId}. Existing run ${existingDist[0].id} is ${existingDist[0].status}.`);
      } else {
        const distResult = await runDistributionAgent({
          userId: run.userId,
          campaignId: run.campaignId,
          approvalMode: campaign.approvalMode as "assisted" | "autonomous",
        });
        await onAgentRunComplete(distResult.runId);
      }
    } catch (err: any) {
      console.error("[Workflow] Auto-distribution failed:", err.message);
    }
  } else if (state === "schedule_generated" && run.agentType === "distribution") {
    // Create launch approval request
    await createApprovalRequest({
      userId: run.userId,
      campaignId: run.campaignId,
      approvalType: "campaign_launch",
      title: `Approve Launch: ${campaign.name}`,
      description: `The campaign "${campaign.name}" is ready to launch. All strategy, creative, audience, and schedule assets have been generated.`,
      aiRecommendation: "Based on the generated strategy and content, this campaign is ready to go live. Expected reach aligns with budget allocation.",
      riskLevel: "low",
    });
    await transitionCampaignState(run.campaignId, run.userId, "request_launch_approval");
  }
}

export async function onApprovalResolved(approvalId: number, decision: "approved" | "rejected", userId: number) {
  const db = getDb();

  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);

  if (!request) {
    throw new Error("Approval request not found");
  }

  const campaignId = request.campaignId;
  if (!campaignId) return;

  if (request.approvalType === "campaign_launch") {
    if (decision === "approved") {
      await transitionCampaignState(campaignId, userId, "approve_launch");

      // Optional: auto-run audience intelligence after launch approval
      try {
        const access = await checkAudienceAgentAccess(userId, null);
        const autoCheck = await canRunAutonomousWorkflow(userId, campaignId);
        if (access.allowed && autoCheck.allowed) {
          await runAudienceIntelligenceAgent({
            userId,
            campaignId,
            autoCreateLeads: false,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Workflow] Auto audience-intelligence failed for campaign ${campaignId}:`, message);
      }
    } else {
      await transitionCampaignState(campaignId, userId, "reject_launch");
    }
  } else if (request.approvalType === "brand_risk") {
    // Find associated publishing queue items for this campaign that are safety_blocked or pending_approval
    const queueItems = await db
      .select()
      .from(publishingQueue)
      .where(
        and(
          eq(publishingQueue.campaignId, campaignId),
          eq(publishingQueue.userId, userId),
          eq(publishingQueue.status, "pending_approval")
        )
      );

    if (decision === "approved") {
      for (const item of queueItems) {
        await db
          .update(publishingQueue)
          .set({ status: "approved", approvalRequired: false })
          .where(eq(publishingQueue.id, item.id));
      }
    }
    // If rejected, leave them as pending_approval / safety_blocked
  } else if (request.approvalType === "strategy_review") {
    if (decision === "approved") {
      await onStrategyApproved(campaignId, userId, approvalId);
    } else {
      await transitionCampaignState(campaignId, userId, "request_strategy_changes");
    }
  }
}

async function hasSuccessfulCreativeGenerationForApproval(
  userId: number,
  campaignId: number,
  approvalId: number,
  currentFingerprint: string
): Promise<boolean> {
  const db = getDb();

  // Fast path: a successful creative charge already recorded for this exact approval.
  const idempotencyKey = `creative-success:${campaignId}:approval:${approvalId}`;
  const [existingCharge] = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.type, "agent_deduction"),
        eq(creditTransactions.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);

  if (existingCharge) {
    return true;
  }

  // Fallback: a completed creative run whose saved posts reference this fingerprint.
  const completedRuns = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.agentType, "creative"),
        eq(agentRuns.status, "completed")
      )
    );

  if (completedRuns.length === 0) {
    return false;
  }

  const posts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.userId, userId),
        eq(contentPosts.campaignId, campaignId)
      )
    );

  for (const run of completedRuns) {
    const runIdTag = `pack-${run.id}`;
    for (const post of posts) {
      const metadata = (post.metadata ?? {}) as Record<string, unknown>;
      if (
        metadata.generationRunId === runIdTag &&
        metadata.creativeBriefFingerprint === currentFingerprint
      ) {
        return true;
      }
    }
  }

  return false;
}

async function hasInProgressCreativeGeneration(
  userId: number,
  campaignId: number,
  approvalId: number
): Promise<boolean> {
  const db = getDb();

  const runningClaim = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.userId, userId),
        eq(creativeGenerationClaims.campaignId, campaignId),
        eq(creativeGenerationClaims.operationSource, "approval"),
        eq(creativeGenerationClaims.operationReferenceId, approvalId),
        eq(creativeGenerationClaims.status, "running")
      )
    )
    .limit(1);

  if (runningClaim.length > 0) {
    return true;
  }

  const runningRun = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.agentType, "creative"),
        eq(agentRuns.status, "running")
      )
    )
    .limit(1);

  return runningRun.length > 0;
}

export async function onStrategyApproved(
  campaignId: number,
  userId: number,
  approvalId: number
) {
  const db = getDb();
  let [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) return;

  const [business] = campaign.businessId
    ? await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.id, campaign.businessId), eq(businesses.userId, userId)))
        .limit(1)
    : [null];

  // Defence in depth: the synchronous approval router already validates, but
  // the async trigger may run after a brief edit. Reject stale strategy
  // approvals before any credits or claims are consumed.
  const status = getStrategyApprovalStatus(campaign, business);
  const lineage = status.lineage;
  const currentFingerprint = status.currentFingerprint;

  if (!lineage) {
    console.error(`[Workflow] No strategy approval lineage for campaign ${campaignId}. Refusing to authorise creative generation.`);
    return;
  }

  if (lineage.approvalRequestId !== approvalId) {
    console.error(
      `[Workflow] Strategy approval lineage mismatch for campaign ${campaignId}: expected request ${lineage.approvalRequestId}, got ${approvalId}.`
    );
    return;
  }

  if (lineage.creativeBriefFingerprint !== currentFingerprint) {
    console.error(
      `[Workflow] Strategy approval fingerprint mismatch for campaign ${campaignId}. Refusing to authorise creative generation.`
    );
    return;
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, lineage.strategyRunId),
        eq(agentRuns.campaignId, campaignId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.agentType, "strategy")
      )
    )
    .limit(1);

  if (!run || run.status !== "completed") {
    console.error(
      `[Workflow] Linked strategy run ${lineage.strategyRunId} is missing or not completed for campaign ${campaignId}. Refusing to authorise creative generation.`
    );
    return;
  }

  // A fingerprint match is not sufficient: the linked strategy output must still
  // be semantically grounded in the current brief. Pass the already-loaded run
  // to avoid a duplicate database query.
  const semanticValidation = await validateStrategyRunForCampaign(campaign, userId, run, business);
  if (!semanticValidation.valid) {
    console.error(
      `[Workflow] Linked strategy run ${lineage.strategyRunId} failed semantic validation for campaign ${campaignId}: ${semanticValidation.reason}. Refusing to authorise creative generation.`
    );
    return;
  }

  // 1. Persist the approved lineage and authorised fingerprint FIRST so the
  // function becomes idempotent: subsequent calls see an approved lineage and
  // will not double-spend credits or double-generate content.
  const needsApprovalPersistence =
    status.approvedStrategyFingerprint !== currentFingerprint ||
    lineage.status !== "approved";

  if (needsApprovalPersistence) {
    await db
      .update(campaigns)
      .set({
        workflowContext: {
          ...(campaign.workflowContext || {}),
          approvedStrategyFingerprint: currentFingerprint,
          strategyApprovalLineage: {
            ...lineage,
            status: "approved",
          },
        } as any,
      })
      .where(eq(campaigns.id, campaignId));

    // Only transition from the state that the approval action is valid for.
    // If the campaign has already advanced (e.g. a retry after partial failure),
    // the persisted lineage/fingerprint above is sufficient evidence.
    if (campaign.workflowState === "strategy_generated") {
      await transitionCampaignState(campaignId, userId, "approve_strategy");
    }

    const [reloadedCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (reloadedCampaign) {
      campaign = reloadedCampaign;
    }
  }

  // 2. Idempotent dedup: skip if creative generation has already succeeded for
  // THIS specific approval. The unique creative-success charge idempotency key is
  // the authoritative evidence; the content-post fallback covers pre-idempotency
  // historical runs.
  const alreadyGenerated = await hasSuccessfulCreativeGenerationForApproval(
    userId,
    campaignId,
    approvalId,
    currentFingerprint
  );
  if (alreadyGenerated) {
    console.log(`[Workflow] Successful creative generation already recorded for approval ${approvalId}; skipping duplicate`);
    return;
  }

  // 3. In-progress dedup: do not start a second concurrent generation for the
  // same approval.
  const inProgress = await hasInProgressCreativeGeneration(userId, campaignId, approvalId);
  if (inProgress) {
    console.log(`[Workflow] Creative generation already in progress for approval ${approvalId}; skipping duplicate`);
    return;
  }

  // 4. Cost control check BEFORE acquiring or re-arming a claim. A negative
  // result returns without touching claim state.
  const autoCheck = await canRunAutonomousWorkflow(userId, campaignId);
  if (!autoCheck.allowed) {
    console.log(`[Workflow] Auto-creative blocked for campaign ${campaignId}: ${autoCheck.reason}`);
    return;
  }

  // 5. Authoritative atomic claim for the auto-creative step of this approval.
  //    First try to re-arm a terminal orphan claim so historical evidence is
  //    preserved.  A terminal claim is only an orphan if no success evidence was
  //    found above; otherwise we would have already returned.
  const ownerToken = generateOwnerToken();
  const leaseExpiresAt = calculateLeaseExpiresAt(env.creativeGenerationRunningLeaseSeconds);

  const rearmResult = await rearmCreativeGenerationClaim({
    userId,
    campaignId,
    operationSource: "approval",
    operationReferenceId: approvalId,
    ownerToken,
    leaseExpiresAt,
  });

  let claim: CreativeGenerationClaim;
  if (rearmResult) {
    claim = rearmResult.claim;
    console.log(`[Workflow] Re-armed orphan creative generation claim ${claim.id} for campaign ${campaignId}; proceeding with recovery`);
  } else {
    const claimResult = await acquireCreativeGenerationClaim({
      userId,
      campaignId,
      operationSource: "approval",
      operationReferenceId: approvalId,
      ownerToken,
      leaseExpiresAt,
    });

    if (!claimResult.acquired) {
      // A concurrent caller may have re-armed the claim between our checks.
      // Only return an idempotent no-op if there is genuinely running work.
      const nowInProgress = await hasInProgressCreativeGeneration(userId, campaignId, approvalId);
      if (nowInProgress) {
        console.log(`[Workflow] Creative generation already in progress for approval ${approvalId}; skipping duplicate`);
        return;
      }
      // The existing terminal claim is still terminal and could not be re-armed.
      // This should not happen after the checks above, but we fail closed.
      throw new Error(
        `Unable to acquire or re-arm creative generation claim for campaign ${campaignId}: existing claim ${claimResult.existingClaim.id} is terminal with no success evidence`
      );
    }

    claim = claimResult.claim;
  }
  let released = false;
  let heartbeatController: CreativeGenerationClaimHeartbeatController | undefined;

  const releaseClaimOnce = async (status: "completed" | "failed") => {
    if (released) return { released: true } as const;
    released = true;
    if (heartbeatController) {
      await heartbeatController.stop();
    }
    return releaseClaimWithResult({
      claimId: claim.id,
      ownerToken,
      status,
      context: "workflow.onStrategyApproved",
    });
  };

  try {
    // Run Audience Intelligence after strategy approval to refine audience segments
    // before content generation. This is credit-safe: if no permissioned source data
    // exists, the agent returns early without calling the LLM.
    try {
      const access = await checkAudienceAgentAccess(userId, null);
      if (access.allowed) {
        const existingAiRun = await db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.campaignId, campaignId),
              eq(agentRuns.agentType, "audience"),
              eq(agentRuns.userId, userId)
            )
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(1);

        if (existingAiRun.length > 0 && ["running", "completed"].includes(existingAiRun[0].status)) {
          console.log(`[Workflow] Skipping duplicate audience-intelligence run for campaign ${campaignId}.`);
        } else {
          console.log(`[Workflow] Running audience-intelligence for campaign ${campaignId} before creative generation.`);
          await ingestAudienceData({ userId, businessId: campaign.businessId, campaignId });
          await runAudienceIntelligenceAgent({ userId, campaignId, autoCreateLeads: false });
        }
      }
    } catch (err: any) {
      console.error(`[Workflow] Audience-intelligence pre-creative failed for campaign ${campaignId}:`, err.message);
      // Continue to creative generation even if audience intelligence fails
    }

    // Transition to creatives_generating before running the creative agent
    await transitionCampaignState(campaignId, userId, "generate_creatives");

    // Keep the claim alive during the long-running creative generation.
    heartbeatController = createClaimHeartbeatController({
      claimId: claim.id,
      ownerToken,
      leaseSeconds: env.creativeGenerationRunningLeaseSeconds,
      heartbeatIntervalSeconds: env.creativeGenerationHeartbeatIntervalSeconds,
    });

    // Auto-trigger creative agent
    try {
      const result = await runCreativeAgent({
        userId,
        campaignId,
        generationOperation: { source: "approval", id: approvalId },
        claimContext: heartbeatController,
      });
      await onAgentRunComplete(result.packRunId);
      const releaseResult = await releaseClaimOnce("completed");
      if (!releaseResult.released) {
        throw new Error(`Creative generation completed but the operation claim could not be released for campaign ${campaignId}.`);
      }
    } catch (err: any) {
      console.error(`[Workflow] Auto-creative failed | campaignId=${campaignId} | error="${err.message}"`);
      // Release failure is logged without ownerToken; preserve the original error.
      await releaseClaimOnce("failed");
    }
  } catch (err: any) {
    console.error(`[Workflow] onStrategyApproved failed | campaignId=${campaignId} | error="${err.message}"`);
    // Release failure is logged without ownerToken; preserve the original error.
    await releaseClaimOnce("failed");
  }
}
