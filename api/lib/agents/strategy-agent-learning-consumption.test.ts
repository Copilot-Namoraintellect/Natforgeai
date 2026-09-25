import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateObject } from "ai";
import { runStrategyAgent, type StrategyOutput } from "./strategy-agent";
import {
  LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "../learning/promotion/promotion-contract";
import { buildApprovedPromotionEnvelope } from "../learning/promotion/promotion-envelope";
import type { EvidenceItem, RecommendedAdjustment } from "../learning/contracts/learning-derivation";

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

vi.mock("../strategy/strategy-snapshot-materialization", () => ({
  materializeGovernedStrategySnapshot: vi.fn(async (input: any) => ({
    status: "inserted",
    snapshot: {
      snapshotId: `test-strategy-${input.strategyRunId}`,
      userId: input.userId,
      campaignId: input.campaignId,
      businessId: input.businessId,
      strategyRunId: input.strategyRunId,
      businessDnaSnapshotId: "test-bdna-snapshot",
      version: 1,
      creativeBriefFingerprint: input.creativeBriefFingerprint,
      strategyHashSha256: "0".repeat(64),
      snapshot: input.snapshot,
      capturedAt: new Date("2026-09-22T00:00:00.000Z"),
    },
  })),
}));

vi.mock("./openai", () => ({
  defaultModel: { modelId: "gpt-4o-mini" },
}));

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(async () => undefined),
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
      platforms: "Facebook, Instagram",
      businessType: "B2B",
      authorisedChannels: ["facebook", "instagram"],
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
        goals: ["Learn how the payout platform applies to their situation"],
        platforms: ["Facebook", "Instagram"],
      },
    ],
    positioning: "Same-day payouts for restaurants.",
    valueProposition: "Restaurants get their payouts the same day.",
    coreMessage: "A payout platform for restaurants that gets them their money the same day.",
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

const RECOMMENDATION: RecommendedAdjustment = {
  id: "rec_improve_hook_ctr",
  targetEngine: "creative",
  adjustmentType: "improve_hook_ctr",
  summary: "Strengthen hooks and primary creative to lift click-through.",
  rationale: "Weak click-through rate recorded in the evaluation window.",
  evidenceRefs: ["ao:1"],
  governance: { autoApply: false, requiresApproval: true },
};

const RECORD_EVIDENCE: EvidenceItem[] = [
  { kind: "observation", ref: "ao:1", note: "clicks=60 on instagram at 2026-05-02 (analytics row 9)" },
];

function makeSealedFixture(input: { campaignId: number; learningRecordId: number; approvalRequestId: number }) {
  const coordinates: LearningPromotionCoordinates = {
    learningRecordId: input.learningRecordId,
    campaignId: input.campaignId,
    evaluationVersion: "learning-v2",
    learningEngine: "learning-engine",
    learningEngineVersion: "learning-v2",
    learningInputDigest: `digest-${input.learningRecordId}`,
    recommendationId: RECOMMENDATION.id,
    targetEngine: RECOMMENDATION.targetEngine,
    adjustmentType: RECOMMENDATION.adjustmentType,
    summary: RECOMMENDATION.summary,
    rationale: RECOMMENDATION.rationale,
    evidenceRefs: [...RECOMMENDATION.evidenceRefs],
  };
  const proposalFingerprint = buildLearningPromotionProposalFingerprint(coordinates);
  const context = buildLearningPromotionContext({ coordinates, proposalFingerprint });
  const envelope = buildApprovedPromotionEnvelope({
    context,
    approvalRequestId: input.approvalRequestId,
    decidedAt: "2026-06-10T00:00:00.000Z",
    decidedByUserId: 18,
    recordEvidence: RECORD_EVIDENCE,
  });
  return {
    coordinates,
    proposalFingerprint,
    envelope,
    approvalRow: {
      id: input.approvalRequestId,
      userId: 18,
      campaignId: input.campaignId,
      approvalType: LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE,
      title: "Learning Promotion (creative): Strengthen hooks",
      description: null,
      aiRecommendation: null,
      riskLevel: "medium",
      status: "approved",
      approvedAt: new Date("2026-06-10T00:00:00.000Z"),
      rejectedAt: null,
      idempotencyKey: `lp:${proposalFingerprint}`,
      context,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    },
    learningRecordRow: {
      id: input.learningRecordId,
      userId: 18,
      campaignId: input.campaignId,
      evaluationVersion: "learning-v2",
      provenance: {
        engine: "learning-engine",
        engineVersion: "learning-v2",
        trigger: "api",
        inputDigest: `digest-${input.learningRecordId}`,
        evaluatedAt: "2026-06-01T00:00:00.000Z",
      },
      recommendedAdjustments: [RECOMMENDATION],
      evidence: RECORD_EVIDENCE,
      status: "recorded",
    },
    auditRow: {
      id: 9000 + input.approvalRequestId,
      approvalRequestId: input.approvalRequestId,
      eventType: "learning_promotion_resolved",
      occurredAt: "2026-06-10T00:00:00.000Z",
      metadata: envelope,
    },
  };
}

