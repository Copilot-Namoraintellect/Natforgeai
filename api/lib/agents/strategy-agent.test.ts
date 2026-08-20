import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { generateObject } from "ai";
import { agentRuns, creativeGenerationClaims } from "@db/schema";
import {
  validateStrategyOutput,
  StrategyOutput,
  chargeForStrategyRun,
  runStrategyAgent,
  groundProductDefiningFields,
  materialiseGroundedFields,
  validateGroundedStrategyOutput,
  validateStrategyOutputAgainstCampaign,
  isSuccessfulStrategyOutput,
  type ValidationDiagnostic,
} from "./strategy-agent";
import { buildGroundingContract, type GroundedCreativeBrief } from "../creative/brief-grounding";

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("ai", () => {
  class MockNoObjectGeneratedError extends Error {
    static isInstance(error: unknown): error is MockNoObjectGeneratedError {
      return error instanceof MockNoObjectGeneratedError;
    }
  }

  class MockTypeValidationError extends Error {
    static isInstance(error: unknown): error is MockTypeValidationError {
      return error instanceof MockTypeValidationError;
    }
  }

  return {
    generateObject: vi.fn(),
    NoObjectGeneratedError: MockNoObjectGeneratedError,
    TypeValidationError: MockTypeValidationError,
  };
});

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

vi.mock("../creative/brief-grounding", async () => {
  const actual = await vi.importActual("../creative/brief-grounding");
  return {
    ...(actual as any),
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
  };
});

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

