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
  websiteEvidence?: unknown;
  campaignBrief?: {
    name?: string;
    goal?: string;
    targetAudience?: string;
    coreMessage?: string;
    platforms?: string;
    budget?: number;
    primaryOutcome?: string;
    targetBuyer?: string;
    mainPainPoint?: string;
    productOrService?: string;
    offerDetails?: string;
    preferredCta?: string;
    excludedOffers?: string;
    referenceStyle?: string;
    contentStyle?: string;
  };
}): string {
  const hasStrategy = input.strategyText && input.strategyText.trim().length > 0;
  const cb = input.campaignBrief;
  const evidence = input.websiteEvidence as {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
    confidence?: number;
    evidenceSnippets?: string[];
  } | undefined;

  const evidenceSection = evidence
    ? `
WEBSITE EVIDENCE — USE THIS AS THE GROUND TRUTH FOR WHAT THE BUSINESS DOES:
- Business Category: ${evidence.businessCategory || "Not specified"}
- Products/Services Mentioned on Website: ${(evidence.productsServices || []).join(", ") || "Not specified"}
- Target Customers Mentioned on Website: ${(evidence.targetCustomers || []).join(", ") || "Not specified"}
- Detected Location: ${evidence.location || "Not specified"}
- Evidence Confidence: ${evidence.confidence ?? "unknown"}
- Evidence Snippets:
${(evidence.evidenceSnippets || []).slice(0, 10).map((s) => "  - " + s).join("\n")}
`
    : "";

  const briefSection = cb
    ? `
CAMPAIGN BRIEF — USE THESE DETAILS EXACTLY. DO NOT IGNORE THEM:
- Campaign Name: ${cb.name || "Not specified"}
- Campaign Goal: ${cb.goal || "Not specified"}
- Primary Outcome: ${cb.primaryOutcome || "Not specified"}
- Target Buyer: ${cb.targetBuyer || cb.targetAudience || "Not specified"}
- Main Pain Point: ${cb.mainPainPoint || "Not specified"}
- Product/Service Being Promoted: ${cb.productOrService || cb.coreMessage || "Not specified"}
- Offer (only if provided): ${cb.offerDetails || "None — do not invent offers, discounts or free trials"}
- Preferred CTA: ${cb.preferredCta || "Not specified"}
- What NOT to say / excluded offers: ${cb.excludedOffers || "None specified"}
- Reference Style / Example: ${cb.referenceStyle || "Not specified"}
- Preferred Content Style: ${cb.contentStyle || "Not specified"}
- Channels: ${cb.platforms || "Not specified"}
- Budget Guidance: ${cb.budget ? "$" + cb.budget : "Not specified"}
`
    : "";

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
${evidenceSection}
${briefSection}

${hasStrategy ? `EXISTING STRATEGY:\n${input.strategyText}\n\nEnhance this strategy with additional insights.` : "Create a complete marketing strategy from scratch."}

Generate a structured strategy with the following sections:
1. Target Personas (2-3 detailed buyer personas with demographics, pain points, goals)
2. Positioning (how the brand stands out from competitors)
3. Value Proposition (clear statement of unique value)
4. Core Message (primary messaging theme — must be grounded in the campaign brief and product/service)
5. Campaign Theme (overarching creative direction)
6. Platform Strategy (which platforms to use and why)
7. Funnel Stages (awareness → consideration → conversion → retention)
8. Offers (specific lead magnets, promotions, or incentives — ONLY if explicitly provided in the brief; otherwise return empty array [])
9. CTAs (call-to-action strategy per funnel stage — use the preferred CTA if provided)
10. Budget Recommendation (how to allocate budget across channels)

CRITICAL RULES:
- For budgetRecommendation.total and budgetRecommendation.allocation.amount, return ONLY plain numbers (e.g. 5000 or 15000). Do NOT include dollar signs, commas, words, or descriptions. The system parses these as numeric values.
- If no offer is provided in the campaign brief, the offers array MUST be empty. Do not invent discounts, free trials, free e-books, loyalty programmes, limited spots or percentages.
- The core message must be specific to the business and product/service, not generic motivational filler.
- NEVER classify the business as SEO, digital marketing, social media management, data analytics, restaurant services, salon services, or consulting unless the website evidence explicitly supports that classification.
- Only include products/services in the strategy that are listed in the Website Evidence above. Do not introduce unsupported services.
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
