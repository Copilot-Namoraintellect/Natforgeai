import { getDb } from "../../queries/connection";
import { campaigns, approvalRequests } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

export type WorkflowState =
  | "business_onboarding"
  | "strategy_pending"
  | "strategy_generated"
  | "strategy_approved"
  | "creatives_generating"
  | "creatives_ready"
  | "audience_generating"
  | "audience_ready"
  | "schedule_generated"
  | "launch_approval_required"
  | "campaign_live"
  | "engagement_active"
  | "leads_converting"
  | "optimisation_active"
  | "completed";

export type WorkflowAction =
  | "complete_onboarding"
  | "generate_strategy"
  | "approve_strategy"
  | "request_strategy_changes"
  | "generate_creatives"
  | "creatives_complete"
  | "generate_audience"
  | "audience_complete"
  | "generate_schedule"
  | "request_launch_approval"
  | "approve_launch"
  | "reject_launch"
  | "go_live"
  | "start_engagement"
  | "start_lead_conversion"
  | "start_optimisation"
  | "complete_campaign"
  | "pause"
  | "resume";

const validTransitions: Record<WorkflowState, Partial<Record<WorkflowAction, WorkflowState>>> = {
  business_onboarding: {
    complete_onboarding: "strategy_pending",
  },
  strategy_pending: {
    generate_strategy: "strategy_generated",
  },
  strategy_generated: {
    approve_strategy: "strategy_approved",
    request_strategy_changes: "strategy_pending",
  },
  strategy_approved: {
    generate_creatives: "creatives_generating",
  },
  creatives_generating: {
    creatives_complete: "creatives_ready",
  },
  creatives_ready: {
    generate_audience: "audience_generating",
  },
  audience_generating: {
    audience_complete: "audience_ready",
  },
  audience_ready: {
    generate_schedule: "schedule_generated",
  },
  schedule_generated: {
    request_launch_approval: "launch_approval_required",
  },
  launch_approval_required: {
    approve_launch: "campaign_live",
    reject_launch: "strategy_approved",
  },
  campaign_live: {
    start_engagement: "engagement_active",
    pause: "strategy_approved",
  },
  engagement_active: {
    start_lead_conversion: "leads_converting",
    pause: "strategy_approved",
  },
  leads_converting: {
    start_optimisation: "optimisation_active",
    pause: "strategy_approved",
  },
  optimisation_active: {
    complete_campaign: "completed",
    pause: "strategy_approved",
  },
  completed: {
    resume: "optimisation_active",
  },
};

export async function transitionCampaignState(
  campaignId: number,
  userId: number,
  action: WorkflowAction
): Promise<WorkflowState> {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  const currentState = campaign.workflowState as WorkflowState;
  const transitions = validTransitions[currentState];
  const nextState = transitions?.[action];

  if (!nextState) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid transition: ${action} from ${currentState}`,
    });
  }

  await db
    .update(campaigns)
    .set({
      workflowState: nextState,
      workflowContext: {
        ...(campaign.workflowContext || {}),
        lastTransition: {
          from: currentState,
          to: nextState,
          action,
          at: new Date().toISOString(),
        },
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return nextState;
}

export async function getWorkflowState(campaignId: number, userId: number) {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  return {
    state: campaign.workflowState as WorkflowState,
    context: campaign.workflowContext,
    approvalMode: campaign.approvalMode,
    autoPublish: campaign.autoPublish,
  };
}

export async function createApprovalRequest({
  userId,
  campaignId,
  approvalType,
  title,
  description,
  aiRecommendation,
  riskLevel,
}: {
  userId: number;
  campaignId: number;
  approvalType: string;
  title: string;
  description?: string;
  aiRecommendation?: string;
  riskLevel: "low" | "medium" | "high";
}) {
  const db = getDb();
  const [result] = await db.insert(approvalRequests).values({
    userId,
    campaignId,
    approvalType: approvalType as any,
    title,
    description: description || null,
    aiRecommendation: aiRecommendation || null,
    riskLevel,
    status: "pending",
  });
  return { id: Number(result.insertId) };
}
