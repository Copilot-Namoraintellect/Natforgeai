import { getDb } from "../../queries/connection";
import { agentRuns, campaigns, approvalRequests, publishingQueue } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { transitionCampaignState, createApprovalRequest } from "./engine";
import { runCreativeAgent } from "../agents/creative-agent";
import { runDistributionAgent } from "../agents/distribution-agent";
import { runAudienceAgent } from "../agents/audience-agent";
import { canRunAutonomousWorkflow } from "../billing/cost-control";

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
      await createApprovalRequest({
        userId: run.userId,
        campaignId: run.campaignId,
        approvalType: "strategy_review",
        title: `Approve Strategy: ${updatedCampaign.name}`,
        description: `The strategy for "${updatedCampaign.name}" has been generated. Review and approve to continue to creative content generation.`,
        aiRecommendation: "Based on the campaign goal and target audience, this strategy aligns with best practices for the selected platforms.",
        riskLevel: "low",
      });
    }
  } else if (state === "creatives_generating" && run.agentType === "creative") {
    // Verify that the creative agent actually saved posts before transitioning
    const ctx = (campaign.workflowContext || {}) as any;
    const savedPosts = ctx.savedPosts ?? 0;
    if (savedPosts === 0) {
      console.error(`[Workflow] Creative agent for campaign ${run.campaignId} completed but savedPosts=0. Not transitioning state.`);
      return;
    }
    await transitionCampaignState(run.campaignId, run.userId, "creatives_complete");

    // Auto-trigger audience agent after creatives are ready
    try {
      const audienceResult = await runAudienceAgent({
        userId: run.userId,
        campaignId: run.campaignId,
      });
      await onAgentRunComplete(audienceResult.runId);
    } catch (err: any) {
      console.error("[Workflow] Auto-audience failed:", err.message);
    }
  } else if (state === "audience_generating" && run.agentType === "audience") {
    await transitionCampaignState(run.campaignId, run.userId, "audience_complete");

    // Auto-trigger distribution agent after audience is ready
    try {
      const distResult = await runDistributionAgent({
        userId: run.userId,
        campaignId: run.campaignId,
        approvalMode: campaign.approvalMode as "assisted" | "autonomous",
      });
      await onAgentRunComplete(distResult.runId);
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
      await onStrategyApproved(campaignId, userId);
    } else {
      await transitionCampaignState(campaignId, userId, "request_strategy_changes");
    }
  }
}

export async function onStrategyApproved(campaignId: number, userId: number) {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) return;

  // Check cost control before auto-triggering
  const autoCheck = await canRunAutonomousWorkflow(userId, campaignId);
  if (!autoCheck.allowed) {
    console.log(`[Workflow] Auto-creative blocked for campaign ${campaignId}: ${autoCheck.reason}`);
    return;
  }

  // Transition to strategy_approved
  await transitionCampaignState(campaignId, userId, "approve_strategy");

  // Transition to creatives_generating before running the creative agent
  await transitionCampaignState(campaignId, userId, "generate_creatives");

  // Auto-trigger creative agent
  try {
    const result = await runCreativeAgent({
      userId,
      campaignId,
    });
    await onAgentRunComplete(result.packRunId);
  } catch (err: any) {
    console.error("[Workflow] Auto-creative failed:", err.message);
  }
}