interface DbSeed {
  campaignRow: Record<string, unknown>;
  siblingRows: Record<string, unknown>[];
  learningRows: Record<string, unknown>[];
  approvalRows: Record<string, unknown>[];
  auditRows: Record<string, unknown>[];
}

function createMockDb(seed: DbSeed) {
  const updateSets: { table: string; value: any }[] = [];
  const materializedSnapshots: any[] = [];

  const learningChain = {
    where: (...conds: unknown[]) => {
      const numbers: number[] = [];
      const strings: string[] = [];
      const walk = (value: unknown, depth: number) => {
        if (depth > 10 || value === null || value === undefined) return;
        if (typeof value === "string") {
          strings.push(value);
          return;
        }
        if (typeof value === "number") {
          numbers.push(value);
          return;
        }
        if (typeof value === "object") {
          for (const v of Object.values(value)) walk(v, depth + 1);
        }
      };
      walk(conds, 0);
      const chain: any = {
        limit: async () => {
          const target = seed.learningRows.find((r) => numbers.includes(r.id as number));
          return target ? [{ ...target }] : [];
        },
        orderBy: () => ({
          limit: async () => [] as Record<string, unknown>[],
          then: (resolve: any) => Promise.resolve([]).then(resolve),
        }),
        then: (resolve: any) => Promise.resolve([]).then(resolve),
      };
      return chain;
    },
  };

  const genericChain = {
    where: (...conds: unknown[]) => {
      const strings: string[] = [];
      const numbers: number[] = [];
      const walk = (value: unknown, depth: number) => {
        if (depth > 10 || value === null || value === undefined) return;
        if (typeof value === "string") {
          strings.push(value);
          return;
        }
        if (typeof value === "number") {
          numbers.push(value);
          return;
        }
        if (typeof value === "object") {
          for (const v of Object.values(value)) walk(v, depth + 1);
        }
      };
      walk(conds, 0);
      const rowsFor = (): Record<string, unknown>[] => {
        if (strings.includes(LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE)) {
          return seed.approvalRows.filter(
            (r) => numbers.includes(r.userId as number) && numbers.includes(r.campaignId as number)
          );
        }
        if (strings.includes("learning_promotion_resolved")) {
          return seed.auditRows.filter((r) =>
            numbers.includes(r.approvalRequestId as number)
          );
        }
        return [];
      };
      return {
        limit: async (n: number) => rowsFor().slice(0, n).map((r) => ({ ...r })),
        orderBy: () => ({
          limit: async (n: number) => rowsFor().slice(0, n).map((r) => ({ ...r })),
          then: (resolve: any) =>
            Promise.resolve(rowsFor().map((r) => ({ ...r }))).then(resolve),
        }),
        then: (resolve: any) => Promise.resolve(rowsFor().map((r) => ({ ...r }))).then(resolve),
      };
    },
  };

  const db = {
    transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
      const tx = {
        insert: vi.fn((table: any) => ({
          values: vi.fn(async () => [{ insertId: 9001 }]),
        })),
      };
      return callback(tx);
    }),
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
        if (name === "campaigns") {
          return {
            where: () => ({
              limit: async () => [{ ...seed.campaignRow }],
              orderBy: () => ({
                limit: async (n: number) => seed.siblingRows.slice(0, n).map((r) => ({ ...r })),
                then: (resolve: any) =>
                  Promise.resolve(seed.siblingRows.map((r) => ({ ...r }))).then(resolve),
              }),
            }),
            orderBy: () => ({
              limit: async (n: number) => seed.siblingRows.slice(0, n).map((r) => ({ ...r })),
              then: (resolve: any) =>
                Promise.resolve(seed.siblingRows.map((r) => ({ ...r }))).then(resolve),
            }),
            limit: async () => [{ ...seed.campaignRow }],
          };
        }
        if (name === "learning_records") return learningChain;
        return genericChain;
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((value: any) => {
        updateSets.push({ table: String(table?.[Symbol.for("drizzle:Name")] ?? ""), value });
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    })),
  };

  return { db, updateSets, materializedSnapshots };
}

