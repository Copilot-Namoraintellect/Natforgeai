import { z } from "zod";
import { runAgent } from "./runner";
import { strategyAgentPrompt } from "./prompts";
import { getDb } from "../../queries/connection";
import { campaigns } from "@db/schema";
import { eq } from "drizzle-orm";

function parseBudgetNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // Extract first numeric value from strings like "$50,000 in the first year"
    const cleaned = value.replace(/[$,]/g, "").replace(/\s+/g, " ");
    const match = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (match) return parseFloat(match[1]);
  }
  return 0;
}

const StrategyOutputSchema = z.object({
  personas: z.array(
    z.object({
      name: z.string(),
      demographics: z.string(),
      painPoints: z.array(z.string()),
      goals: z.array(z.string()),
      platforms: z.array(z.string()),
    })
  ),
  positioning: z.string(),
  valueProposition: z.string(),
  coreMessage: z.string(),
  campaignTheme: z.string(),
  platformStrategy: z.array(
    z.object({
      platform: z.string(),
      purpose: z.string(),
      contentTypes: z.array(z.string()),
      postingFrequency: z.string(),
    })
  ),
  funnelStages: z.array(
    z.object({
      stage: z.string(),
      goal: z.string(),
      tactics: z.array(z.string()),
      metrics: z.array(z.string()),
    })
  ),
  offers: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      targetStage: z.string(),
      value: z.string(),
    })
  ),
  ctas: z.array(
    z.object({
      stage: z.string(),
      cta: z.string(),
      placement: z.string(),
    })
  ),
  budgetRecommendation: z.object({
    total: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
    allocation: z.array(
      z.object({
        channel: z.string(),
        amount: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
        percentage: z.union([z.number(), z.string()]).transform(parseBudgetNumber),
      })
    ),
  }),
});

export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;

export async function runStrategyAgent({
  userId,
  campaignId,
  business,
  strategyText,
}: {
  userId: number;
  campaignId: number;
  business: {
    name: string;
    industry?: string | null;
    location?: string | null;
    productOrService?: string | null;
    targetCustomer?: string | null;
    brandTone?: string | null;
    mainGoal?: string | null;
    monthlyBudget?: number | null;
    preferredPlatforms?: string | null;
    website?: string | null;
  };
  strategyText?: string;
}) {
  const prompt = strategyAgentPrompt({
    businessName: business.name,
    industry: business.industry ?? undefined,
    location: business.location ?? undefined,
    productOrService: business.productOrService ?? undefined,
    targetCustomer: business.targetCustomer ?? undefined,
    brandTone: business.brandTone ?? undefined,
    mainGoal: business.mainGoal ?? undefined,
    monthlyBudget: business.monthlyBudget ?? undefined,
    preferredPlatforms: business.preferredPlatforms ?? undefined,
    website: business.website ?? undefined,
    strategyText,
  });

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "strategy",
    prompt,
    schema: StrategyOutputSchema,
    system:
      "You are a world-class marketing strategist. You create detailed, actionable marketing strategies for businesses. Always respond with valid structured data.",
  });

  // Save strategy output to campaign
  const db = getDb();
  await db
    .update(campaigns)
    .set({
      strategyDocument: strategyText || null,
      personas: result.output.personas as any,
      funnelStages: result.output.funnelStages as any,
      offers: result.output.offers as any,
      ctaStrategy: result.output.ctas.map((c) => `${c.stage}: ${c.cta}`).join("\n"),
      workflowContext: {
        strategyGeneratedAt: new Date().toISOString(),
        strategyRunId: result.runId,
        positioning: result.output.positioning,
        valueProposition: result.output.valueProposition,
        coreMessage: result.output.coreMessage,
        campaignTheme: result.output.campaignTheme,
        budgetRecommendation: result.output.budgetRecommendation,
        location: business.location || null,
        industry: business.industry || null,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return result;
}
