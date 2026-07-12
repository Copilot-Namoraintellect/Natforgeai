/**
 * Shared workflow state mappings used across Mission Control, Campaigns,
 * Approval Centre, Agent Activity and Content Studio.
 */

export const workflowStateLabels: Record<string, { label: string; color: string; step: number }> = {
  business_onboarding: { label: "Onboarding", color: "bg-amber-500/10 text-amber-600", step: 1 },
  strategy_pending: { label: "Strategy Pending", color: "bg-blue-500/10 text-blue-600", step: 2 },
  strategy_generated: { label: "Strategy Ready", color: "bg-purple-500/10 text-purple-600", step: 3 },
  strategy_approved: { label: "Strategy Approved", color: "bg-emerald-500/10 text-emerald-600", step: 4 },
  creatives_generating: { label: "Generating Creatives", color: "bg-blue-500/10 text-blue-600", step: 5 },
  creatives_ready: { label: "Creatives Ready", color: "bg-purple-500/10 text-purple-600", step: 6 },
  audience_generating: { label: "Finding Audience", color: "bg-blue-500/10 text-blue-600", step: 7 },
  audience_ready: { label: "Audience Ready", color: "bg-purple-500/10 text-purple-600", step: 8 },
  schedule_generated: { label: "Schedule Ready", color: "bg-cyan-500/10 text-cyan-600", step: 9 },
  launch_approval_required: { label: "Awaiting Launch Approval", color: "bg-amber-500/10 text-amber-600", step: 10 },
  campaign_live: { label: "Campaign Live", color: "bg-emerald-500/10 text-emerald-600", step: 11 },
  engagement_active: { label: "Engagement Active", color: "bg-pink-500/10 text-pink-600", step: 12 },
  leads_converting: { label: "Leads Converting", color: "bg-orange-500/10 text-orange-600", step: 13 },
  optimisation_active: { label: "Optimising", color: "bg-indigo-500/10 text-indigo-600", step: 14 },
  completed: { label: "Completed", color: "bg-gray-500/10 text-gray-600", step: 15 },
};

export const workflowGuidance: Record<string, { explanation: string; nextAction: string; actionLabel?: string; actionHref?: string }> = {
  business_onboarding: { explanation: "Complete your business profile to get started.", nextAction: "Finish onboarding so NatForgeAI can begin strategy work." },
  strategy_pending: { explanation: "NatForgeAI is preparing your campaign strategy. This usually takes a short moment.", nextAction: "Your strategy is being generated. You'll be notified when it's ready." },
  strategy_generated: { explanation: "NatForgeAI has prepared your campaign strategy. Review the strategy before content is generated.", nextAction: "Review and approve the strategy to continue.", actionLabel: "Review Strategy", actionHref: "/approvals" },
  strategy_approved: { explanation: "Strategy approved. NatForgeAI is now generating creative content.", nextAction: "Creative assets are being prepared." },
  creatives_generating: { explanation: "NatForgeAI is generating creative content for your campaign.", nextAction: "Creative assets are being prepared." },
  creatives_ready: { explanation: "Creative content is ready. You can review or proceed to audience targeting.", nextAction: "Review creative assets or continue to audience targeting.", actionLabel: "Review Content", actionHref: "/content" },
  audience_generating: { explanation: "NatForgeAI is identifying your ideal audience segments.", nextAction: "Audience research is in progress." },
  audience_ready: { explanation: "Audience profiles are ready. Distribution scheduling is next.", nextAction: "Review audience profiles or proceed to scheduling." },
  schedule_generated: { explanation: "Your publishing schedule is ready. Review before launch.", nextAction: "Approve the schedule to set your campaign live." },
  launch_approval_required: { explanation: "Your campaign is ready to launch. Final approval is required.", nextAction: "Approve the launch to go live.", actionLabel: "Approve Launch", actionHref: "/approvals" },
  campaign_live: { explanation: "Your campaign is live and running.", nextAction: "Monitor performance in Analytics." },
  engagement_active: { explanation: "Your campaign is actively engaging with your audience.", nextAction: "Monitor engagement and replies." },
  leads_converting: { explanation: "Leads are being nurtured and converted.", nextAction: "Check your Leads pipeline." },
  optimisation_active: { explanation: "NatForgeAI is optimising your campaign performance.", nextAction: "Optimisations are being applied automatically." },
  completed: { explanation: "This campaign has completed its cycle.", nextAction: "Review results or create a new campaign." },
};

export function getWorkflowNextActionMessage(state: string | null | undefined): string {
  if (!state) return "Complete the current step to continue the autonomous workflow.";
  return workflowGuidance[state]?.nextAction || "Continue the campaign workflow from Mission Control.";
}

export const journeyStage: Record<string, string> = {
  business_onboarding: "Draft",
  strategy_pending: "Strategy Generating",
  strategy_generated: "Strategy Ready",
  strategy_approved: "Content Plan Ready",
  creatives_generating: "Content Generating",
  creatives_ready: "Content Ready for Review",
  audience_generating: "Audience Research",
  audience_ready: "Audience Ready",
  schedule_generated: "Scheduled",
  launch_approval_required: "Awaiting Launch Approval",
  campaign_live: "Published",
  engagement_active: "Leads Captured",
  leads_converting: "Leads Captured",
  optimisation_active: "Optimising",
  completed: "Completed",
};

export function getContinueAction(campaign: any) {
  const state = campaign?.workflowState;
  if (!state) return null;
  if (state === "business_onboarding") return { label: "Complete Business Profile", href: "/onboarding" };
  if (state === "strategy_pending") return { label: "View Progress", href: "/agent-activity" };
  if (state === "strategy_generated") return { label: "Review Strategy", href: "/approvals" };
  if (state === "strategy_approved" || state === "creatives_generating") return { label: "View Content Generation Progress", href: "/agent-activity" };
  if (state === "creatives_ready" || state === "audience_ready" || state === "schedule_generated") return { label: "View Generated Content", href: `/content?campaignId=${campaign.id}` };
  if (state === "audience_generating") return { label: "View Progress", href: "/agent-activity" };
  if (state === "launch_approval_required") return { label: "Approve Launch", href: "/approvals" };
  if (state === "campaign_live" || state === "engagement_active" || state === "leads_converting" || state === "optimisation_active") return { label: "View Analytics", href: "/analytics" };
  return null;
}
