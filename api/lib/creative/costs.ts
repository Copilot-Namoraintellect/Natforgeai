import { env } from "../env";

export function getPremiumImageCredits(): number {
  const value = env.premiumImageCredits;
  return Number.isFinite(value) && value > 0 ? value : 10;
}

export function getPremiumImageInternalCredits(): number {
  const value = env.premiumImageInternalCredits;
  return Number.isFinite(value) && value > 0 ? value : 5;
}

export function getPremiumImageExternalCredits(): number {
  const value = env.premiumImageExternalCredits;
  return Number.isFinite(value) && value > 0 ? value : 10;
}

export function getPremiumImageAiCredits(): number {
  const value = env.premiumImageAiCredits;
  return Number.isFinite(value) && value > 0 ? value : 10;
}

export function getPremiumVideoCredits(): number {
  const value = env.premiumVideoCredits;
  return Number.isFinite(value) && value > 0 ? value : 100;
}

export function getPremiumHeroPackCredits(): number {
  const value = env.premiumHeroPackCredits;
  return Number.isFinite(value) && value > 0 ? value : 120;
}

export function getCreatifyCreditUsd(): number {
  const value = env.creatifyCreditUsd;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Convert Creatify's own "credits_used" into an estimated USD cost.
 * If CREATIFY_CREDIT_USD is not set, returns 0 (raw credits are still stored).
 */
export function creatifyCreditsToUsd(creditsUsed: number): number {
  const rate = getCreatifyCreditUsd();
  return Math.round(creditsUsed * rate * 1_000_000); // micro-cents
}

/**
 * Convert a USD amount (dollars) to micro-cents for ai_usage tables.
 */
export function usdToMicroCents(usd: number): number {
  return Math.round(usd * 1_000_000);
}
