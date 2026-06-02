import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns } from "@db/schema";
import { eq } from "drizzle-orm";

const AudienceDiscoverySchema = z.object({
  audienceProfiles: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      demographics: z.object({
        ageRange: z.string().optional(),
        gender: z.string().optional(),
        locations: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
      }),
      interests: z.array(z.string()).optional(),
      behaviours: z.array(z.string()).optional(),
      painPoints: z.array(z.string()).optional(),
      platforms: z.array(z.string()).optional(),
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
    companyTypes: z.array(z.string()).optional(),
    jobTitles: z.array(z.string()).optional(),
    industries: z.array(z.string()).optional(),
    companySizes: z.array(z.string()).optional(),
    decisionMakers: z.array(z.string()).optional(),
  }).optional(),
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
  isB2B = false,
}: {
  userId: number;
  campaignId: number;
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

  const strategyContext = campaign.workflowContext as any;
  const personas = campaign.personas as any[];

  const prompt = `You are an audience research and targeting expert. Discover and define the optimal target audience for the following campaign.

CAMPAIGN:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Core Message: ${campaign.coreMessage || "Not specified"}
- Platforms: ${campaign.platforms || "Not specified"}
- Industry: ${strategyContext?.industry || "Not specified"}
- Location: ${strategyContext?.location || "Not specified"}
- Business Type: ${isB2B ? "B2B" : "B2C"}

PERSONAS:
${personas ? JSON.stringify(personas.map((p: any) => ({ name: p.name, demographics: p.demographics, painPoints: p.painPoints }))) : "General audience"}

${strategyContext?.platformStrategy ? `Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

Your task:
1. Define 3-4 detailed audience profiles with demographics, interests, and behaviours
2. Create precise targeting criteria for ad platforms
3. ${isB2B ? "Define B2B filters (company types, job titles, decision-makers)" : "Define B2C targeting (interests, demographics, behaviour segments)"}
4. Create a hashtag strategy (primary, secondary, trending, branded)
5. Identify 2-3 competitor audience insights
6. Define 3-5 outreach angles/messaging hooks

Respond with structured data.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "audience",
    prompt,
    schema: AudienceDiscoverySchema,
    system:
      "You are an expert audience researcher and media buyer. You understand Facebook Ads Manager, Google Ads, LinkedIn Campaign Manager, and TikTok Ads. You create detailed, actionable audience targeting recommendations. Always respond with valid structured data.",
  });

  // Save audience data to campaign
  await db
    .update(campaigns)
    .set({
      workflowState: "audience_ready",
      workflowContext: {
        ...(strategyContext || {}),
        audienceGeneratedAt: new Date().toISOString(),
        audienceRunId: result.runId,
        audienceProfiles: result.output.audienceProfiles,
        targetingCriteria: result.output.targetingCriteria,
        hashtagStrategy: result.output.hashtagStrategy,
        competitorInsights: result.output.competitorInsights,
        outreachAngles: result.output.outreachAngles,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return result;
}