function buildRun248Output(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
  return {
    personas: [
      {
        name: "Finance Lead Farouk",
        demographics: "Finance lead for B2B finance teams and merchant operators",
        painPoints: ["Manual balance verification and slow payment instructions"],
        goals: ["Automate prefunding and transaction reservations"],
        platforms: ["LinkedIn", "Email"],
      },
    ],
    positioning:
      "The smart payment platform for merchant operations that want faster money movement.",
    valueProposition: "One platform that handles prefunded accounts and transaction reservations.",
    coreMessage:
      "Stop juggling manual account tasks. Get prefunded merchant accounts and transaction reservations in one place.",
    campaignTheme: "Smarter merchant payments",
    platformStrategy: [
      {
        platform: "LinkedIn",
        purpose: "Reach B2B finance teams and merchant operators",
        contentTypes: ["sponsored posts"],
        postingFrequency: "3x per week",
      },
    ],
    funnelStages: [
      {
        stage: "awareness",
        goal: "Reach B2B finance teams",
        tactics: ["Offer free consultations to finance leaders"],
        metrics: ["impressions"],
      },
      {
        stage: "conversion",
        goal: "Book qualified demos",
        tactics: ["Use the preferred CTA"],
        metrics: ["demo bookings"],
      },
    ],
    offers: [],
    ctas: [
      { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
      { stage: "conversion", cta: "Request a Free Consultation", placement: "landing page" },
    ],
    budgetRecommendation: {
      total: 5000,
      allocation: [{ channel: "LinkedIn", amount: 5000, percentage: 100 }],
    },
    ...overrides,
  };
}

describe("validateStrategyOutput", () => {
  const currentFingerprint = "fp-current";
  const baseBrief: GroundedCreativeBrief = {
    fingerprint: "fp-current",
    productOrService: "payout platform for restaurants",
    targetBuyer: "restaurant owners",
    mainPainPoint: "Slow end-of-day cash-outs",
    preferredCta: "Book a Demo",
    primaryOutcome: "Increase restaurant sign-ups",
    offerDetails: "",
    excludedOffers: "payroll; employee payouts; credit access; mass disbursements",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
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

  it("matches singular and plural forms of capability terms", () => {
    const briefPlural = {
      ...baseBrief,
      productOrService: "payout platform for restaurant owners",
    };
    const outputSingular = buildOutput({
      coreMessage: "A payout platform for restaurant owner.",
      positioning: "A payout platform for restaurant owner.",
      valueProposition: "A payout platform for restaurant owner.",
    });
    const result = validateStrategyOutput({
      output: { ...outputSingular, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefPlural,
    });
    expect(result.valid).toBe(true);
  });

  it("matches manager and managers without over-stemming to unrelated words", () => {
    const briefManagers = {
      ...baseBrief,
      targetBuyer: "restaurant managers",
      productOrService: "payout platform for restaurants",
    };
    const output = buildOutput({
      personas: [
        {
          name: "Restaurant Manager Maria",
          demographics: "Restaurant manager in South Africa",
          painPoints: ["Slow end-of-day cash-outs"],
          goals: ["Get paid faster"],
          platforms: ["Facebook"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefManagers,
    });
    expect(result.valid).toBe(true);
  });

  it("matches past-participle forms when the brief uses them", () => {
    const briefControlled = {
      ...baseBrief,
      productOrService: "controlled payment instructions",
    };
    const output = buildOutput({
      coreMessage: "Controlled payment instructions for restaurants.",
      positioning: "Controlled payment instructions for restaurants.",
      valueProposition: "Controlled payment instructions for restaurants.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefControlled,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts bounded verb-to-noun equivalence for verify/verification", () => {
    // Phase 2B requires the bounded equivalence group verify/verifies/verified/verifying/verification.
    const briefVerification = {
      ...baseBrief,
      productOrService: "balance verification platform",
    };
    const output = buildOutput({
      coreMessage: "A platform that lets restaurants verify balances.",
      positioning: "A platform that lets restaurants verify balances.",
      valueProposition: "A platform that lets restaurants verify balances.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefVerification,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts bounded verb-to-noun equivalence for administer/administration", () => {
    // Phase 2B requires the bounded equivalence group administer/administration forms.
    const briefAdministration = {
      ...baseBrief,
      productOrService: "merchant-account administration",
    };
    const output = buildOutput({
      coreMessage: "We administer merchant accounts for restaurants.",
      positioning: "We administer merchant accounts for restaurants.",
      valueProposition: "We administer merchant accounts for restaurants.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefAdministration,
    });
    expect(result.valid).toBe(true);
  });
});

describe("run 247 regression — B2B payment orchestration grounding", () => {
  const run247Brief = {
    productOrService:
      "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    targetBuyer: "B2B finance teams and merchant operators",
    mainPainPoint: "manual balance verification and slow payment instructions",
    preferredCta: "Book a Demo",
    primaryOutcome: "Qualified merchant onboarding",
    offerDetails: "",
    excludedOffers:
      "fraud reduction; multiple payment methods; lending; credit; loans; free trial; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme",
  };

  const currentFingerprint = "fp-run247";

  function buildRun247Output(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
      personas: [
        {
          name: "Operations Manager Olivia",
          demographics: "Operations manager at a small business",
          painPoints: ["Wasting hours on manual payment reconciliation"],
          goals: ["Automate payouts and reduce errors"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      positioning: "The smart payment platform built for small businesses that want to move money faster.",
      valueProposition:
        "One platform that simplifies payments, reduces fraud and scales with your business.",
      coreMessage:
        "Stop juggling payment methods. Get a single platform that handles payouts, fraud reduction and financial innovation for your small business.",
      campaignTheme: "Smarter payouts for small businesses",
      platformStrategy: [
        {
          platform: "LinkedIn",
          purpose: "Reach small business decision makers",
          contentTypes: ["sponsored posts"],
          postingFrequency: "3x per week",
        },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach small businesses",
          tactics: ["Share thought leadership on payment innovation"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Drive signups",
          tactics: ["Offer free trial in CTA"],
          metrics: ["conversions"],
        },
      ],
      offers: [],
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad headline" },
        { stage: "conversion", cta: "Start your free trial today", placement: "landing page" },
      ],
      budgetRecommendation: {
        total: 5000,
        allocation: [{ channel: "LinkedIn", amount: 5000, percentage: 100 }],
      },
      ...overrides,
    };
  }

  function buildGroundedCompoundOutput(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead for B2B finance teams and merchant operators",
          painPoints: ["Manual balance verification and slow payment instructions"],
          goals: ["Control payment instructions with prefunded accounts"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      positioning:
        "B2B payment orchestration built around prefunded merchant accounts, balance verification, transaction reservations and controlled payment instructions.",
      valueProposition:
        "Verify balances, reserve transactions and issue controlled payment instructions from a single prefunded merchant-account environment.",
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      campaignTheme: "Controlled B2B payment orchestration for merchant operators",
      platformStrategy: [
        {
          platform: "LinkedIn",
          purpose: "Reach B2B finance teams and merchant operators",
          contentTypes: ["sponsored posts", "whitepaper downloads"],
          postingFrequency: "3x per week",
        },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
      offers: [],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      budgetRecommendation: {
        total: 5000,
        allocation: [{ channel: "LinkedIn", amount: 5000, percentage: 100 }],
      },
      ...overrides,
    };
  }

  it("rejects the sanitised run-247 output", () => {
    const result = validateStrategyOutput({
      output: { ...buildRun247Output(), creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects run-247-style output even when b2b, prefunded and merchant are present", () => {
    const output = buildRun247Output({
      coreMessage:
        "B2B prefunded merchant payment platform.",
      positioning: "B2B prefunded merchant platform.",
      valueProposition: "B2B prefunded merchant platform.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing core capabilities/i);
  });

  it("accepts a fully grounded compound capability description", () => {
    const result = validateStrategyOutput({
      output: { ...buildGroundedCompoundOutput(), creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts equivalent wording that preserves the material capabilities", () => {
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "Reservation management for transactions, balance verification, instruction controls and prefunded merchant-account administration in one B2B payment orchestration environment.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a generic small-business payment-platform description", () => {
    const output = buildGroundedCompoundOutput({
      coreMessage: "Payment platform for small businesses that want faster payouts.",
      positioning: "Payment platform for small businesses.",
      valueProposition: "Payment platform for small businesses.",
      campaignTheme: "Faster payouts for small businesses",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing core capabilities/i);
  });

  it("fails when prefunded merchant-account administration is omitted", () => {
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration with balance verification, transaction reservations and controlled payment-instruction services.",
      positioning:
        "B2B payment orchestration with balance verification, transaction reservations and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration with balance verification, transaction reservations and controlled payment-instruction services.",
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead at a B2B merchant operation",
          painPoints: ["Manual balance verification and slow payment instructions"],
          goals: ["Control payment instructions and verify balances"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain balance verification and controlled payment instructions"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/prefunded|merchant|account|administration/i);
  });

  it("fails when transaction reservations are omitted", () => {
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
      positioning:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/transaction|reservations|controlled|instruction/i);
  });

  it("rejects unsupported fraud, credit and lending claims", () => {
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services with fraud reduction, credit lines and lending options for merchant operators.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/excluded|unauthorised/i);
  });

  it("rejects a free trial hidden in ctas when offers is empty", () => {
    const briefWithoutExcludedOffers = { ...run247Brief, excludedOffers: "" };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Start your free trial today", placement: "landing page" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutExcludedOffers,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free trial/i);
  });

  it("allows an authorised offer that appears in ctas", () => {
    const briefWithOffer = {
      ...run247Brief,
      offerDetails: "Start your free trial today",
      excludedOffers:
        "fraud reduction; multiple payment methods; lending; credit; loans; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme",
    };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Start your free trial today", placement: "landing page" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithOffer,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an excluded offer regardless of whether it appears in offers, ctas or another user-facing field", () => {
    const output = buildGroundedCompoundOutput({
      offers: [],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Run a webinar on payment orchestration"],
          metrics: ["registrations"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/webinar/i);
  });

  it("rejects a free trial when offerDetails explicitly negates it", () => {
    const briefWithNegation = { ...run247Brief, offerDetails: "No free trial" };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Start your free trial today", placement: "landing page" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithNegation,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free trial/i);
  });

  it("rejects a free trial when it is listed in excludedOffers", () => {
    const briefWithExcluded = { ...run247Brief, offerDetails: "" };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Start your free trial today", placement: "landing page" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithExcluded,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free trial/i);
  });

  it("does not let an authorised discount automatically authorise other incentives", () => {
    const briefWithDiscount = {
      ...run247Brief,
      offerDetails: "10% discount",
      excludedOffers: "",
    };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Enter our giveaway to win a bonus", placement: "landing page" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithDiscount,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/giveaway|bonus/i);
  });

  it("rejects an offer term hidden in CTA placement", () => {
    const briefWithoutOffer = { ...run247Brief, offerDetails: "" };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "free trial banner" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutOffer,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free trial/i);
  });

  it("rejects an offer term hidden in funnel tactics", () => {
    const briefWithoutOffer = { ...run247Brief, offerDetails: "" };
    const output = buildGroundedCompoundOutput({
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Offer a free trial to new merchants"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutOffer,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free trial/i);
  });

  it("allows ordinary informational CTAs when no offer is provided", () => {
    const briefWithoutOffer = { ...run247Brief, offerDetails: "" };
    const output = buildGroundedCompoundOutput({
      ctas: [
        { stage: "awareness", cta: "Learn More", placement: "ad headline" },
        { stage: "consideration", cta: "Request Information", placement: "landing page" },
        { stage: "conversion", cta: "Book a Demo", placement: "footer" },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutOffer,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an unsupported fraud-prevention claim", () => {
    const briefWithoutFraud = {
      ...run247Brief,
      excludedOffers: "multiple payment methods; lending; credit; loans",
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services with fraud prevention for merchant operators.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutFraud,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported product claim/i);
  });

  it("allows fraud prevention when the brief explicitly authorises it", () => {
    const briefWithFraud = {
      ...run247Brief,
      productOrService: `${run247Brief.productOrService} with fraud prevention`,
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations, controlled payment-instruction services and fraud prevention.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithFraud,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects unsupported credit and lending claims", () => {
    const briefWithoutCredit = {
      ...run247Brief,
      excludedOffers: "fraud reduction; multiple payment methods",
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services with credit lines and lending options for merchant operators.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutCredit,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported product claim/i);
  });

  it("allows credit and lending when the brief explicitly authorises them", () => {
    const briefWithCredit = {
      ...run247Brief,
      productOrService: `${run247Brief.productOrService} with credit and lending facilities`,
      excludedOffers:
        "fraud reduction; multiple payment methods; free trial; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme",
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration with credit and lending facilities, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithCredit,
    });
    expect(result.valid).toBe(true);
  });

  it("does not reject a persona pain point about credit as an unsupported product claim", () => {
    // Describing a buyer problem ("needs access to credit") in a persona field
    // must not be treated as the product offering credit.
    const briefWithoutCredit = {
      ...run247Brief,
      excludedOffers: "fraud reduction; multiple payment methods; lending; loans",
    };
    const output = buildGroundedCompoundOutput({
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead for B2B finance teams and merchant operators",
          painPoints: [
            "Manual balance verification and slow payment instructions; also needs access to credit for working capital",
          ],
          goals: ["Control payment instructions with prefunded accounts"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutCredit,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an affirmative product claim about credit when unauthorised", () => {
    const briefWithoutCredit = {
      ...run247Brief,
      excludedOffers: "fraud reduction; multiple payment methods; lending; loans",
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services. We provide business credit to qualified merchants.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutCredit,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported product claim/i);
  });

  it("allows an affirmative credit claim when the brief explicitly authorises credit", () => {
    const briefWithCredit = {
      ...run247Brief,
      productOrService: `${run247Brief.productOrService} with credit facilities`,
      excludedOffers:
        "fraud reduction; multiple payment methods; lending; loans; free trial; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme",
    };
    const output = buildGroundedCompoundOutput({
      coreMessage:
        "B2B payment orchestration with credit facilities, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithCredit,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a funnel tactic that actively markets an unauthorised loan product", () => {
    const briefWithoutLending = {
      ...run247Brief,
      excludedOffers: "fraud reduction; multiple payment methods; credit",
    };
    const output = buildGroundedCompoundOutput({
      funnelStages: [
        {
          stage: "conversion",
          goal: "Convert merchants",
          tactics: ["Offer instant business loans at signup"],
          metrics: ["loan applications"],
        },
        {
          stage: "retention",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutLending,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported product claim|loan|lending/i);
  });

  it("does not reject educational content about credit challenges as a product claim", () => {
    const briefWithoutCredit = {
      ...run247Brief,
      excludedOffers: "fraud reduction; multiple payment methods; lending; loans",
    };
    const output = buildGroundedCompoundOutput({
      funnelStages: [
        {
          stage: "awareness",
          goal: "Educate finance teams",
          tactics: ["Publish a guide on managing credit risk in B2B payments"],
          metrics: ["downloads"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithoutCredit,
    });
    expect(result.valid).toBe(true);
  });

  it("does not call the model during deterministic validation", () => {
    vi.clearAllMocks();
    validateStrategyOutput({
      output: { ...buildRun247Output(), creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run247Brief,
    });
    expect(generateObject).not.toHaveBeenCalled();
  });
});

describe("run 248 regression — field-scoped product grounding and consultation offers", () => {
  const run248Brief = {
    productOrService:
      "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
    targetBuyer: "B2B finance teams and merchant operators",
    mainPainPoint: "manual balance verification and slow payment instructions",
    preferredCta: "Book a Demo",
    primaryOutcome: "Qualified merchant onboarding",
    offerDetails: "",
    excludedOffers:
      "fraud reduction; multiple payment methods; lending; credit; loans; free trial; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme; free consultation; free assessment; free audit; free demo; complimentary consultation; no-cost consultation",
  };

  const currentFingerprint = "fp-run248";

  it("rejects the sanitised run-248 output", () => {
    const result = validateStrategyOutput({
      output: { ...buildRun248Output(), creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
  });

  it("fails when B2B is missing from product-defining fields", () => {
    const output = buildRun248Output({
      coreMessage:
        "Payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      positioning:
        "Payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      valueProposition:
        "Payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/product\/service/i);
  });

  it("fails when balance verification is missing from product-defining fields", () => {
    const output = buildRun248Output({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, transaction reservations and controlled payment-instruction services.",
      positioning:
        "B2B payment orchestration, prefunded merchant-account administration, transaction reservations and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration, prefunded merchant-account administration, transaction reservations and controlled payment-instruction services.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/balance|verification/i);
  });

  it("fails when controlled payment instructions are missing from product-defining fields", () => {
    const output = buildRun248Output({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and transaction reservations.",
      positioning:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and transaction reservations.",
      valueProposition:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and transaction reservations.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/controlled|instruction/i);
  });

  it("does not let prefunding mentioned only as a persona pain point satisfy product coverage", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead for B2B finance teams and merchant operators",
          painPoints: ["Manual prefunded account reconciliation"],
          goals: ["Automate transaction reservations"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain payment orchestration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/product\/service/i);
  });

  it("does not let transaction reservations mentioned only as a persona goal satisfy product coverage", () => {
    const output = buildRun248Output({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
      positioning:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification and controlled payment-instruction services.",
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead for B2B finance teams and merchant operators",
          painPoints: ["Manual balance verification"],
          goals: ["Automate transaction reservations"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain payment orchestration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: run248Brief,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/transaction|reservations/i);
  });

  it("rejects a free consultation in a CTA when no offer is authorised", () => {
    const output = buildRun248Output({
      coreMessage: run248Brief.productOrService,
      positioning: run248Brief.productOrService,
      valueProposition: run248Brief.productOrService,
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Request a Free Consultation", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...run248Brief, excludedOffers: "" },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free consultation/i);
  });

  it("rejects a free consultation in funnel tactics when no offer is authorised", () => {
    const output = buildRun248Output({
      coreMessage: run248Brief.productOrService,
      positioning: run248Brief.productOrService,
      valueProposition: run248Brief.productOrService,
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Offer free consultations to finance leaders"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...run248Brief, excludedOffers: "" },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/free consultation/i);
  });

  it("allows an explicitly authorised free consultation", () => {
    const briefWithConsultation = {
      ...run248Brief,
      offerDetails: "Free consultation for B2B finance teams",
      excludedOffers:
        "fraud reduction; multiple payment methods; lending; credit; loans; free trial; discount; coupon; giveaway; bonus; promotional credit; webinar; newsletter; loyalty programme; free assessment; free audit; free demo; complimentary consultation; no-cost consultation",
    };
    const output = buildRun248Output({
      coreMessage: run248Brief.productOrService,
      positioning: run248Brief.productOrService,
      valueProposition: run248Brief.productOrService,
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Request a Free Consultation", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Offer free consultations to finance leaders"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: briefWithConsultation,
    });
    expect(result.valid).toBe(true);
  });

  it("allows Request a Consultation without the word free", () => {
    const output = buildRun248Output({
      coreMessage: run248Brief.productOrService,
      positioning: run248Brief.productOrService,
      valueProposition: run248Brief.productOrService,
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Request a Consultation", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...run248Brief, excludedOffers: "" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a no-cost assessment hidden in CTA placement", () => {
    const output = buildRun248Output({
      coreMessage: run248Brief.productOrService,
      positioning: run248Brief.productOrService,
      valueProposition: run248Brief.productOrService,
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "no-cost assessment banner" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const result = validateStrategyOutput({
      output: { ...output, creativeBriefFingerprint: currentFingerprint },
      currentFingerprint,
      brief: { ...run248Brief, excludedOffers: "" },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no-cost assessment/i);
  });
});

describe("groundProductDefiningFields deterministic grounding", () => {
  const groundingBrief = {
    productOrService:
      "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
  };

  it("replaces a drifted core message with the brief's product/service text", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const grounded = groundProductDefiningFields(output, groundingBrief);
    expect(grounded.coreMessage).toBe(groundingBrief.productOrService);
  });

  it("does not alter output that already covers the brief", () => {
    const output = buildRun248Output({
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      positioning:
        "B2B payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const grounded = groundProductDefiningFields(output, groundingBrief);
    expect(grounded.coreMessage).toBe(output.coreMessage);
  });

  it("does nothing when the brief has no product or service", () => {
    const output = buildRun248Output();
    const grounded = groundProductDefiningFields(output, { productOrService: "" });
    expect(grounded.coreMessage).toBe(output.coreMessage);
  });

  it("grounds a drifted output so product capability validation passes", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const grounded = groundProductDefiningFields(output, groundingBrief);
    const result = validateStrategyOutput({
      output: { ...grounded, creativeBriefFingerprint: "fp-grounded" },
      currentFingerprint: "fp-grounded",
      brief: {
        ...groundingBrief,
        targetBuyer: "B2B finance teams and merchant operators",
        mainPainPoint: "manual balance verification and slow payment instructions",
        preferredCta: "Book a Demo",
        offerDetails: "",
        excludedOffers: "",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("does not invent capabilities absent from the brief", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain payment orchestration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
    });
    const emptyBrief = { productOrService: "" };
    const grounded = groundProductDefiningFields(output, emptyBrief);
    expect(grounded.coreMessage).toBe(output.coreMessage);
  });

  it("works with a short service description", () => {
    const output = buildRun248Output({
      coreMessage: "We help businesses.",
      positioning: "We help businesses.",
      valueProposition: "We help businesses.",
    });
    const brief = { productOrService: "Restaurant payout platform" };
    const grounded = groundProductDefiningFields(output, brief);
    expect(grounded.coreMessage).toBe("Restaurant payout platform.");
  });

  it("does not duplicate trailing punctuation", () => {
    const output = buildRun248Output({
      coreMessage: "We help businesses",
      positioning: "We help businesses",
      valueProposition: "We help businesses",
    });
    const brief = { productOrService: "Restaurant payout platform." };
    const grounded = groundProductDefiningFields(output, brief);
    expect(grounded.coreMessage).toBe("Restaurant payout platform.");
    expect(grounded.coreMessage).not.toMatch(/\.\./);
  });

  it("returns a new object and does not mutate the original", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
    });
    const originalCoreMessage = output.coreMessage;
    const grounded = groundProductDefiningFields(output, groundingBrief);
    expect(grounded).not.toBe(output);
    expect(output.coreMessage).toBe(originalCoreMessage);
  });

  it("does not change unrelated strategy fields", () => {
    const output = buildRun248Output({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
    });
    const grounded = groundProductDefiningFields(output, groundingBrief);
    expect(grounded.positioning).toBe(output.positioning);
    expect(grounded.valueProposition).toBe(output.valueProposition);
    expect(grounded.campaignTheme).toBe(output.campaignTheme);
    expect(grounded.personas).toEqual(output.personas);
    expect(grounded.funnelStages).toEqual(output.funnelStages);
    expect(grounded.ctas).toEqual(output.ctas);
    expect(grounded.offers).toEqual(output.offers);
    expect(grounded.platformStrategy).toEqual(output.platformStrategy);
    expect(grounded.budgetRecommendation).toEqual(output.budgetRecommendation);
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
    const updateSets: any[] = [];

    function makeUpdateMock() {
      return vi.fn(() => ({
        set: vi.fn((setValue: any) => {
          updateSets.push(setValue);
          return {
            where: vi.fn(async () => [{ affectedRows: 1 }] as any),
          };
        }),
      }));
    }

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
        update: makeUpdateMock(),
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
      update: makeUpdateMock(),
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

    return { db, tx, get transactionCommitted() { return transactionCommitted; }, updateSets };
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

    // Generate output that fails semantic validation because it contains an excluded offer.
    const { buildGroundedCreativeBrief } = await import("../creative/brief-grounding");
    vi.mocked(buildGroundedCreativeBrief).mockReturnValueOnce({
      fingerprint: "fp-current",
      productOrService: "payout platform for restaurants",
      targetBuyer: "restaurant owners",
      mainPainPoint: "slow end-of-day cash-outs",
      preferredCta: "Book a Demo",
      primaryOutcome: "outcome",
      targetAudience: "audience",
      coreMessage: "message",
      offerDetails: "",
      excludedOffers: "free trial",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
    });
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput({
        funnelStages: [
          {
            stage: "awareness",
            goal: "Reach restaurant owners",
            tactics: ["Start a free trial campaign"],
            metrics: ["impressions"],
          },
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

    // Generate output that fails semantic validation because it contains an excluded offer.
    const { buildGroundedCreativeBrief } = await import("../creative/brief-grounding");
    vi.mocked(buildGroundedCreativeBrief).mockReturnValueOnce({
      fingerprint: "fp-current",
      productOrService: "payout platform for restaurants",
      targetBuyer: "restaurant owners",
      mainPainPoint: "slow end-of-day cash-outs",
      preferredCta: "Book a Demo",
      primaryOutcome: "outcome",
      targetAudience: "audience",
      coreMessage: "message",
      offerDetails: "",
      excludedOffers: "free trial",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
    });
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput({
        funnelStages: [
          {
            stage: "awareness",
            goal: "Reach restaurant owners",
            tactics: ["Start a free trial campaign"],
            metrics: ["impressions"],
          },
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

  it("persists the same grounded strategy to agentRuns, the returned result and the campaign", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const { campaigns: campaignsTable } = await import("@db/schema");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    // Generate output that would drift from the brief without grounding.
    const rawOutput = buildOutput({
      coreMessage: "A payment platform for finance teams.",
      positioning: "A payment platform for finance teams.",
      valueProposition: "A payment platform for finance teams.",
      personas: [
        {
          name: "Finance Lead Farouk",
          demographics: "Finance lead for B2B finance teams and merchant operators",
          painPoints: ["Manual balance verification and slow payment instructions"],
          goals: ["Control payment instructions with prefunded accounts"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
    });
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: rawOutput,
      usage: { promptTokens: 100, completionTokens: 50 },
    } as any);

    const onRunCreated = vi.fn(async (runId: number, tx: any) => {
      await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
    });

    const { buildGroundedCreativeBrief } = await import("../creative/brief-grounding");
    vi.mocked(buildGroundedCreativeBrief).mockReturnValueOnce({
      fingerprint: "fp-b2b-grounding",
      productOrService:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services",
      targetBuyer: "B2B finance teams and merchant operators",
      mainPainPoint: "manual balance verification and slow payment instructions",
      preferredCta: "Book a Demo",
      primaryOutcome: "Qualified merchant onboarding",
      targetAudience: "B2B finance teams and merchant operators",
      coreMessage: "B2B payment orchestration",
      offerDetails: "",
      excludedOffers: "",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
    });

    const result = await runStrategyAgent({
      userId: 18,
      campaignId: 42,
      business: {
        ...baseBusiness,
        productOrService:
          "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services",
      },
      campaignBrief: {
        productOrService:
          "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services",
        targetBuyer: "B2B finance teams and merchant operators",
        mainPainPoint: "manual balance verification and slow payment instructions",
        preferredCta: "Book a Demo",
      },
      onRunCreated,
    });

    // The returned output is grounded, not the raw generated output.
    expect(result.output.coreMessage).toBe(
      "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations, controlled payment-instruction services."
    );
    expect(result.output.coreMessage).not.toBe(rawOutput.coreMessage);

    // The completed agentRuns update used the same grounded output with fingerprint.
    const completedUpdate = mock.updateSets.find(
      (set: any) => set.status === "completed" && set.output?.creativeBriefFingerprint
    );
    expect(completedUpdate).toBeDefined();
    expect(completedUpdate.output.coreMessage).toBe(result.output.coreMessage);
    expect(completedUpdate.output.creativeBriefFingerprint).toBeDefined();

    // The campaign update used the same grounded core message.
    const campaignUpdate = mock.updateSets.find(
      (set: any) => set.workflowContext?.strategyRunId === 9001
    );
    expect(campaignUpdate).toBeDefined();
    expect(campaignUpdate.workflowContext.coreMessage).toBe(result.output.coreMessage);
  });

  it("never marks the run completed before semantic validation passes", async () => {
    const { getDb } = await import("../../queries/connection");
    const { agentRuns } = await import("@db/schema");
    const mock = createMockDb();
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    // Generate output that fails semantic validation because it contains an excluded offer.
    const { buildGroundedCreativeBrief } = await import("../creative/brief-grounding");
    vi.mocked(buildGroundedCreativeBrief).mockReturnValueOnce({
      fingerprint: "fp-current",
      productOrService: "payout platform for restaurants",
      targetBuyer: "restaurant owners",
      mainPainPoint: "slow end-of-day cash-outs",
      preferredCta: "Book a Demo",
      primaryOutcome: "outcome",
      targetAudience: "audience",
      coreMessage: "message",
      offerDetails: "",
      excludedOffers: "free trial",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
    });
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: buildOutput({
        funnelStages: [
          {
            stage: "awareness",
            goal: "Reach restaurant owners",
            tactics: ["Start a free trial campaign"],
            metrics: ["impressions"],
          },
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

    const completedUpdate = mock.updateSets.find((set: any) => set.status === "completed");
    expect(completedUpdate).toBeUndefined();

    const failedUpdate = mock.updateSets.find((set: any) => set.status === "failed");
    expect(failedUpdate).toBeDefined();
  });
});


describe("Phase 2B evidence reconciliation", () => {
  const currentFingerprint = "fp-phase2b";

  function buildPhase2Brief(overrides: Partial<GroundedCreativeBrief> = {}): GroundedCreativeBrief {
    return {
      fingerprint: currentFingerprint,
      productOrService:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services",
      targetBuyer: "B2B finance teams and merchant operators",
      mainPainPoint: "manual balance verification and slow payment instructions",
      preferredCta: "Book a Demo",
      primaryOutcome: "Qualified merchant onboarding",
      targetAudience: "B2B finance teams and merchant operators",
      coreMessage: "B2B payment orchestration",
      offerDetails: "",
      excludedOffers: "",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
      ...overrides,
    };
  }

  function withFingerprint(output: StrategyOutput): StrategyOutput & { creativeBriefFingerprint: string } {
    return { ...output, creativeBriefFingerprint: currentFingerprint };
  }

  function buildPhase2Output(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
      personas: [
        {
          name: "B2B finance teams and merchant operators",
          demographics: "B2B finance teams and merchant operators",
          painPoints: ["manual balance verification and slow payment instructions"],
          goals: ["Automate payment operations"],
          platforms: ["LinkedIn", "Email"],
        },
      ],
      positioning:
        "B2B payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      valueProposition:
        "B2B payment orchestration with prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      coreMessage:
        "B2B payment orchestration, prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      campaignTheme: "Smarter merchant payments",
      platformStrategy: [
        {
          platform: "LinkedIn",
          purpose: "Reach B2B finance teams and merchant operators",
          contentTypes: ["sponsored posts"],
          postingFrequency: "3x per week",
        },
      ],
      funnelStages: [
        {
          stage: "awareness",
          goal: "Reach B2B finance teams",
          tactics: ["Explain prefunded merchant-account administration"],
          metrics: ["impressions"],
        },
        {
          stage: "conversion",
          goal: "Book qualified demos",
          tactics: ["Use the preferred CTA"],
          metrics: ["demo bookings"],
        },
      ],
      offers: [],
      ctas: [
        { stage: "awareness", cta: "Book a Demo", placement: "ad headline" },
        { stage: "conversion", cta: "Book a Demo", placement: "landing page" },
      ],
      budgetRecommendation: {
        total: 5000,
        allocation: [{ channel: "LinkedIn", amount: 5000, percentage: 100 }],
      },
      ...overrides,
    };
  }

  describe("isSuccessfulStrategyOutput discriminator", () => {
    it("accepts a flat completed strategy output with a fingerprint", () => {
      expect(isSuccessfulStrategyOutput(withFingerprint(buildOutput()))).toBe(true);
    });

    it("rejects a generated_candidate envelope", () => {
      expect(
        isSuccessfulStrategyOutput({
          evidenceVersion: 1,
          outcome: "generated_candidate",
          creativeBriefFingerprint: currentFingerprint,
          rawOutput: buildOutput(),
        })
      ).toBe(false);
    });

    it("rejects a failed_validation envelope", () => {
      expect(
        isSuccessfulStrategyOutput({
          evidenceVersion: 1,
          outcome: "failed_validation",
          creativeBriefFingerprint: currentFingerprint,
          rawOutput: buildOutput(),
          groundedOutput: buildOutput(),
          validationDiagnostics: [{ gate: "product/service" }] as ValidationDiagnostic[],
        })
      ).toBe(false);
    });

    it("rejects a failed_generation envelope", () => {
      expect(
        isSuccessfulStrategyOutput({
          evidenceVersion: 1,
          outcome: "failed_generation",
          creativeBriefFingerprint: currentFingerprint,
          validationDiagnostics: { gate: "generation", reason: "OpenAI error" },
        })
      ).toBe(false);
    });

    it("rejects an unknown-outcome envelope", () => {
      expect(
        isSuccessfulStrategyOutput({
          evidenceVersion: 1,
          outcome: "unknown",
          creativeBriefFingerprint: currentFingerprint,
        })
      ).toBe(false);
    });

    it("rejects any object that owns an outcome property, regardless of value or type", () => {
      const base = { creativeBriefFingerprint: currentFingerprint };
      expect(isSuccessfulStrategyOutput({ ...base, outcome: "failed_validation" })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, outcome: 1 })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, outcome: null })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, outcome: {} })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, outcome: undefined })).toBe(false);
    });

    it("rejects non-objects, null and arrays", () => {
      expect(isSuccessfulStrategyOutput(null)).toBe(false);
      expect(isSuccessfulStrategyOutput(undefined)).toBe(false);
      expect(isSuccessfulStrategyOutput("string")).toBe(false);
      expect(isSuccessfulStrategyOutput(123)).toBe(false);
      expect(isSuccessfulStrategyOutput([])).toBe(false);
      expect(isSuccessfulStrategyOutput([{ creativeBriefFingerprint: currentFingerprint }])).toBe(false);
    });

    it("rejects a flat output missing fingerprint or required fields", () => {
      expect(isSuccessfulStrategyOutput({ creativeBriefFingerprint: "" })).toBe(false);
      expect(isSuccessfulStrategyOutput({ creativeBriefFingerprint: currentFingerprint })).toBe(false);
      expect(
        isSuccessfulStrategyOutput({
          creativeBriefFingerprint: currentFingerprint,
          coreMessage: "x",
          positioning: "x",
          valueProposition: "x",
          campaignTheme: "x",
          personas: [],
          ctas: [{ stage: "a", cta: "b", placement: "c" }],
          offers: [],
          budgetRecommendation: {},
        })
      ).toBe(false);
    });

    it("rejects malformed personas, CTAs, offers and budget", () => {
      const base = withFingerprint(buildOutput());
      expect(isSuccessfulStrategyOutput({ ...base, personas: [] })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, personas: [{ name: "x" }] })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, ctas: [] })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, ctas: [{ cta: "x" }] })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, offers: null })).toBe(false);
      expect(isSuccessfulStrategyOutput({ ...base, budgetRecommendation: null })).toBe(false);
    });

    it("accepts a valid legacy flat successful output", () => {
      expect(isSuccessfulStrategyOutput(withFingerprint(buildOutput()))).toBe(true);
    });
  });

  describe("validateStrategyOutputAgainstCampaign envelope rejection", () => {
    const campaign = {
      productOrService: "payout platform for restaurants",
      targetBuyer: "restaurant owners",
      mainPainPoint: "slow end-of-day cash-outs",
      preferredCta: "Book a Demo",
      offerDetails: "",
      excludedOffers: "",
    };

    it("rejects a generated_candidate envelope even when the fingerprint matches", () => {
      const result = validateStrategyOutputAgainstCampaign(
        {
          evidenceVersion: 1,
          outcome: "generated_candidate",
          creativeBriefFingerprint: "fp-current",
          rawOutput: { ...buildOutput(), creativeBriefFingerprint: "fp-current" },
        },
        campaign
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/evidence envelope/i);
    });

    it("rejects a failed_validation envelope", () => {
      const result = validateStrategyOutputAgainstCampaign(
        {
          evidenceVersion: 1,
          outcome: "failed_validation",
          creativeBriefFingerprint: "fp-current",
          rawOutput: buildOutput(),
          groundedOutput: buildOutput(),
          validationDiagnostics: [{ gate: "main pain point" }] as ValidationDiagnostic[],
        },
        campaign
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/evidence envelope/i);
    });

    it("rejects a failed_generation envelope", () => {
      const result = validateStrategyOutputAgainstCampaign(
        {
          evidenceVersion: 1,
          outcome: "failed_generation",
          creativeBriefFingerprint: "fp-current",
          validationDiagnostics: { gate: "generation", reason: "OpenAI error" },
        },
        campaign
      );
      expect(result.valid).toBe(false);
    });

    it("accepts a valid flat completed output", () => {
      const result = validateStrategyOutputAgainstCampaign(
        { ...buildOutput(), creativeBriefFingerprint: "fp-current" },
        campaign
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("materialiseGroundedFields field ownership", () => {
    it("repairs only coreMessage when product clauses are missing", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        coreMessage: "A payment platform.",
        positioning: "A payment platform for finance teams.",
        valueProposition: "A payment platform for finance teams.",
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.coreMessage).toMatch(/B2B payment orchestration/i);
      expect(grounded.positioning).toBe(raw.positioning);
      expect(grounded.valueProposition).toBe(raw.valueProposition);
    });

    it("repairs the matching persona using name and demographics only", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        personas: [
          {
            name: "Finance Lead Farouk",
            demographics: "Finance lead for B2B finance teams and merchant operators",
            painPoints: ["Some pain"],
            goals: ["Automate payments"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.personas[0].name).toBe("Finance Lead Farouk");
      expect(grounded.personas[0].demographics).toBe(
        "Finance lead for B2B finance teams and merchant operators"
      );
      expect(grounded.personas[0].goals).toEqual(["Automate payments"]);
      expect(grounded.personas[0].platforms).toEqual(["LinkedIn"]);
    });

    it("replaces an unrelated persona name with a buyer-derived label", () => {
      const contract = buildGroundingContract(buildPhase2Brief({ excludedOffers: "free trial" }));
      const raw = buildOutput({
        personas: [
          {
            name: "Small Business Sam",
            demographics: "Small business owner",
            painPoints: ["Some unrelated pain"],
            goals: ["Sign up for a free trial"],
            platforms: ["Facebook"],
          },
        ],
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.personas[0].name).toBe("B2B Finance Teams And Merchant Operators");
      expect(grounded.personas[0].demographics).toBe("B2B finance teams and merchant operators");
      expect(grounded.personas[0].painPoints).toContain("manual balance verification and slow payment instructions");
      expect(grounded.personas[0].goals).toEqual([]);
      expect(grounded.personas[0].platforms).toEqual(["Facebook"]);
    });

    it("adds the main pain point only to the selected persona's painPoints", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["Existing pain"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.personas[0].painPoints).toContain("manual balance verification and slow payment instructions");
      expect(grounded.personas[0].goals).toEqual(["Goal"]);
    });

    it("is idempotent", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["Existing pain"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const once = materialiseGroundedFields(raw, contract);
      const twice = materialiseGroundedFields(once, contract);
      expect(twice).toEqual(once);
    });

    it("changes only CTA text and preserves stage/placement", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        ctas: [{ stage: "awareness", cta: "Learn More", placement: "ad headline" }],
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.ctas[0].cta).toBe("Book a Demo");
      expect(grounded.ctas[0].stage).toBe("awareness");
      expect(grounded.ctas[0].placement).toBe("ad headline");
    });

    it("forces offers to [] when no offer is authorised", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({
        offers: [{ name: "Extra", description: "d", targetStage: "a", value: "v" }],
      });
      const grounded = materialiseGroundedFields(raw, contract);
      expect(grounded.offers).toEqual([]);
    });

    it("does not mutate the raw output", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const raw = buildOutput({ coreMessage: "A payment platform." });
      const original = JSON.parse(JSON.stringify(raw));
      materialiseGroundedFields(raw, contract);
      expect(raw).toEqual(original);
    });
  });

  describe("validateGroundedStrategyOutput field ownership", () => {
    it("fails buyer grounding when the buyer is only in a persona goal", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const output = buildOutput({
        personas: [
          {
            name: "Person",
            demographics: "Generic person",
            painPoints: ["Pain"],
            goals: ["Help B2B finance teams and merchant operators"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.some((d) => d.gate === "target buyer")).toBe(true);
    });

    it("fails pain-point grounding when the pain point is only in campaignTheme", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const output = buildOutput({
        campaignTheme: "manual balance verification and slow payment instructions",
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["Some other pain"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.some((d) => d.gate === "main pain point")).toBe(true);
    });

    it("does not treat make or difficult as required capabilities", () => {
      const contract = buildGroundingContract(
        buildPhase2Brief({ mainPainPoint: "make it difficult to reserve funds" })
      );
      const output = buildPhase2Output({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["make it difficult to reserve funds for B2B payments"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(true);
    });

    it("accepts reserve/reservation morphology equivalence", () => {
      const contract = buildGroundingContract(
        buildPhase2Brief({
          mainPainPoint: "manual transaction reservations",
        })
      );
      const output = buildPhase2Output({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["We still reserve transactions manual"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(true);
    });

    it("rejects an unauthorised offer hidden in a user-facing field", () => {
      const contract = buildGroundingContract(buildPhase2Brief());
      const output = buildOutput({
        funnelStages: [
          {
            stage: "awareness",
            goal: "Reach buyers",
            tactics: ["Start a free trial"],
            metrics: ["impressions"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.some((d) => d.gate === "unauthorised incentive")).toBe(true);
    });
  });

  describe("run 249 regression — grammatical words and bounded equivalence", () => {
    const run249Brief = buildPhase2Brief({
      mainPainPoint: "make it difficult to reserve funds for controlled payment instructions",
    });

    it("does not fail because make or difficult are required capabilities", () => {
      const contract = buildGroundingContract(run249Brief);
      const output = buildPhase2Output({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: [
              "make it difficult to reserve funds for controlled payment instructions",
            ],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(true);
    });

    it("fails when the genuine capability reserve is missing after materialisation", () => {
      const contract = buildGroundingContract(run249Brief);
      const output = buildOutput({
        personas: [
          {
            name: "B2B finance teams and merchant operators",
            demographics: "B2B finance teams and merchant operators",
            painPoints: ["make it difficult to manage funds"],
            goals: ["Goal"],
            platforms: ["LinkedIn"],
          },
        ],
      });
      const result = validateGroundedStrategyOutput(withFingerprint(output), currentFingerprint, contract);
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.some((d) => d.gate === "main pain point")).toBe(true);
    });
  });

  describe("runStrategyAgent persistence ordering", () => {
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
      const updateSets: any[] = [];
      function makeUpdateMock() {
        return vi.fn(() => ({
          set: vi.fn((setValue: any) => {
            updateSets.push(setValue);
            return { where: vi.fn(async () => [{ affectedRows: 1 }] as any) };
          }),
        }));
      }
      const tx = {
        insert: vi.fn((table: any) => ({
          values: vi.fn(async () => {
            return [{ insertId }] as any;
          }),
        })),
        update: makeUpdateMock(),
      };
      const db = {
        transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => callback(tx)),
        update: makeUpdateMock(),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => []),
              orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
            })),
          })),
        })),
      };
      return { db, tx, updateSets };
    }

    it("persists a generated_candidate envelope before terminal status", async () => {
      const { getDb } = await import("../../queries/connection");
      const { agentRuns } = await import("@db/schema");
      const mock = createMockDb();
      vi.mocked(getDb).mockReturnValue(mock.db as any);
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: buildOutput(),
        usage: { promptTokens: 100, completionTokens: 50 },
      } as any);

      const onRunCreated = vi.fn(async (runId: number, tx: any) => {
        await tx.update(agentRuns).set({ operationReferenceId: runId }).where({});
      });

      await runStrategyAgent({
        userId: 18,
        campaignId: 42,
        business: baseBusiness,
        onRunCreated,
      });

      const candidateUpdate = mock.updateSets.find(
        (set: any) => set.output?.outcome === "generated_candidate"
      );
      expect(candidateUpdate).toBeDefined();
      expect(candidateUpdate.output.rawOutput).toBeDefined();
      expect(candidateUpdate.status).toBeUndefined();

      const completedUpdate = mock.updateSets.find((set: any) => set.status === "completed");
      expect(completedUpdate).toBeDefined();
    });

    it("persists raw and grounded output plus diagnostics on semantic failure", async () => {
      const { getDb } = await import("../../queries/connection");
      const { agentRuns } = await import("@db/schema");
      const { buildGroundedCreativeBrief } = await import("../creative/brief-grounding");
      vi.mocked(buildGroundedCreativeBrief).mockReturnValueOnce({
        fingerprint: "fp-current",
        productOrService: "payout platform for restaurants",
        targetBuyer: "restaurant owners",
        mainPainPoint: "slow end-of-day cash-outs",
        preferredCta: "Book a Demo",
        primaryOutcome: "outcome",
        targetAudience: "audience",
        coreMessage: "message",
        offerDetails: "",
        excludedOffers: "free trial",
        referenceStyle: "",
        contentStyle: "",
        businessType: "B2B",
      });

      const mock = createMockDb();
      vi.mocked(getDb).mockReturnValue(mock.db as any);
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: buildOutput({
          funnelStages: [
            {
              stage: "awareness",
              goal: "Reach restaurant owners",
              tactics: ["Start a free trial campaign"],
              metrics: ["impressions"],
            },
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

      const failedUpdate = mock.updateSets.find((set: any) => set.status === "failed");
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate.output.outcome).toBe("failed_validation");
      expect(failedUpdate.output.rawOutput).toBeDefined();
      expect(failedUpdate.output.groundedOutput).toBeDefined();
      expect(failedUpdate.output.validationDiagnostics).toBeDefined();
    });

    it("rejects when the final terminal update fails and does not report success", async () => {
      const { getDb } = await import("../../queries/connection");
      const { agentRuns } = await import("@db/schema");
      const { campaigns } = await import("@db/schema");
      const mock = createMockDb();

      // Force the first terminal update (status: completed) to throw.
      let updateCallCount = 0;
      mock.db.update = vi.fn((table: any) => {
        return {
          set: vi.fn((setValue: any) => {
            updateCallCount += 1;
            mock.updateSets.push(setValue);
            if (setValue.status === "completed") {
              return { where: vi.fn(async () => { throw new Error("terminal write failed"); }) };
            }
            return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
          }),
        };
      }) as any;

      vi.mocked(getDb).mockReturnValue(mock.db as any);
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: buildOutput(),
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
      ).rejects.toThrow("terminal write failed");

      // Candidate was persisted while running; terminal completed update was attempted.
      const candidateUpdate = mock.updateSets.find(
        (set: any) => set.output?.outcome === "generated_candidate"
      );
      expect(candidateUpdate).toBeDefined();

      // No successful terminal update was written and no campaign persistence occurred.
      const completedUpdate = mock.updateSets.find((set: any) => set.status === "completed");
      expect(completedUpdate).toBeDefined();
      const campaignUpdate = mock.updateSets.find((set: any) => set.table === campaigns);
      expect(campaignUpdate).toBeUndefined();
    });
  });
});