const baseBusiness = {
  name: "Payout Co",
  industry: "Fintech",
  productOrService: "payout platform for restaurants",
  targetCustomer: "restaurant owners",
};

describe("runStrategyAgent consumes approved Learning promotions (WBS15.7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("feeds labelled envelope evidence into the prompt and persists lineage in the new snapshot + workflowContext", async () => {
    const { getDb } = await import("../../queries/connection");
    const { materializeGovernedStrategySnapshot } = await import(
      "../strategy/strategy-snapshot-materialization"
    );
    const sealed = makeSealedFixture({
      campaignId: 42,
      learningRecordId: 501,
      approvalRequestId: 71,
    });
    const mock = createMockDb({
      campaignRow: { id: 42, userId: 18, businessId: 5, workflowContext: {} },
      siblingRows: [{ id: 42 }],
      learningRows: [sealed.learningRecordRow],
      approvalRows: [sealed.approvalRow],
      auditRows: [sealed.auditRow],
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    const snapshotInputs: any[] = [];
    vi.mocked(materializeGovernedStrategySnapshot).mockImplementation(async (input: any) => {
      snapshotInputs.push(input);
      return {
        status: "inserted",
        snapshot: {
          snapshotId: `test-strategy-${input.strategyRunId}`,
          userId: input.userId,
          campaignId: input.campaignId,
          businessId: input.businessId,
          strategyRunId: input.strategyRunId,
          businessDnaSnapshotId: "test-bdna-snapshot",
          version: 1,
          creativeBriefFingerprint: input.creativeBriefFingerprint,
          strategyHashSha256: "0".repeat(64),
          snapshot: input.snapshot,
          capturedAt: new Date("2026-09-22T00:00:00.000Z"),
        },
      } as any;
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: buildOutput(),
      usage: { promptTokens: 100, completionTokens: 50 },
    } as any);

    await runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness });

    // 1. The prompt carries the explicitly labelled approved-recommendation
    //    section with the fingerprint-bound envelope coordinates.
    const promptArg = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(promptArg.prompt).toContain("APPROVED LEARNING PROMOTIONS");
    expect(promptArg.prompt).toContain("provenanceClass: approved_recommendation");
    expect(promptArg.prompt).toContain(sealed.proposalFingerprint);
    expect(promptArg.prompt).toContain("NOT OBSERVED FACTS");

    // 2. The NEW immutable snapshot payload embeds the explicit lineage, so
    //    the strategy version is reconstructable from durable coordinates.
    expect(snapshotInputs).toHaveLength(1);
    const snapshotPayload = snapshotInputs[0].snapshot as any;
    expect(snapshotPayload.learningPromotionInputs).toEqual([
      {
        approvalRequestId: 71,
        proposalFingerprint: sealed.proposalFingerprint,
        learningRecordId: 501,
        campaignId: 42,
        evaluationVersion: "learning-v2",
        learningEngineVersion: "learning-v2",
        recommendationId: "rec_improve_hook_ctr",
        targetEngine: "creative",
        adjustmentType: "improve_hook_ctr",
        promotedProvenanceClass: "approved_recommendation",
      },
    ]);

    // 3. The campaign workflowContext records the same lineage.
    const campaignUpdate = mock.updateSets.find((u) => u.table === "campaigns")!;
    expect(campaignUpdate).toBeDefined();
    expect(campaignUpdate.value.workflowContext.learningPromotionInputs).toEqual(
      snapshotPayload.learningPromotionInputs
    );
  });

  it("consumes same-business sibling envelopes but never cross-business ones", async () => {
    const { getDb } = await import("../../queries/connection");
    const { materializeGovernedStrategySnapshot } = await import(
      "../strategy/strategy-snapshot-materialization"
    );
    const own = makeSealedFixture({ campaignId: 42, learningRecordId: 501, approvalRequestId: 71 });
    const sibling = makeSealedFixture({
      campaignId: 43,
      learningRecordId: 601,
      approvalRequestId: 72,
    });
    const crossBusiness = makeSealedFixture({
      campaignId: 44,
      learningRecordId: 701,
      approvalRequestId: 73,
    });
    const mock = createMockDb({
      campaignRow: { id: 42, userId: 18, businessId: 5, workflowContext: {} },
      // Sibling resolution only ever sees the same-business campaigns.
      siblingRows: [{ id: 42 }, { id: 43 }],
      learningRows: [own.learningRecordRow, sibling.learningRecordRow, crossBusiness.learningRecordRow],
      approvalRows: [own.approvalRow, sibling.approvalRow, crossBusiness.approvalRow],
      auditRows: [own.auditRow, sibling.auditRow, crossBusiness.auditRow],
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    const snapshotInputs: any[] = [];
    vi.mocked(materializeGovernedStrategySnapshot).mockImplementation(async (input: any) => {
      snapshotInputs.push(input);
      return { status: "inserted", snapshot: { ...input } } as any;
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: buildOutput(),
      usage: { promptTokens: 1, completionTokens: 1 },
    } as any);

    await runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness });

    const promptArg = vi.mocked(generateObject).mock.calls[0][0] as any;
    // Both same-business envelopes are consumed...
    expect(promptArg.prompt).toContain(own.proposalFingerprint);
    expect(promptArg.prompt).toContain(sibling.proposalFingerprint);
    // ...and the cross-business envelope never reaches the cycle.
    expect(promptArg.prompt).not.toContain(crossBusiness.proposalFingerprint);

    const lineage = (snapshotInputs[0].snapshot as any).learningPromotionInputs;
    expect(lineage.map((entry: any) => entry.campaignId).sort((a: number, b: number) => a - b)).toEqual([42, 43]);
  });

  it("leaves prompt, snapshot and workflowContext unchanged when no approved promotion exists", async () => {
    const { getDb } = await import("../../queries/connection");
    const { materializeGovernedStrategySnapshot } = await import(
      "../strategy/strategy-snapshot-materialization"
    );
    const mock = createMockDb({
      campaignRow: { id: 42, userId: 18, businessId: 5, workflowContext: {} },
      siblingRows: [{ id: 42 }],
      learningRows: [],
      approvalRows: [],
      auditRows: [],
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    const snapshotInputs: any[] = [];
    vi.mocked(materializeGovernedStrategySnapshot).mockImplementation(async (input: any) => {
      snapshotInputs.push(input);
      return { status: "inserted", snapshot: { ...input } } as any;
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: buildOutput(),
      usage: { promptTokens: 1, completionTokens: 1 },
    } as any);

    await runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness });

    const promptArg = vi.mocked(generateObject).mock.calls[0][0] as any;
    expect(promptArg.prompt).not.toContain("APPROVED LEARNING PROMOTIONS");
    expect(snapshotInputs[0].snapshot).not.toHaveProperty("learningPromotionInputs");
    const campaignUpdate = mock.updateSets.find((u) => u.table === "campaigns")!;
    expect(campaignUpdate.value.workflowContext.learningPromotionInputs).toBeUndefined();
  });
});
