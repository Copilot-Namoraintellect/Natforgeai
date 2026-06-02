import { generateObject } from "ai";
import { z } from "zod";
import { defaultModel } from "../agents/openai";
import { checkCredits, deductCredits, recordAiUsage } from "../billing/credit-engine";
import { calculateTokenCost } from "../billing/cost-tracker";

const SafetyResultSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
});

export type SafetyResult = z.infer<typeof SafetyResultSchema>;

export async function checkContentSafety(
  content: string,
  context: {
    brandTone?: string;
    industry?: string;
  },
  billingContext?: {
    userId: number;
    campaignId?: number;
    skipDeduction?: boolean;
  }
): Promise<SafetyResult> {
  // If no OpenAI key is configured, return low risk (pass-through)
  if (!process.env.OPENAI_API_KEY) {
    return {
      riskLevel: "low",
      reasons: ["Safety check skipped: no AI key configured"],
      suggestedFixes: [],
    };
  }

  const SAFETY_CHECK_COST = 1;
  let creditsDeducted = 0;

  // Billing pre-check
  if (billingContext && !billingContext.skipDeduction) {
    const preCheck = await checkCredits(billingContext.userId, SAFETY_CHECK_COST);
    if (!preCheck.hasCredits) {
      // Insufficient credits — treat as medium risk requiring manual review
      return {
        riskLevel: "medium",
        reasons: ["Safety check skipped: insufficient credits; manual review required"],
        suggestedFixes: ["Add credits or review content manually before publishing"],
      };
    }
    await deductCredits({
      userId: billingContext.userId,
      amount: SAFETY_CHECK_COST,
      type: "agent_deduction",
      description: "Content safety check",
      metadata: { campaignId: billingContext.campaignId },
    });
    creditsDeducted = SAFETY_CHECK_COST;
  }

  try {
    const result = await generateObject({
      model: defaultModel,
      system:
        "You are a content safety reviewer. Evaluate marketing content for brand safety, compliance, and policy risks. Be thorough but practical.",
      prompt: `Review the following marketing content for risks.

CONTENT:
"""
${content}
"""

CONTEXT:
- Brand Tone: ${context.brandTone || "Not specified"}
- Industry: ${context.industry || "Not specified"}

Check for: offensive language, false claims, regulated industry risk, pricing accuracy, platform policy violations, personal data exposure, brand tone mismatch.

Return a structured safety assessment.`,
      schema: SafetyResultSchema,
    });

    const object = result.object;
    const usage = (result as any).usage;

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;

    const { actualCostUsdMicro, estimatedCostUsdMicro } = calculateTokenCost(
      defaultModel as any,
      promptTokens,
      completionTokens
    );

    // Record AI usage for cost tracking (always, even if bundled)
    if (billingContext) {
      await recordAiUsage({
        userId: billingContext.userId,
        campaignId: billingContext.campaignId,
        agentType: "safety_check",
        model: "gpt-4o-mini",
        promptTokens,
        completionTokens,
        actualCostUsdMicro,
        estimatedCostUsdMicro,
        creditsDeducted,
        metadata: { riskLevel: object.riskLevel },
      });
    }

    return object;
  } catch (error) {
    // Record failed usage attempt for cost tracking
    if (billingContext) {
      await recordAiUsage({
        userId: billingContext.userId,
        campaignId: billingContext.campaignId,
        agentType: "safety_check",
        model: "gpt-4o-mini",
        promptTokens: 1500,
        completionTokens: 500,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 500_000,
        creditsDeducted,
        metadata: { failed: true },
      });
    }

    // If AI safety check fails, default to medium risk to require human review
    return {
      riskLevel: "medium",
      reasons: ["Safety check encountered an error; manual review recommended"],
      suggestedFixes: ["Review content manually before publishing"],
    };
  }
}
