import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { generateObject } from "ai";
import { agentRuns, creativeGenerationClaims } from "@db/schema";
import { validateStrategyOutput, StrategyOutput, chargeForStrategyRun, runStrategyAgent } from "./strategy-agent";

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./openai", () => ({
  defaultModel: { modelId: "gpt-4o-mini" },
}));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../billing/cost-tracker", () => ({
  getEstimatedAgentCost: vi.fn(() => 3),
  calculateTokenCost: vi.fn(() => ({
    actualCostUsdMicro: 0,
    estimatedCostUsdMicro: 0,
  })),
}));

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "fp-current",
    productOrService: "payout platform for restaurants",
    targetBuyer: "restaurant owners",
    mainPainPoint: "slow end-of-day cash-outs",
    preferredCta: "Book a Demo",
    primaryOutcome: "outcome",
    targetAudience: "audience",
    coreMessage: "message",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
  })),
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

  it("accepts a valid compound service description at the capability level", () => {
    // Combines "payouts", "platform" and "restaurants" into one sentence without
    // copying the source word order.
    const output = buildOutput({
      coreMessage: "A same-day payouts platform that helps restaurants get their money faster.",
      positioning: "The fastest payout platform for restaurants.",
      valueProposition: "Restaurants get their payouts the same day with zero hassle.",
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(true);
  });

  it("accepts word-order and plural variations of a capability description", () => {
    // Uses different word order and plural forms while retaining the same
    // material capability tokens: platform, restaurants, payouts.
    const output = buildOutput({
      coreMessage: "Our platform helps restaurants receive their payouts quickly.",
      positioning: "The quickest way for restaurants to get their payouts.",
      valueProposition: "Restaurants get their payouts faster with less hassle.",
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(true);
  });

  it("accepts a documented equivalent term from the B2B payout vocabulary", () => {
    // "disbursement" is a documented equivalent for "payout" within the narrow
    // CAPABILITY_EQUIVALENT_GROUPS set (B2B financial terminology).
    const output = buildOutput({
      coreMessage: "A same-day disbursement platform that helps restaurants get their money faster.",
      positioning: "The fastest disbursement platform for restaurants.",
      valueProposition: "Restaurants get their disbursements the same day with zero hassle.",
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects a nearby but unsupported term that changes the capability meaning", () => {
    // "payment" is financially adjacent but is not included in the supported
    // equivalent group, so it must not be accepted as a substitute for payout.
    const output = buildOutput({
      coreMessage: "A same-day payment platform that helps restaurants pay their bills faster.",
      positioning: "The fastest payment platform for restaurants.",
      valueProposition: "Restaurants make payments the same day with zero hassle.",
      campaignTheme: "Same-day payments for restaurants",
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad headline" },
        { stage: "conversion", cta: "Sign Up", placement: "landing page" },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/product\/service/i);
  });

  it("rejects output that is missing a required core capability", () => {
    // Mentions restaurants and a generic platform but omits the payout/payment capability.
    const output = buildOutput({
      coreMessage: "A marketing platform built just for restaurants.",
      positioning: "The best marketing platform for restaurants.",
      valueProposition: "Restaurants grow faster with our marketing platform.",
      campaignTheme: "Restaurant marketing made easy",
      personas: [
        {
          name: "Restaurant Owner Rita",
          demographics: "Restaurant owner in South Africa",
          painPoints: ["Not enough customers"],
          goals: ["Grow the restaurant"],
          platforms: ["Facebook", "Instagram"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad headline" },
        { stage: "conversion", cta: "Sign Up", placement: "landing page" },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/product\/service/i);
  });

  it("rejects an unrelated or generic-only description", () => {
    const output = buildOutput({
      coreMessage: "The best way to help businesses grow and succeed online.",
      positioning: "A powerful solution for any business.",
      valueProposition: "Get more customers and improve your bottom line.",
      campaignTheme: "Grow any business online",
      personas: [
        {
          name: "Generic Business Owner",
          demographics: "Owner of a business",
          painPoints: ["Not enough customers"],
          goals: ["Grow the business"],
          platforms: ["Facebook"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad headline" },
        { stage: "conversion", cta: "Sign Up", placement: "landing page" },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, productOrService: "payout platform for restaurants" },
    });

    expect(result.valid).toBe(false);
  });

  it("accepts word-order, hyphen and plural variations of target buyer and pain point", () => {
    // Surface-form variations are allowed, but every core capability token from
    // the brief must still be present.
    const output = buildOutput({
      personas: [
        {
          name: "Restaurant Owner Emma",
          demographics: "Restaurant owner in South Africa",
          painPoints: ["Slow cash-outs at the end of the day"],
          goals: ["Get their payouts faster"],
          platforms: ["Facebook", "Instagram"],
        },
      ],
      coreMessage: "Stop waiting for payouts. Get paid today.",
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: {
        ...baseBrief,
        targetBuyer: "restaurant owners",
        mainPainPoint: "slow end-of-day cash-outs",
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects output that replaces the target buyer with an unrelated audience", () => {
    const output = buildOutput({
      coreMessage: "Get paid faster with our payout platform for restaurants.",
      positioning: "The fastest payout platform for homeowners.",
      valueProposition: "Homeowners get their payouts the same day with zero hassle.",
      campaignTheme: "Same-day payouts for homeowners",
      personas: [
        {
          name: "Homeowner Hank",
          demographics: "Homeowner in South Africa",
          painPoints: ["Slow end-of-day cash-outs"],
          goals: ["Get paid faster"],
          platforms: ["Facebook"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      platformStrategy: [
        {
          platform: "Facebook",
          purpose: "Reach homeowners",
          contentTypes: ["carousel ads"],
          postingFrequency: "3x per week",
        },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach homeowners",
          tactics: ["Targeted ads"],
          metrics: ["impressions"],
        },
      ],
    });

    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...baseBrief, targetBuyer: "restaurant owners" },
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target buyer/i);
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

describe("runStrategyAgent atomic run/claim lifecycle", () => {
  const baseBusiness = {
    name: "Test Business",
    industry: "Food & Beverage",
    location: "Johannesburg",
    productOrService: "payout platform for restaurants",
    targetCustomer: "restaurant owners",
    brandTone: "professional",
    mainGoal: "increase sign-ups",
    monthlyBudget: 5000,
    preferredPlatforms: "Facebook, Instagram",
    website: "https://example.com",
    websiteEvidence: {},
  };

  function createMockDb(overrides: { insertId?: number } = {}) {
    const { insertId = 9001 } = overrides;
    let transactionCommitted = false;

    function makeTx() {
      return {
        insert: vi.fn((table: any) => ({
          values: vi.fn(async () => {
            if (table === agentRuns || String(table) === "agent_runs") {
              return [{ insertId }] as any;
            }
            return [];
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(async () => [{ affectedRows: 1 }] as any),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => []),
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            })),
          })),
        })),
      };
    }

    const tx = makeTx();

    const db = {
      transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        const result = await callback(tx);
        transactionCommitted = true;
        return result;
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => [{ affectedRows: 1 }] as any),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
          })),
        })),
      })),
    };

    return { db, tx, get transactionCommitted() { return transactionCommitted; } };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts the run and attaches the claim in the same transaction", async () => {
    const { getDb } = await import("../../queries/connection");
    const { creativeGenerationClaims } = await import("@db/schema");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput(),
      usage: { promptTokens: 100, completionTokens: 50 },
    } as any);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      // Simulates the campaign-router attachment using the supplied transaction.
      await tx.update(creativeGenerationClaims).set({ operationReferenceId: runId }).where({});
    });

    const result = await runStrategyAgent({
      userId: 18,
      campaignId: 42,
      business: baseBusiness,
      onRunCreated,
    });

    expect(result.runId).toBe(9001);
    expect(mock.db.transaction).toHaveBeenCalledTimes(1);
    expect(mock.transactionCommitted).toBe(true);
    expect(onRunCreated).toHaveBeenCalledWith(9001, mock.tx);
  });

  it("rolls back the run insert when claim attachment fails inside the transaction", async () => {
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    let onRunCreatedCalled = false;
    const onRunCreated = vi.fn(async () => {
      onRunCreatedCalled = true;
      throw new TRPCError({ code: "BAD_REQUEST", message: "claim collision" });
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toBeInstanceOf(TRPCError);

    expect(onRunCreatedCalled).toBe(true);
    expect(mock.transactionCommitted).toBe(false);
    // No downstream run-status update should occur because generation never ran.
    expect(mock.db.update).not.toHaveBeenCalled();
  });

  it("marks the committed run failed and returns the run ID when generation fails", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("OpenAI error"));

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("OpenAI error");

    expect(mock.transactionCommitted).toBe(true);
    expect(onRunCreated).toHaveBeenCalledWith(9001, mock.tx);
    // After the transaction commits, generation failure updates the run via db.
    expect(mock.db.update).toHaveBeenCalled();
  });

  it("marks the committed run failed and returns the run ID when semantic validation fails", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    // Generate output that fails semantic validation by omitting the preferred CTA.
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput({
        ctas: [
          { stage: "awareness", cta: "Learn More", placement: "ad headline" },
          { stage: "conversion", cta: "Sign Up", placement: "landing page" },
        ],
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    } as any);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toBeInstanceOf(TRPCError);

    expect(mock.transactionCommitted).toBe(true);
    expect(onRunCreated).toHaveBeenCalledWith(9001, mock.tx);
    expect(mock.db.update).toHaveBeenCalled();
  });

  it("does not charge credits when generation or validation fails", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { deductCredits } = await import("../billing/credit-engine");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("OpenAI error"));

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("OpenAI error");

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("creates a quota alert when generation fails with an OpenAI quota error", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { createAlert } = await import("../alerts");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    const quotaError = new Error("insufficient_quota: You exceeded your current quota");
    (quotaError as any).code = "insufficient_quota";
    (quotaError as any).statusCode = 429;
    vi.mocked(generateObject).mockRejectedValueOnce(quotaError);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("insufficient_quota");

    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        category: "openai",
        message: expect.stringContaining("OpenAI quota/billing exhausted"),
        details: expect.objectContaining({
          agentType: "strategy",
          runId: 9001,
          userId: 18,
          errorCode: "insufficient_quota",
          statusCode: 429,
        }),
      })
    );
  });

  it("creates a provider alert for a non-quota provider failure", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { createAlert } = await import("../alerts");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("OpenAI fetch timeout"));

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("OpenAI fetch timeout");

    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        category: "openai",
        message: expect.stringContaining("AI provider error"),
        details: expect.objectContaining({
          agentType: "strategy",
          runId: 9001,
          userId: 18,
        }),
      })
    );
  });

  it("does not create an alert for semantic validation failures", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { createAlert } = await import("../alerts");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput({
        ctas: [
          { stage: "awareness", cta: "Learn More", placement: "ad headline" },
          { stage: "conversion", cta: "Sign Up", placement: "landing page" },
        ],
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    } as any);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toBeInstanceOf(TRPCError);

    expect(createAlert).not.toHaveBeenCalled();
  });

  it("does not hide the original generation error when alert creation fails", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { createAlert } = await import("../alerts");
    vi.mocked(createAlert).mockRejectedValueOnce(new Error("alert db down"));

    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("OpenAI API error"));

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("OpenAI API error");
  });

  it("does not leak sensitive provider values into the alert", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { createAlert } = await import("../alerts");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    const providerError = new Error("OpenAI API error") as any;
    providerError.response = {
      data: {
        error: {
          message: "bad request",
          code: "api_key_invalid",
          apiKey: "sk-SECRET123",
        },
      },
    };
    vi.mocked(generateObject).mockRejectedValueOnce(providerError);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    await expect(
      runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      })
    ).rejects.toThrow("OpenAI API error");

    const alertCall = vi.mocked(createAlert).mock.calls[0]?.[0];
    expect(alertCall).toBeDefined();
    const detailsJson = JSON.stringify(alertCall.details);
    expect(detailsJson).not.toContain("sk-SECRET123");
    expect(detailsJson).not.toContain("apiKey");
    expect(detailsJson).not.toContain("response");
    expect(alertCall.message).not.toContain("sk-SECRET123");
  });
});
