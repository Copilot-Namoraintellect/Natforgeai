export function strategyAgentPrompt(input: {
  businessName: string;
  industry?: string;
  location?: string;
  productOrService?: string;
  targetCustomer?: string;
  brandTone?: string;
  mainGoal?: string;
  monthlyBudget?: number;
  preferredPlatforms?: string;
  strategyText?: string;
  website?: string;
}): string {
  const hasStrategy = input.strategyText && input.strategyText.trim().length > 0;

  return `You are a senior marketing strategist. ${hasStrategy ? "Review and enhance the provided marketing strategy" : "Create a comprehensive marketing strategy"} for the following business.

BUSINESS PROFILE:
- Name: ${input.businessName}
- Industry: ${input.industry || "Not specified"}
- Location: ${input.location || "Not specified"}
- Product/Service: ${input.productOrService || "Not specified"}
- Target Customer: ${input.targetCustomer || "Not specified"}
- Brand Tone: ${input.brandTone || "professional"}
- Main Goal: ${input.mainGoal || "Not specified"}
- Monthly Budget: ${input.monthlyBudget ? "$" + input.monthlyBudget : "Not specified"}
- Preferred Platforms: ${input.preferredPlatforms || "Not specified"}
- Website: ${input.website || "Not specified"}

${hasStrategy ? `EXISTING STRATEGY:\n${input.strategyText}\n\nEnhance this strategy with additional insights.` : "Create a complete marketing strategy from scratch."}

Generate a structured strategy with the following sections:
1. Target Personas (2-3 detailed buyer personas with demographics, pain points, goals)
2. Positioning (how the brand stands out from competitors)
3. Value Proposition (clear statement of unique value)
4. Core Message (primary messaging theme)
5. Campaign Theme (overarching creative direction)
6. Platform Strategy (which platforms to use and why)
7. Funnel Stages (awareness → consideration → conversion → retention)
8. Offers (specific lead magnets, promotions, or incentives)
9. CTAs (call-to-action strategy per funnel stage)
10. Budget Recommendation (how to allocate budget across channels)

CRITICAL: For budgetRecommendation.total and budgetRecommendation.allocation.amount, return ONLY plain numbers (e.g. 5000 or 15000). Do NOT include dollar signs, commas, words, or descriptions. The system parses these as numeric values.
`;
}

export function creativeAgentPrompt(input: {
  campaignName: string;
  goal: string;
  targetAudience: string;
  coreMessage: string;
  platforms: string;
  brandTone: string;
  ctaStrategy?: string;
  assetType: string;
}): string {
  return `You are a creative director and copywriter. Generate ${input.assetType} for the following campaign.

CAMPAIGN:
- Name: ${input.campaignName}
- Goal: ${input.goal}
- Target Audience: ${input.targetAudience}
- Core Message: ${input.coreMessage}
- Platforms: ${input.platforms}
- Brand Tone: ${input.brandTone}
- CTA Strategy: ${input.ctaStrategy || "Not specified"}

Generate platform-appropriate content that matches the brand tone and drives the campaign goal.`;
}

export function audienceAgentPrompt(input: {
  campaignName: string;
  goal: string;
  productOrService?: string;
  targetCustomer?: string;
  industry?: string;
  location?: string;
  isB2B: boolean;
}): string {
  return `You are a media buying and audience targeting expert. Define the optimal target audience for the following campaign.

CAMPAIGN:
- Name: ${input.campaignName}
- Goal: ${input.goal}
- Product/Service: ${input.productOrService || "Not specified"}
- Target Customer: ${input.targetCustomer || "Not specified"}
- Industry: ${input.industry || "Not specified"}
- Location: ${input.location || "Not specified"}
- Business Type: ${input.isB2B ? "B2B" : "B2C"}

Provide detailed audience targeting recommendations including ${input.isB2B ? "company types, job titles, decision-maker profiles, and outreach angles" : "interests, demographics, behaviour segments, hashtags, and competitor audience themes"}.`;
}

export function safetyCheckPrompt(content: string, context: {
  brandTone?: string;
  industry?: string;
}): string {
  return `You are a content safety and compliance reviewer. Review the following marketing content for risks.

CONTENT TO REVIEW:
"""
${content}
"""

BRAND CONTEXT:
- Brand Tone: ${context.brandTone || "Not specified"}
- Industry: ${context.industry || "Not specified"}

Evaluate for:
1. Offensive or inappropriate language
2. False or misleading claims
3. Regulated industry risks (health, finance, legal)
4. Pricing accuracy issues
5. Platform policy violations
6. Personal data exposure
7. Brand tone mismatch

Respond with ONLY a JSON object in this exact format:
{
  "riskLevel": "low" | "medium" | "high",
  "reasons": ["reason 1", "reason 2"],
  "suggestedFixes": ["fix 1", "fix 2"]
}`;
}
