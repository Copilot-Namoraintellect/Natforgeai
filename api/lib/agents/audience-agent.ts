import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, businesses } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  buildGroundedCreativeBrief,
  type BusinessTypeClassification,
} from "../creative/brief-grounding";

// ─── Schema Normalisation Helpers ───
// OpenAI structured output requires EVERY property to be in the `required` array.
// .optional() breaks the JSON schema. Use .nullable() instead.

function normaliseAudienceProfile(p: any): any {
  if (!p || typeof p !== "object") {
    return {
      name: "General Audience",
      description: "",
      demographics: { ageRange: null, gender: null, locations: [], languages: [] },
      interests: [],
      behaviours: [],
      painPoints: [],
      platforms: [],
    };
  }
  const demo = p.demographics || {};
  return {
    name: String(p.name ?? "Audience Segment"),
    description: String(p.description ?? ""),
    demographics: {
      ageRange: demo.ageRange != null ? String(demo.ageRange) : null,
      gender: demo.gender != null ? String(demo.gender) : null,
      locations: Array.isArray(demo.locations) ? demo.locations.map(String) : [],
      languages: Array.isArray(demo.languages) ? demo.languages.map(String) : [],
    },
    interests: Array.isArray(p.interests) ? p.interests.map(String) : [],
    behaviours: Array.isArray(p.behaviours) ? p.behaviours.map(String) : [],
    painPoints: Array.isArray(p.painPoints) ? p.painPoints.map(String) : [],
    platforms: Array.isArray(p.platforms) ? p.platforms.map(String) : [],
  };
}

function normaliseHashtagStrategy(h: any): any {
  if (!h || typeof h !== "object") {
    return { primary: [], secondary: [], trending: [], branded: [] };
  }
  return {
    primary: Array.isArray(h.primary) ? h.primary.map(String) : [],
    secondary: Array.isArray(h.secondary) ? h.secondary.map(String) : [],
    trending: Array.isArray(h.trending) ? h.trending.map(String) : [],
    branded: Array.isArray(h.branded) ? h.branded.map(String) : [],
  };
}

function normaliseCompetitorInsights(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  return list.map((c: any) => ({
    competitorName: String(c?.competitorName ?? ""),
    audienceThemes: Array.isArray(c?.audienceThemes) ? c.audienceThemes.map(String) : [],
    contentAngles: Array.isArray(c?.contentAngles) ? c.contentAngles.map(String) : [],
    engagementTactics: Array.isArray(c?.engagementTactics) ? c.engagementTactics.map(String) : [],
  }));
}

function normaliseAudienceOutput(raw: any): any {
  if (!raw || typeof raw !== "object") {
    return {
      audienceProfiles: [normaliseAudienceProfile(null)],
      targetingCriteria: { interests: [], behaviours: [], demographics: [], customAudiences: [], lookalikes: [] },
      b2bFilters: null,
      hashtagStrategy: normaliseHashtagStrategy(null),
      competitorInsights: [],
      outreachAngles: [],
    };
  }
  const profiles = Array.isArray(raw.audienceProfiles)
    ? raw.audienceProfiles.map(normaliseAudienceProfile)
    : [normaliseAudienceProfile(null)];

  const tc = raw.targetingCriteria || {};
  return {
    audienceProfiles: profiles,
    targetingCriteria: {
      interests: Array.isArray(tc.interests) ? tc.interests.map(String) : [],
      behaviours: Array.isArray(tc.behaviours) ? tc.behaviours.map(String) : [],
      demographics: Array.isArray(tc.demographics) ? tc.demographics.map(String) : [],
      customAudiences: Array.isArray(tc.customAudiences) ? tc.customAudiences.map(String) : [],
      lookalikes: Array.isArray(tc.lookalikes) ? tc.lookalikes.map(String) : [],
    },
    b2bFilters: raw.b2bFilters
      ? {
          companyTypes: Array.isArray(raw.b2bFilters.companyTypes) ? raw.b2bFilters.companyTypes.map(String) : [],
          jobTitles: Array.isArray(raw.b2bFilters.jobTitles) ? raw.b2bFilters.jobTitles.map(String) : [],
          industries: Array.isArray(raw.b2bFilters.industries) ? raw.b2bFilters.industries.map(String) : [],
          companySizes: Array.isArray(raw.b2bFilters.companySizes) ? raw.b2bFilters.companySizes.map(String) : [],
          decisionMakers: Array.isArray(raw.b2bFilters.decisionMakers) ? raw.b2bFilters.decisionMakers.map(String) : [],
        }
      : null,
    hashtagStrategy: normaliseHashtagStrategy(raw.hashtagStrategy),
    competitorInsights: normaliseCompetitorInsights(raw.competitorInsights),
    outreachAngles: Array.isArray(raw.outreachAngles) ? raw.outreachAngles.map(String) : [],
  };
}

// ─── Strict Schema (no .optional(), only .nullable()) ───
const AudienceDiscoverySchema = z.object({
  audienceProfiles: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      demographics: z.object({
        ageRange: z.string().nullable(),
        gender: z.string().nullable(),
        locations: z.array(z.string()).nullable(),
        languages: z.array(z.string()).nullable(),
      }),
      interests: z.array(z.string()).nullable(),
      behaviours: z.array(z.string()).nullable(),
      painPoints: z.array(z.string()).nullable(),
      platforms: z.array(z.string()).nullable(),
    })
  ),
  targetingCriteria: z.object({
    interests: z.array(z.string()),
    behaviours: z.array(z.string()),
    demographics: z.array(z.string()),
    customAudiences: z.array(z.string()),
    lookalikes: z.array(z.string()),
  }),
  b2bFilters: z.object({
    companyTypes: z.array(z.string()).nullable(),
    jobTitles: z.array(z.string()).nullable(),
    industries: z.array(z.string()).nullable(),
    companySizes: z.array(z.string()).nullable(),
    decisionMakers: z.array(z.string()).nullable(),
  }).nullable(),
  hashtagStrategy: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()),
    trending: z.array(z.string()),
    branded: z.array(z.string()),
  }),
  competitorInsights: z.array(
    z.object({
      competitorName: z.string(),
      audienceThemes: z.array(z.string()),
      contentAngles: z.array(z.string()),
      engagementTactics: z.array(z.string()),
    })
  ),
  outreachAngles: z.array(z.string()),
});

