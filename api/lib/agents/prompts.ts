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
  audienceIntelligenceSummaries?: string[];
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

  // Precedence for grounding (a > b > c > d):
  // a. current campaign brief fields;
  // b. business profile only for missing optional context;
  // c. website evidence only as supplementary evidence;
  // d. safe fallback.
  const evidence = input.websiteEvidence as {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
    confidence?: number;
    evidenceSnippets?: string[];
  } | undefined;

  const effectiveProductOrService =
    cb?.productOrService || cb?.coreMessage || input.productOrService || evidence?.productsServices?.join(", ") || "Not specified";
  const effectiveTargetCustomer =
    cb?.targetBuyer || cb?.targetAudience || input.targetCustomer || evidence?.targetCustomers?.join(", ") || "Not specified";
  const effectiveMainPainPoint = cb?.mainPainPoint || "Not specified";
  const effectivePreferredCta = cb?.preferredCta || "Not specified";
  const effectivePrimaryOutcome = cb?.primaryOutcome || "Not specified";
  const effectiveOfferDetails = cb?.offerDetails || "None — do not invent offers, discounts or free trials";
  const effectiveExcludedOffers = cb?.excludedOffers || "None specified";
  const effectiveReferenceStyle = cb?.referenceStyle || "Not specified";
  const effectiveContentStyle = cb?.contentStyle || "Not specified";

  const evidenceSection = evidence
    ? `
WEBSITE EVIDENCE — USE ONLY AS SUPPLEMENTARY CONTEXT. IT MUST NEVER OVERRIDE THE CAMPAIGN BRIEF ABOVE:
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
CAMPAIGN BRIEF — THIS IS THE AUTHORITATIVE GROUND TRUTH. USE THESE DETAILS EXACTLY AND DO NOT LET BUSINESS PROFILE OR WEBSITE EVIDENCE OVERRIDE THEM:
- Campaign Name: ${cb.name || "Not specified"}
- Campaign Goal: ${cb.goal || "Not specified"}
- Primary Outcome: ${effectivePrimaryOutcome}
- Target Buyer: ${effectiveTargetCustomer}
- Main Pain Point: ${effectiveMainPainPoint}
- Product/Service Being Promoted: ${effectiveProductOrService}
- Offer (only if provided): ${effectiveOfferDetails}
- Preferred CTA: ${effectivePreferredCta}
- What NOT to say / excluded offers: ${effectiveExcludedOffers}
- Reference Style / Example: ${effectiveReferenceStyle}
- Preferred Content Style: ${effectiveContentStyle}
- Channels: ${cb.platforms || "Not specified"}
- Budget Guidance: ${cb.budget ? "$" + cb.budget : "Not specified"}
`
    : "";

  const aiSummaries = input.audienceIntelligenceSummaries;
  const audienceIntelligenceSection =
    aiSummaries && aiSummaries.length > 0
      ? `
AUDIENCE INTELLIGENCE INSIGHTS FROM PREVIOUS CAMPAIGNS — USE THESE TO REFINE PERSONAS, MESSAGING, AND PLATFORM FOCUS:
${aiSummaries.map((summary, idx) => `--- Insight ${idx + 1} ---\n${summary}`).join("\n\n")}
`
      : "";

  return `You are a senior marketing strategist. ${hasStrategy ? "Review and enhance the provided marketing strategy" : "Create a comprehensive marketing strategy"} for the following business.

BUSINESS PROFILE (used only when the campaign brief does not specify a value):
- Name: ${input.businessName}
- Industry: ${input.industry || "Not specified"}
- Location: ${input.location || "Not specified"}
- Product/Service: ${effectiveProductOrService}
- Target Customer: ${effectiveTargetCustomer}
- Brand Tone: ${input.brandTone || "professional"}
- Main Goal: ${input.mainGoal || "Not specified"}
- Monthly Budget: ${input.monthlyBudget ? "$" + input.monthlyBudget : "Not specified"}
- Preferred Platforms: ${input.preferredPlatforms || "Not specified"}
- Website: ${input.website || "Not specified"}
${evidenceSection}
${briefSection}
${audienceIntelligenceSection}

GROUNDING REQUIREMENTS — THE GENERATED STRATEGY MUST:
- Faithfully preserve every service-capability clause listed in the campaign brief's Product/Service Being Promoted. Do not collapse, paraphrase away, or omit any required capability.
- The core message, positioning and value proposition are the product-defining fields. They must together include a complete, coherent statement of the Product/Service Being Promoted. Do not rely on persona pain points, funnel tactics, platform content, CTAs or offers to carry required product capabilities.
- Preserve the operating context implied by the brief (e.g. B2B vs B2C, merchant/account model, transaction-level controls). Do not recast the product or service into generic payment processing, lending, banking, or broad fintech language unless the brief explicitly describes it that way.
- Use only the Target Buyer and Main Pain Point supplied by the brief. Do not substitute a different audience or problem.
- Avoid invented features, channels, programmes, offers, or incentives that are not grounded in the brief.
- Avoid unsupported claims about fraud prevention, multiple payment methods, credit, loans, free trials, free consultations, free assessments, free audits, free demos, or scalability unless the brief explicitly authorises them.
- If no offer is provided in the campaign brief, the offers array MUST be empty and no incentive language may appear in CTAs, core message, value proposition, positioning, campaign theme, funnel tactics, platform strategy, or persona goals. Do not invent or imply free consultations, assessments, audits, demos, discounts, trials, giveaways, bonuses, or promotional credits.
- Use the Preferred CTA exactly when provided.

${hasStrategy ? `EXISTING STRATEGY:\n${input.strategyText}\n\nEnhance this strategy with additional insights.` : "Create a complete marketing strategy from scratch."}

Generate a structured strategy with the following sections:
1. Target Personas (2-3 detailed buyer personas with demographics, pain points, goals — must match the campaign brief's Target Buyer and Main Pain Point)
2. Positioning (how the brand stands out from competitors)
3. Value Proposition (clear statement of unique value)
4. Core Message (primary messaging theme — must be grounded in the campaign brief's Product/Service and Main Pain Point)
5. Campaign Theme (overarching creative direction)
6. Platform Strategy (which platforms to use and why)
7. Funnel Stages (awareness → consideration → conversion → retention)
8. Offers (specific lead magnets, promotions, or incentives — ONLY if explicitly provided in the campaign brief; otherwise return empty array [])
9. CTAs (call-to-action strategy per funnel stage — use the Preferred CTA exactly when provided)
10. Budget Recommendation (how to allocate budget across channels)

CRITICAL RULES:
- For budgetRecommendation.total and budgetRecommendation.allocation.amount, return ONLY plain numbers (e.g. 5000 or 15000). Do NOT include dollar signs, commas, words, or descriptions. The system parses these as numeric values.
- If no offer is provided in the campaign brief, the offers array MUST be empty. Do not invent discounts, free trials, free e-books, loyalty programmes, limited spots or percentages.
- The core message must be specific to the business and product/service, not generic motivational filler.
- NEVER classify the business as SEO, digital marketing, social media management, data analytics, restaurant services, salon services, or consulting unless the campaign brief explicitly states that classification.
- Only include products/services, target customers, pain points and offers in the strategy that are grounded in the campaign brief. Website evidence may add context but cannot override the brief.
- Do NOT use stale or conflicting audience classifications such as "small businesses", "payroll", "employee payouts", "credit access" or "mass disbursements" when they conflict with the campaign brief's Target Buyer or Product/Service.
- Respect the "What NOT to say / excluded offers" list exactly. Do not mention excluded offers, claims or audiences anywhere in personas, core message, value proposition, positioning, campaign theme, funnel tactics, offers or CTAs.
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
