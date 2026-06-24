import type { CampaignInterestSignal } from "@db/schema";

const EVENT_WEIGHTS: Record<string, number> = {
  message: 40,
  share: 35,
  comment: 25,
  save: 20,
  follow: 30,
  click: 15,
  like: 10,
  post_interaction: 5,
};

function recencyMultiplier(daysAgo: number): number {
  if (daysAgo <= 7) return 1.0;
  if (daysAgo <= 30) return 0.7;
  if (daysAgo <= 90) return 0.4;
  return 0;
}

export function extractCampaignKeywords(campaign: {
  name?: string | null;
  goal?: string | null;
  targetAudience?: string | null;
  productOrService?: string | null;
  offerDetails?: string | null;
  primaryOutcome?: string | null;
  coreMessage?: string | null;
}): string[] {
  const text = [
    campaign.name,
    campaign.goal,
    campaign.targetAudience,
    campaign.productOrService,
    campaign.offerDetails,
    campaign.primaryOutcome,
    campaign.coreMessage,
  ]
    .filter(Boolean)
    .join(" ");

  // Simple tokenisation: lowercase, strip punctuation, keep words > 3 chars
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3);

  // Deduplicate while preserving order
  return Array.from(new Set(tokens));
}

export function countKeywordMatches(text: string | null | undefined, keywords: string[]): number {
  if (!text) return 0;
  const normalised = text.toLowerCase();
  return keywords.reduce((count, keyword) => {
    return normalised.includes(keyword.toLowerCase()) ? count + 1 : count;
  }, 0);
}

export interface BaselineScoreResult {
  score: number;
  keywordBonus: number;
  signalCount: number;
  strongestSignalType: string;
  explanationParts: string[];
}

export function computeBaselineScore(
  signal: CampaignInterestSignal,
  sourceEvents: Array<{ eventType: string; eventTimestamp: Date; messageText?: string | null }>,
  campaignKeywords: string[]
): BaselineScoreResult {
  let score = 0;
  let signalCount = 0;
  const explanationParts: string[] = [];
  const typeCounts: Record<string, number> = {};

  for (const event of sourceEvents) {
    const weight = EVENT_WEIGHTS[event.eventType] ?? 5;
    const daysAgo = (Date.now() - event.eventTimestamp.getTime()) / (1000 * 60 * 60 * 24);
    const multiplier = recencyMultiplier(daysAgo);
    if (multiplier === 0) continue;

    score += weight * multiplier;
    signalCount += 1;
    typeCounts[event.eventType] = (typeCounts[event.eventType] || 0) + 1;
  }

  const keywordText = [
    signal.contextSnippet,
    ...sourceEvents.map((e) => e.messageText),
  ]
    .filter(Boolean)
    .join(" ");

  const keywordBonus = Math.min(20, countKeywordMatches(keywordText, campaignKeywords) * 5);
  score += keywordBonus;

  const strongestSignalType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "engagement";

  if (typeCounts.comment) explanationParts.push(`${typeCounts.comment} comment(s)`);
  if (typeCounts.share) explanationParts.push(`${typeCounts.share} share(s)`);
  if (typeCounts.message) explanationParts.push(`${typeCounts.message} message(s)`);
  if (typeCounts.follow) explanationParts.push(`${typeCounts.follow} follow(s)`);
  if (typeCounts.like) explanationParts.push(`${typeCounts.like} like(s)`);
  if (typeCounts.post_interaction) explanationParts.push(`${typeCounts.post_interaction} post interaction(s)`);
  if (keywordBonus > 0) explanationParts.push(`keyword match bonus +${keywordBonus}`);

  score = Math.min(100, Math.round(score));

  return {
    score,
    keywordBonus,
    signalCount,
    strongestSignalType,
    explanationParts,
  };
}

export function confidenceFromScore(score: number, signalCount: number): "low" | "medium" | "high" {
  if (score >= 70 && signalCount >= 2) return "high";
  if (score >= 40 && signalCount >= 1) return "medium";
  return "low";
}

export function actionFromScore(score: number, confidence: "low" | "medium" | "high"): "reach_out" | "nurture" | "ignore" {
  if (score >= 70 && confidence !== "low") return "reach_out";
  if (score >= 40) return "nurture";
  return "ignore";
}
