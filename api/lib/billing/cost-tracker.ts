/**
 * Cost Tracker — Maps agent/model usage to actual and estimated costs.
 *
 * Costs are tracked internally in micro-cents (1 USD = 1_000_000 micro-cents)
 * for precision. Credits are the customer-facing unit.
 *
 * Credit conversion: 1 credit = $0.01 USD = 10_000 micro-cents
 */

export type CostModel =
  | "gpt-4o-mini"
  | "gpt-4o"
  | "dall-e-3"
  | "estimated-image"
  | "estimated-video";

// OpenAI pricing per 1M tokens (in USD)
const OPENAI_PRICING: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "gpt-4o": { prompt: 2.5, completion: 10.0 },
};

// Estimated fixed costs per operation (in USD)
const ESTIMATED_COSTS: Record<string, number> = {
  "estimated-image": 0.02, // per image
  "estimated-video": 0.1, // per video
};

// Credit conversion rate
const CREDITS_PER_USD = 100; // 1 USD = 100 credits

/**
 * Convert USD amount to credits.
 */
export function usdToCredits(usd: number): number {
  return Math.ceil(usd * CREDITS_PER_USD);
}

/**
 * Convert credits to USD.
 */
export function creditsToUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}

/**
 * Calculate actual cost in micro-cents for a token-based AI call.
 */
export function calculateTokenCost(
  model: CostModel,
  promptTokens: number,
  completionTokens: number
): { actualCostUsdMicro: number; estimatedCostUsdMicro: number } {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) {
    // Fallback to estimated cost if model unknown
    return { actualCostUsdMicro: 0, estimatedCostUsdMicro: 500_000 }; // $0.05 estimate
  }

  const promptCost = (promptTokens / 1_000_000) * pricing.prompt;
  const completionCost = (completionTokens / 1_000_000) * pricing.completion;
  const totalCost = promptCost + completionCost;

  // Convert to micro-cents
  const actualCostUsdMicro = Math.round(totalCost * 1_000_000);

  // Estimated cost includes 20% overhead for overhead (retries, context, etc.)
  const estimatedCostUsdMicro = Math.round(totalCost * 1.2 * 1_000_000);

  return { actualCostUsdMicro, estimatedCostUsdMicro };
}

/**
 * Calculate estimated cost for fixed-price operations (images, videos).
 */
export function calculateFixedCost(
  operation: "estimated-image" | "estimated-video",
  count: number = 1
): { actualCostUsdMicro: number; estimatedCostUsdMicro: number } {
  const baseCost = ESTIMATED_COSTS[operation] ?? 0.05;
  const totalCost = baseCost * count;

  return {
    actualCostUsdMicro: 0, // No actual cost tracked yet
    estimatedCostUsdMicro: Math.round(totalCost * 1_000_000),
  };
}

/**
 * Get estimated credit cost for an agent run before execution.
 * Used for pre-flight credit checks.
 */
export function getEstimatedAgentCost(agentType: string): number {
  const estimates: Record<string, number> = {
    strategy: 3, // ~$0.03
    creative: 5, // ~$0.05 (2 calls)
    audience: 3, // ~$0.03
    distribution: 2, // ~$0.02
    engagement: 1, // ~$0.01
    sales: 1, // ~$0.01
    optimisation: 2, // ~$0.02
    safety_check: 1, // ~$0.01
    image_generation: 2, // ~$0.02
    video_generation: 10, // ~$0.10
  };
  return estimates[agentType] ?? 2;
}

/**
 * Format micro-cents to USD string for internal reporting.
 */
export function formatMicroCents(microCents: number): string {
  const dollars = microCents / 1_000_000;
  return `$${dollars.toFixed(4)}`;
}
