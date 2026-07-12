export interface ReadinessCheckpoint {
  key:
    | "website_analysed"
    | "business_profile_built"
    | "brand_voice_detected"
    | "products_services_understood"
    | "campaign_goal_selected"
    | "social_channels_connected"
    | "audience_intelligence_active"
    | "first_campaign_launched";
  label: string;
  completed: boolean;
}

export interface OnboardingReadinessInput {
  websiteAnalysed: boolean;
  businessProfileBuilt: boolean;
  brandVoiceDetected: boolean;
  productsServicesUnderstood: boolean;
  campaignGoalSelected: boolean;
  socialChannelsConnected: boolean;
  audienceIntelligenceActive: boolean;
  firstCampaignLaunched: boolean;
}

export interface OnboardingReadiness {
  percentage: number;
  completedCount: number;
  totalCount: number;
  checkpoints: ReadinessCheckpoint[];
}

const primaryReadinessKeys: ReadinessCheckpoint["key"][] = [
  "website_analysed",
  "business_profile_built",
  "brand_voice_detected",
  "campaign_goal_selected",
];

export function calculateOnboardingReadiness(input: OnboardingReadinessInput): OnboardingReadiness {
  const checkpoints: ReadinessCheckpoint[] = [
    {
      key: "website_analysed",
      label: "Website analysed",
      completed: input.websiteAnalysed,
    },
    {
      key: "business_profile_built",
      label: "Business profile built",
      completed: input.businessProfileBuilt,
    },
    {
      key: "brand_voice_detected",
      label: "Brand voice detected",
      completed: input.brandVoiceDetected,
    },
    {
      key: "products_services_understood",
      label: "Products/services understood",
      completed: input.productsServicesUnderstood,
    },
    {
      key: "campaign_goal_selected",
      label: "Campaign goal selected",
      completed: input.campaignGoalSelected,
    },
    {
      key: "social_channels_connected",
      label: "Social channels connected",
      completed: input.socialChannelsConnected,
    },
    {
      key: "audience_intelligence_active",
      label: "Audience intelligence active",
      completed: input.audienceIntelligenceActive,
    },
    {
      key: "first_campaign_launched",
      label: "First campaign launched",
      completed: input.firstCampaignLaunched,
    },
  ];

  const completedCount = checkpoints.filter((item) => item.completed).length;
  const totalCount = checkpoints.length;
  const percentage = Math.round((completedCount / totalCount) * 100);

  return {
    percentage,
    completedCount,
    totalCount,
    checkpoints,
  };
}

export function isLiveOrLaterWorkflowState(state: string | null | undefined): boolean {
  return [
    "campaign_live",
    "engagement_active",
    "leads_converting",
    "optimisation_active",
    "completed",
  ].includes(state || "");
}

export function splitReadinessChecks(checkpoints: ReadinessCheckpoint[]) {
  const primary = checkpoints.filter((checkpoint) =>
    primaryReadinessKeys.includes(checkpoint.key)
  );
  const secondary = checkpoints.filter(
    (checkpoint) => !primaryReadinessKeys.includes(checkpoint.key)
  );

  return { primary, secondary };
}
