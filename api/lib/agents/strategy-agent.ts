import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { runAgent } from "./runner";
import { strategyAgentPrompt } from "./prompts";
import { getDb } from "../../queries/connection";
import { agentRuns, campaigns } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { buildGroundedCreativeBrief } from "../creative/brief-grounding";
import { deductCredits, recordAiUsage } from "../billing/credit-engine";
import { enforceCostControl } from "../billing/cost-control";
import { getEstimatedAgentCost } from "../billing/cost-tracker";

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

export interface StrategyValidationInput {
  output: StrategyOutput & { creativeBriefFingerprint?: string };
  currentFingerprint: string;
  brief: {
    productOrService?: string | null;
    targetBuyer?: string | null;
    mainPainPoint?: string | null;
    preferredCta?: string | null;
    primaryOutcome?: string | null;
    offerDetails?: string | null;
    excludedOffers?: string | null;
  };
}

export interface StrategyValidationResult {
  valid: boolean;
  reason?: string;
}

export interface StrategyAgentRunResult {
  runId: number;
  output: StrategyOutput;
  promptTokens: number;
  completionTokens: number;
  actualCostUsdMicro: number;
  estimatedCostUsdMicro: number;
}

function normalizeValidationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle || !haystack) return false;
  const normalizedHaystack = normalizeValidationText(haystack);
  const normalizedNeedle = normalizeValidationText(needle);
  if (!normalizedNeedle) return false;
  return normalizedHaystack.includes(normalizedNeedle);
}

