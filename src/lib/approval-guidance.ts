type ApprovalLike = {
  id: number;
  status: string;
  title?: string | null;
  approvalType?: string | null;
};

type CampaignLike = {
  id: number;
  name?: string | null;
  workflowState?: string | null;
};

export interface ApprovalGuidance {
  happeningNow: string;
  completed: string;
  nextAction: string;
  afterAction: string;
}

function approvalLabel(approval: ApprovalLike): string {
  if (approval.title && approval.title.trim()) return approval.title.trim();
  if (approval.approvalType && approval.approvalType.trim()) return approval.approvalType.trim();
  return `Request #${approval.id}`;
}

export function buildApprovalGuidance(input: {
  pendingApprovals: ApprovalLike[];
  campaigns: CampaignLike[];
}): ApprovalGuidance {
  const pendingApprovals = input.pendingApprovals || [];
  const campaigns = input.campaigns || [];
  const pendingCount = pendingApprovals.length;

  const generatingCampaigns = campaigns.filter((c) => c.workflowState === "creatives_generating");
  const hasCampaign30Generating = generatingCampaigns.some((c) => c.id === 30);

  if (pendingCount > 0) {
    const labels = pendingApprovals.slice(0, 3).map(approvalLabel);
    const labelText = labels.join(", ");
    return {
      happeningNow:
        pendingCount === 1
          ? `1 approval requires your review: ${labelText}.`
          : `${pendingCount} approvals require your review, including ${labelText}.`,
      completed: "Creative and strategy generation steps for these requests are complete and ready for decision.",
      nextAction: "Approve, reject, or edit each pending request.",
      afterAction: "Workflow resumes automatically into the next campaign stage once decisions are submitted.",
    };
  }

  if (hasCampaign30Generating) {
    return {
      happeningNow: "No approvals are required right now. Campaign #30 is currently in creative generation.",
      completed: "There are no pending strategy or launch approvals in this queue.",
      nextAction: "Wait for creative generation to complete or monitor progress in Agent Activity.",
      afterAction: "When creative generation finishes, campaign content appears in Content Studio automatically.",
    };
  }

  if (generatingCampaigns.length > 0) {
    const ids = generatingCampaigns.slice(0, 3).map((c) => `#${c.id}`).join(", ");
    return {
      happeningNow: `No approvals are required right now. Active campaigns in creative generation: ${ids}.`,
      completed: "There are no pending strategy or launch approvals in this queue.",
      nextAction: "Wait for creative generation to complete or monitor progress in Agent Activity.",
      afterAction: "When generation finishes, content appears in Content Studio automatically.",
    };
  }

  return {
    happeningNow: "No approvals are required right now.",
    completed: "All approval requests are resolved and the queue is clear.",
    nextAction: "No approval action is needed at this stage.",
    afterAction: "New approval requests will appear here only when a workflow step requires manual review.",
  };
}
