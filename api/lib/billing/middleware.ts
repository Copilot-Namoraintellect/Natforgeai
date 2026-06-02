import { TRPCError } from "@trpc/server";
import { deductCredits, recordAiUsage, checkCredits } from "./credit-engine";
import { getEstimatedAgentCost, calculateTokenCost } from "./cost-tracker";

/**
 * Wraps an async operation with credit deduction and usage tracking.
 * This is the core billing middleware for all AI operations.
 */
export async function withBilling<T>({
  userId,
  campaignId,
  agentType,
  model,
  operation,
  description,
  metadata,
}: {
  userId: number;
  campaignId?: number;
  agentType: string;
  model: string;
  operation: () => Promise<T>;
  description: string;
  metadata?: Record<string, any>;
}): Promise<T> {
  const estimatedCost = getEstimatedAgentCost(agentType);

  // Pre-flight credit check
  const preCheck = await checkCredits(userId, estimatedCost);
  if (!preCheck.hasCredits) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `Insufficient credits. You have ${preCheck.balance} credits. This operation requires ${estimatedCost} credits.`,
    });
  }

  // Deduct estimated credits upfront
  const { newBalance } = await deductCredits({
    userId,
    amount: estimatedCost,
    type: "agent_deduction",
    description,
    metadata: { estimatedCost, campaignId, ...metadata },
  });

  try {
    const result = await operation();

    // Record usage with estimated token counts
    // In production, this should be updated with actual token counts from the AI response
    const estimatedTokens = getEstimatedTokensForAgent(agentType);
    const { actualCostUsdMicro, estimatedCostUsdMicro } = calculateTokenCost(
      model as any,
      estimatedTokens.prompt,
      estimatedTokens.completion
    );

    await recordAiUsage({
      userId,
      campaignId,
      agentType,
      model,
      promptTokens: estimatedTokens.prompt,
      completionTokens: estimatedTokens.completion,
      actualCostUsdMicro,
      estimatedCostUsdMicro,
      creditsDeducted: estimatedCost,
      metadata: { balanceAfter: newBalance, ...metadata },
    });

    return result;
  } catch (error) {
    // On failure, we don't refund credits — the operation was attempted
    // In a future iteration, we could refund for infrastructure failures
    throw error;
  }
}

/**
 * Wraps a publishing operation with credit deduction.
 */
export async function withPublishingBilling<T>({
  userId,
  platform,
  operation,
  description,
}: {
  userId: number;
  platform: string;
  operation: () => Promise<T>;
  description: string;
}): Promise<T> {
  const cost = 1; // 1 credit per publish attempt

  const preCheck = await checkCredits(userId, cost);
  if (!preCheck.hasCredits) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `Insufficient credits to publish. You have ${preCheck.balance} credits. Publishing requires ${cost} credit per post.`,
    });
  }

  await deductCredits({
    userId,
    amount: cost,
    type: "publishing_deduction",
    description,
    metadata: { platform },
  });

  return operation();
}

/**
 * Helper to estimate token counts per agent type.
 * These are conservative estimates for pre-flight cost calculation.
 */
function getEstimatedTokensForAgent(agentType: string): { prompt: number; completion: number } {
  const estimates: Record<string, { prompt: number; completion: number }> = {
    strategy: { prompt: 2000, completion: 3000 },
    creative: { prompt: 3000, completion: 4000 },
    audience: { prompt: 2000, completion: 2500 },
    distribution: { prompt: 1500, completion: 2000 },
    engagement: { prompt: 1000, completion: 800 },
    sales: { prompt: 1500, completion: 1500 },
    optimisation: { prompt: 2000, completion: 2000 },
    safety_check: { prompt: 1500, completion: 500 },
    image_generation: { prompt: 500, completion: 100 },
    video_generation: { prompt: 1000, completion: 200 },
  };
  return estimates[agentType] ?? { prompt: 1500, completion: 1500 };
}
