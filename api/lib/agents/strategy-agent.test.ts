import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateStrategyOutput, StrategyOutput, chargeForStrategyRun } from "./strategy-agent";

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(async () => undefined),
}));

function buildOutput(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
  return {
    personas: [
      {
        name: "Restaurant Owner Rita",
        demographics: "Restaurant owner in South Africa",
        painPoints: ["Slow end-of-day cash-outs"],
        goals: ["Get paid faster"],
        platforms: ["Facebook", "Instagram"],
      },
    ],
    positioning: "The fastest payout platform for restaurants.",
    valueProposition: "Restaurants get their money the same day with zero hassle.",
    coreMessage: "Stop waiting for payouts. Get paid today with our restaurant payout platform.",
    campaignTheme: "Same-day payouts for restaurants",
    platformStrategy: [
      {
        platform: "Facebook",
        purpose: "Reach restaurant owners",
        contentTypes: ["carousel ads"],
        postingFrequency: "3x per week",
      },
    ],
    funnelStages: [
      {
        stage: "awareness",
        goal: "Reach restaurant owners",
        tactics: ["Targeted ads"],
        metrics: ["impressions"],
      },
    ],
    offers: [],
    ctas: [
      { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
      { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
    ],
    budgetRecommendation: {
      total: 5000,
      allocation: [{ channel: "Facebook", amount: 5000, percentage: 100 }],
    },
    ...overrides,
  };
}

describe("validateStrategyOutput", () => {
  const currentFingerprint = "fp-current";
  const baseBrief = {
    productOrService: "payout platform for restaurants",
    targetBuyer: "restaurant owners",
    mainPainPoint: "Slow end-of-day cash-outs",
    preferredCta: "Book a Demo",
    primaryOutcome: "Increase restaurant sign-ups",
    offerDetails: "",
    excludedOffers: "payroll; employee payouts; credit access; mass disbursements",
  };

  it("accepts a grounded, complete strategy output", () => {
    const result = validateStrategyOutput({
      output: { ...buildOutput(), creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(true);
  });

  it("rejects an output whose fingerprint does not match the current brief", () => {
    const result = validateStrategyOutput({
      output: { ...buildOutput(), creativeBriefFingerprint: "fp-old" },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("fingerprint");
  });

  it("rejects stale conflicting audience classifications such as 'small businesses'", () => {
    const output = buildOutput({
      personas: [
        {
          name: "Small Business Sam",
          demographics: "owner of small businesses in South Africa",
          painPoints: ["Slow end-of-day cash-outs"],
          goals: ["Get paid faster"],
          platforms: ["Facebook"],
        },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("small businesses");
  });

  it("rejects output that contains excluded offers or claims", () => {
    const output = buildOutput({
      coreMessage: "Our payroll solution pays employees on time.",
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("payroll");
  });

  it("rejects output that omits the preferred CTA", () => {
    const output = buildOutput({
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad" },
        { stage: "conversion", cta: "Sign Up", placement: "page" },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("preferred CTA");
  });

  it("rejects invented offers when offerDetails is empty", () => {
    const output = buildOutput({
      offers: [
        {
          name: "Free Trial",
          description: "30 days free",
          targetStage: "awareness",
          value: "$100",
        },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: baseBrief,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("offers");
  });

  it("accepts offers that are authorised by offerDetails", () => {
    const output = buildOutput({
      offers: [
        {
          name: "First Month Free",
          description: "Restaurants get their first month free",
          targetStage: "conversion",
          value: "$49",
        },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, offerDetails: "First month free for restaurants" },
    });

    expect(result.valid).toBe(true);
  });
});

describe("chargeForStrategyRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deducts exactly 3 credits once and records AI usage", async () => {
    const { deductCredits, recordAiUsage } = await import("../billing/credit-engine");

    await chargeForStrategyRun(18, 42, {
      runId: 999,
      output: {} as StrategyOutput,
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    });

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        amount: 3,
        type: "agent_deduction",
        idempotencyKey: "strategy-run-999",
      })
    );
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 42,
        agentType: "strategy",
        creditsDeducted: 3,
      })
    );
  });
});