export type AudienceDiscoveryOutput = z.infer<typeof AudienceDiscoverySchema>;

export async function runAudienceAgent({
  userId,
  campaignId,
  isB2B: explicitIsB2B,
}: {
  userId: number;
  campaignId: number;
  /** Explicit override. When omitted, the agent classifies from campaign + business evidence. */
  isB2B?: boolean;
}) {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  let business: typeof businesses.$inferSelect | null = null;
  if (campaign.businessId) {
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    business = biz ?? null;
  }

  const brief = buildGroundedCreativeBrief({ campaign, business });

  // Explicit caller choice wins; otherwise infer from evidence. Never silently default to B2C.
  const businessType: BusinessTypeClassification =
    typeof explicitIsB2B === "boolean"
      ? explicitIsB2B
        ? "B2B"
        : "B2C"
      : brief.businessType;
  const isB2B = businessType === "B2B";

  const strategyContext = campaign.workflowContext as any;
  const personas = campaign.personas as any[];

  // Location and industry: current business profile first, then historical workflowContext as safe fallback.
  const location = business?.location || strategyContext?.location || null;
  const industry = business?.industry || strategyContext?.industry || null;

  const prompt = `You are an audience research and targeting expert. Discover and define the optimal target audience for the following campaign.

CAMPAIGN:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Primary Outcome: ${brief.primaryOutcome || "Not specified"}
- Target Audience: ${brief.targetAudience || "Not specified"}
- Target Buyer: ${brief.targetBuyer || "Not specified"}
- Main Pain Point: ${brief.mainPainPoint || "Not specified"}
- Core Message: ${brief.coreMessage || "Not specified"}
- Product/Service: ${brief.productOrService || "Not specified"}
- Offer Details: ${brief.offerDetails || "Not specified"}
- Preferred CTA: ${brief.preferredCta || "Not specified"}
- Excluded Offers/Words: ${brief.excludedOffers || "None specified"}
- Reference Style: ${brief.referenceStyle || "Not specified"}
- Content Style: ${brief.contentStyle || "Not specified"}
- Platforms: ${campaign.platforms || "Not specified"}
- Industry: ${industry || "Not specified"}
- Location: ${location || "Not specified"}
- Business Type: ${businessType === "not_specified" ? "Not specified" : businessType}

PERSONAS:
${personas ? JSON.stringify(personas.map((p: any) => ({ name: p.name, demographics: p.demographics, painPoints: p.painPoints }))) : "General audience"}

${strategyContext?.platformStrategy ? `Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

LOCATION RULE — YOU MUST FOLLOW THIS EXACTLY:
- The business location is: ${location || "Not specified"}.
- If a location is specified above, you MUST use that location exactly. Do NOT invent a different city, province, state, or country.
- If the location is Johannesburg, South Africa, your audience profiles and targeting must reflect Johannesburg, Gauteng, and South Africa.
- Only use international locations if the user has explicitly selected international targeting.
- If location is "Not specified", you may infer a reasonable location from the business context, but state it clearly.

Your task:
1. Define 3-4 detailed audience profiles with demographics, interests, and behaviours
2. Create precise targeting criteria for ad platforms
3. ${isB2B ? "Define B2B filters (company types, job titles, decision-makers)" : "Define B2C targeting (interests, demographics, behaviour segments)"}
4. Create a hashtag strategy (primary, secondary, trending, branded)
5. Identify 2-3 competitor audience insights
6. Define 3-5 outreach angles/messaging hooks

CRITICAL SCHEMA RULES — YOU MUST FOLLOW THESE EXACTLY:
- Every object in the response MUST include EVERY key declared in its schema.
- If you do not have a value for a field, return null. Do NOT omit the key.
- Example: if a profile has no age range, return "ageRange": null.
- Example: if there are no B2B filters, return "b2bFilters": null.
- Never leave out any nested field. The schema is strict and every key is required.
- Respond with valid structured data only.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "audience",
    prompt,
    schema: AudienceDiscoverySchema,
    system:
      "You are an expert audience researcher and media buyer. You understand Facebook Ads Manager, Google Ads, LinkedIn Campaign Manager, and TikTok Ads. You create detailed, actionable audience targeting recommendations. CRITICAL: You must include EVERY key in every object. Use null for fields that do not apply. Never omit a key.",
  });

  // Normalise the AI output so missing/undefined fields become safe defaults
  const normalised = normaliseAudienceOutput(result.output);

  // Save audience data to campaign
  await db
    .update(campaigns)
    .set({
      workflowState: "audience_ready",
      workflowContext: {
        ...(strategyContext || {}),
        audienceGeneratedAt: new Date().toISOString(),
        audienceRunId: result.runId,
        audienceProfiles: normalised.audienceProfiles,
        targetingCriteria: normalised.targetingCriteria,
        hashtagStrategy: normalised.hashtagStrategy,
        competitorInsights: normalised.competitorInsights,
        outreachAngles: normalised.outreachAngles,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return { runId: result.runId, output: normalised };
}