function gatherOutputText(output: StrategyOutput): string {
  const parts: string[] = [
    output.coreMessage,
    output.positioning,
    output.valueProposition,
    output.campaignTheme,
  ];
  for (const persona of output.personas) {
    parts.push(persona.name, persona.demographics, ...persona.painPoints, ...persona.goals, ...persona.platforms);
  }
  for (const ps of output.platformStrategy) {
    parts.push(ps.platform, ps.purpose, ...ps.contentTypes, ps.postingFrequency);
  }
  for (const fs of output.funnelStages) {
    parts.push(fs.stage, fs.goal, ...fs.tactics, ...fs.metrics);
  }
  for (const offer of output.offers) {
    parts.push(offer.name, offer.description, offer.targetStage, offer.value);
  }
  for (const cta of output.ctas) {
    parts.push(cta.stage, cta.cta, cta.placement);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Pure strategy-output validation gate.
 *
 * Confirms that a generated strategy is grounded in the current campaign brief
 * before any approval request or lineage is created. Returns a safe diagnostic
 * when validation fails so the caller can mark the run failed and release the
 * claim without exposing raw output to users.
 */
export function validateStrategyOutput({
  output,
  currentFingerprint,
  brief,
}: StrategyValidationInput): StrategyValidationResult {
  // 1. Fingerprint match — proves the strategy was produced from the current brief.
  if (output.creativeBriefFingerprint !== currentFingerprint) {
    return {
      valid: false,
      reason: "Strategy output fingerprint does not match the current campaign brief.",
    };
  }

  const outputText = gatherOutputText(output);

  // 2. Product/service materially represented.
  if (brief.productOrService && !containsPhrase(outputText, brief.productOrService)) {
    return {
      valid: false,
      reason: `Strategy output does not materially represent the product/service: ${brief.productOrService}.`,
    };
  }

  // 3. Target buyer materially represented.
  if (brief.targetBuyer && !containsPhrase(outputText, brief.targetBuyer)) {
    return {
      valid: false,
      reason: `Strategy output does not materially represent the target buyer: ${brief.targetBuyer}.`,
    };
  }

  // 4. Main pain point addressed.
  if (brief.mainPainPoint && !containsPhrase(outputText, brief.mainPainPoint)) {
    return {
      valid: false,
      reason: `Strategy output does not address the main pain point: ${brief.mainPainPoint}.`,
    };
  }

  // 5. Preferred CTA used in the CTA strategy.
  if (brief.preferredCta) {
    const ctaText = output.ctas.map((c) => c.cta).join(" ");
    if (!containsPhrase(ctaText, brief.preferredCta)) {
      return {
        valid: false,
        reason: `Strategy output does not use the preferred CTA: ${brief.preferredCta}.`,
      };
    }
  }

  // 6. Excluded offers/claims absent.
  if (brief.excludedOffers) {
    const excluded = brief.excludedOffers
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const term of excluded) {
      if (containsPhrase(outputText, term)) {
        return {
          valid: false,
          reason: `Strategy output contains excluded offer or claim: ${term}.`,
        };
      }
    }
  }

  // 7. Stale conflicting audience classifications absent.
  const staleTerms = [
    "small businesses",
    "payroll",
    "employee payouts",
    "credit access",
    "mass disbursements",
  ];
  const briefText = [brief.productOrService, brief.targetBuyer, brief.mainPainPoint, brief.offerDetails, brief.excludedOffers]
    .filter(Boolean)
    .join(" ");
  for (const term of staleTerms) {
    if (!containsPhrase(briefText, term) && containsPhrase(outputText, term)) {
      return {
        valid: false,
        reason: `Strategy output contains stale audience classification: ${term}.`,
      };
    }
  }

  // 8. Offers empty unless explicitly authorised by the brief.
  const hasOfferDetails = !!(brief.offerDetails && brief.offerDetails.trim().length > 0);
  if (!hasOfferDetails && output.offers.length > 0) {
    return {
      valid: false,
      reason: "Strategy output invented offers that were not authorised by the campaign brief.",
    };
  }

  return { valid: true };
}

/**
 * Pure validation gate for an existing strategy run output against the current
 * persisted campaign brief. Rejects runs whose fingerprint matches but whose
 * content is not semantically grounded in the brief.
 */
export function validateStrategyOutputAgainstCampaign(
  output: unknown,
  campaign: unknown
): StrategyValidationResult {
  const brief = buildGroundedCreativeBrief({ campaign });
  const raw = (output || {}) as Record<string, unknown>;
  const parseResult = StrategyOutputSchema.safeParse(raw);
  if (!parseResult.success) {
    return { valid: false, reason: "Strategy output is not a valid strategy structure." };
  }
  const outputWithFingerprint: StrategyOutput & { creativeBriefFingerprint?: string } = {
    ...parseResult.data,
    creativeBriefFingerprint:
      typeof raw.creativeBriefFingerprint === "string" ? raw.creativeBriefFingerprint : undefined,
  };
  return validateStrategyOutput({
    output: outputWithFingerprint,
    currentFingerprint: brief.fingerprint,
    brief,
  });
}

/**
 * Charge exactly 3 credits for a validated strategy run and record AI usage.
 * Idempotent: repeated calls with the same runId debit the wallet only once.
 */
export async function chargeForStrategyRun(
  userId: number,
  campaignId: number,
  result: StrategyAgentRunResult
): Promise<void> {
  const amount = getEstimatedAgentCost("strategy");
  await deductCredits({
    userId,
    amount,
    type: "agent_deduction",
    description: "Strategy generation",
    idempotencyKey: `strategy-run-${result.runId}`,
    metadata: { agentType: "strategy", campaignId, runId: result.runId },
  });

  await recordAiUsage({
    userId,
    campaignId,
    agentType: "strategy",
    model: "gpt-4o-mini",
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    actualCostUsdMicro: result.actualCostUsdMicro,
    estimatedCostUsdMicro: result.estimatedCostUsdMicro,
    creditsDeducted: amount,
    metadata: { runId: result.runId },
  });
}

export async function runStrategyAgent({
  userId,
  campaignId,
  business,
  strategyText,
  campaignBrief,
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
    websiteEvidence?: unknown;
  };
  strategyText?: string;
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
}): Promise<StrategyAgentRunResult> {
  const db = getDb();

  // Load the persisted campaign so the fingerprint is computed from the
  // current brief, even when the caller did not pass an explicit campaignBrief.
  const [currentCampaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)))
    .limit(1);

  const previousCampaigns = currentCampaign?.businessId
    ? await db
        .select({ id: campaigns.id, workflowContext: campaigns.workflowContext })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.userId, userId),
            eq(campaigns.businessId, currentCampaign.businessId)
          )
        )
        .orderBy(desc(campaigns.createdAt))
        .limit(10)
    : [];

  const audienceIntelligenceSummaries = previousCampaigns
    .filter((c) => c.id !== campaignId)
    .map((c) => {
      const ctx = (c.workflowContext || {}) as Record<string, unknown>;
      const summary = ctx?.audienceIntelligenceSummary as Record<string, unknown> | undefined;
      return summary?.executiveSummary ? String(summary.executiveSummary) : null;
    })
    .filter((s): s is string => !!s)
    .slice(0, 3);

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
    websiteEvidence: business.websiteEvidence,
    strategyText,
    campaignBrief,
    audienceIntelligenceSummaries,
  });

  const estimatedCost = getEstimatedAgentCost("strategy");

  // Preserve the pre-flight cost control that runAgent normally performs when
  // billing is enabled. We skip billing inside runAgent so that the 3-credit
  // charge can be tied to the strategy run ID and applied only after output
  // validation passes.
  const costControl = await enforceCostControl(userId, estimatedCost);
  if (!costControl.allowed) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: costControl.reason || "Insufficient credits for strategy generation.",
    });
  }

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "strategy",
    prompt,
    schema: StrategyOutputSchema,
    system:
      "You are a world-class marketing strategist. You create detailed, actionable marketing strategies for businesses. Always respond with valid structured data.",
    skipBilling: true,
  });

  // Compute the fingerprint of the brief that produced this strategy so later
  // workflow steps can detect whether the campaign brief changed afterwards.
  const fingerprintSource = campaignBrief
    ? ({ ...campaignBrief } as Record<string, unknown>)
    : currentCampaign ?? {};
  const brief = buildGroundedCreativeBrief({ campaign: fingerprintSource });
  const briefFingerprint = brief.fingerprint;

  const outputWithFingerprint = {
    ...result.output,
    creativeBriefFingerprint: briefFingerprint,
  };

  // Pure validation gate: reject stale/ungrounded strategy output before any
  // charge, approval request, lineage or workflow transition.
  const validation = validateStrategyOutput({
    output: outputWithFingerprint,
    currentFingerprint: briefFingerprint,
    brief,
  });

  if (!validation.valid) {
    // Mark the run failed with a safe diagnostic. The caller releases the claim
    // and reports a sanitized error; no credits are charged and no approval is
    // created.
    await db
      .update(agentRuns)
      .set({
        status: "failed",
        error: validation.reason,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, result.runId));

    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: validation.reason || "Strategy output failed validation. Please review the campaign brief and retry.",
    });
  }

  // Record the brief fingerprint on the agent run so we can later find a
  // completed strategy run that matches a given brief fingerprint without
  // deleting historical runs.
  await db
    .update(agentRuns)
    .set({
      output: outputWithFingerprint as any,
    })
    .where(eq(agentRuns.id, result.runId));

  // Save strategy output to campaign
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
        strategyFingerprint: briefFingerprint,
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

  return {
    runId: result.runId,
    output: result.output,
    promptTokens: result.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? 0,
    actualCostUsdMicro: result.actualCostUsdMicro ?? 0,
    estimatedCostUsdMicro: result.estimatedCostUsdMicro ?? 0,
  };
}
