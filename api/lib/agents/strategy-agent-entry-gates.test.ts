import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { generateObject } from "ai";
import {
  assertStrategyEntryGates,
  findBlockingStrategyRun,
  resolveStrategyEntryBusinessId,
} from "./strategy-entry-gates";
import {
  BusinessDnaReadinessError,
  BusinessDnaNotFoundError,
} from "../business-dna-governance";

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

vi.mock("./openai", () => ({
  defaultModel: { modelId: "gpt-4o-mini" },
}));

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
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

const NOW = new Date("2026-10-01T12:00:00.000Z");

describe("strategy-entry-gates unit semantics", () => {
  it("resolveStrategyEntryBusinessId fails closed on missing/invalid linkage", () => {
    for (const campaign of [
      null,
      undefined,
      {},
      { id: 42, businessId: null },
      { id: 42, businessId: 0 },
      { id: 42, businessId: -3 },
      { id: 42, businessId: Number.NaN },
    ]) {
      expect(() => resolveStrategyEntryBusinessId(campaign)).toThrowError(
        expect.objectContaining({
          code: "PRECONDITION_FAILED",
          message: "campaign must be linked to a business before strategy generation",
        })
      );
    }
    expect(resolveStrategyEntryBusinessId({ id: 42, businessId: 7 })).toBe(7);
    // Numeric strings coerce; the DB stores businessId as a number.
    expect(resolveStrategyEntryBusinessId({ id: 42, businessId: "7" as unknown as number })).toBe(7);
  });

  it("findBlockingStrategyRun blocks on a non-stale running strategy run", () => {
    const blocking = findBlockingStrategyRun(
      [
        {
          id: 9,
          agentType: "strategy",
          status: "running",
          startedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
        },
      ],
      NOW
    );
    expect(blocking?.id).toBe(9);
  });

  it("findBlockingStrategyRun ignores stale, completed, failed and non-strategy rows", () => {
    const blocking = findBlockingStrategyRun(
      [
        { id: 1, agentType: "strategy", status: "running", startedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
        { id: 2, agentType: "strategy", status: "completed", startedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
        { id: 3, agentType: "strategy", status: "failed", startedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
        { id: 4, agentType: "creative", status: "running", startedAt: new Date(NOW.getTime() - 1000) },
      ],
      NOW
    );
    expect(blocking).toBeNull();
  });

  it("treats a run at exactly the 30-minute TTL as stale", () => {
    const blocking = findBlockingStrategyRun(
      [
        {
          id: 9,
          agentType: "strategy",
          status: "running",
          startedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
        },
      ],
      NOW
    );
    expect(blocking).toBeNull();
  });

  it("assertStrategyEntryGates throws CONFLICT for a live run and returns the businessId otherwise", () => {
    expect(() =>
      assertStrategyEntryGates({
        userId: 18,
        campaignId: 42,
        campaign: { id: 42, businessId: 7 },
        strategyRuns: [
          {
            id: 9,
            agentType: "strategy",
            status: "running",
            startedAt: new Date(NOW.getTime() - 60 * 1000),
          },
        ],
        now: NOW,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICT",
        message: "strategy run already in progress for campaign 42",
      })
    );

    expect(
      assertStrategyEntryGates({
        userId: 18,
        campaignId: 42,
        campaign: { id: 42, businessId: 7 },
        strategyRuns: [
          {
            id: 9,
            agentType: "strategy",
            status: "running",
            startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
          },
        ],
        now: NOW,
      })
    ).toEqual({ businessId: 7 });
  });
});

describe("runStrategyAgent entry gates (before any run-row insert)", () => {
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

  interface Seed {
    campaign?: Record<string, unknown> | null;
    business?: Record<string, unknown> | null;
    agentRuns?: Record<string, unknown>[];
    insertId?: number;
  }

  function createMockDb(seed: Seed) {
    let inserted = false;
    const updateSets: any[] = [];

    const rowsFor = (table: unknown): any[] => {
      const name = (table as Record<symbol, unknown>)[
        Symbol.for("drizzle:Name") as symbol
      ] as string;
      if (name === "campaigns") return seed.campaign ? [{ ...seed.campaign }] : [];
      if (name === "businesses") return seed.business ? [{ ...seed.business }] : [];
      if (name === "agent_runs") return (seed.agentRuns ?? []).map((r) => ({ ...r }));
      return [];
    };

    const makeSelect = () =>
      vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => {
            const rows = rowsFor(table);
            return {
              limit: vi.fn(async () => rows),
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => rows),
                then: (resolve: (value: unknown[]) => unknown) =>
                  Promise.resolve(rows).then(resolve),
              })),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(rows).then(resolve),
            };
          }),
        })),
      }));

    const makeUpdate = () =>
      vi.fn(() => ({
        set: vi.fn((value: any) => {
          updateSets.push(value);
          return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
        }),
      }));

    const db = {
      transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        const result = await callback({
          insert: vi.fn(() => ({
            values: vi.fn(async () => {
              inserted = true;
              return [{ insertId: seed.insertId ?? 9001 }];
            }),
          })),
          update: makeUpdate(),
        });
        return result;
      }),
      select: makeSelect(),
      update: makeUpdate(),
    };

    return { db, updateSets, get inserted() { return inserted; } };
  }

  const readyBusiness = {
    id: 7,
    userId: 18,
    name: "Test Business",
    productOrService: "payout platform for restaurants",
    targetCustomer: "restaurant owners",
    targetAudience: null,
    websiteEvidence: { productsServices: ["payouts"], targetCustomers: ["restaurant owners"] },
    isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws BusinessDnaReadinessError before any insert when the DNA is unready", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb({
      campaign: { id: 42, userId: 18, businessId: 7, workflowContext: {} },
      business: { id: 7, userId: 18, name: "Test Business", productOrService: null, targetCustomer: null, websiteEvidence: null, isActive: true },
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    const error = await runStrategyAgent({
      userId: 18,
      campaignId: 42,
      business: baseBusiness,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BusinessDnaReadinessError);
    expect(error.code).toBe("BUSINESS_DNA_READINESS_FAILED");
    expect(error.businessId).toBe(7);
    expect(error.missing).toEqual(
      expect.arrayContaining(["primaryOffering", "productsAndServices", "targetCustomerSegments"])
    );
    expect(mock.inserted).toBe(false);
    expect(mock.db.transaction).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("throws BusinessDnaNotFoundError when the linked business row is missing", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb({
      campaign: { id: 42, userId: 18, businessId: 7, workflowContext: {} },
      business: null,
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    await expect(
      runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    expect(mock.db.transaction).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when the campaign is not linked to a business", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb({
      campaign: { id: 42, userId: 18, businessId: null, workflowContext: {} },
      business: readyBusiness,
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    await expect(
      runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "campaign must be linked to a business before strategy generation",
    });
    expect(mock.db.transaction).not.toHaveBeenCalled();
  });

  it("throws CONFLICT when a non-stale strategy run is already in progress", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb({
      campaign: { id: 42, userId: 18, businessId: 7, workflowContext: {} },
      business: readyBusiness,
      agentRuns: [
        {
          id: 9,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "running",
          startedAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    await expect(
      runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "strategy run already in progress for campaign 42",
    });
    expect(mock.db.transaction).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("proceeds past the gates (and inserts the run) when only stale runs exist", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");
    const mock = createMockDb({
      campaign: { id: 42, userId: 18, businessId: 7, workflowContext: {} },
      business: readyBusiness,
      agentRuns: [
        {
          id: 9,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "running",
          startedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
      insertId: 9101,
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        personas: [
          {
            name: "Restaurant Owner Rita",
            demographics: "Restaurant owner",
            painPoints: ["Slow cash-outs"],
            goals: ["Faster payouts"],
            platforms: ["Facebook"],
          },
        ],
        positioning: "Same-day payouts.",
        valueProposition: "Money the same day.",
        coreMessage: "A payout platform for restaurants.",
        campaignTheme: "Same-day payouts",
        platformStrategy: [
          {
            platform: "Facebook",
            purpose: "Reach owners",
            contentTypes: ["posts"],
            postingFrequency: "3x per week",
          },
        ],
        funnelStages: [
          { stage: "awareness", goal: "Reach", tactics: ["Ads"], metrics: ["impressions"] },
        ],
        offers: [
          { name: "Setup", description: "Free setup", targetStage: "conversion", value: "R0" },
        ],
        ctas: [{ stage: "awareness", cta: "Book a Demo", placement: "ad" }],
        budgetRecommendation: { total: 1000, allocation: [] },
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await runStrategyAgent({
      userId: 18,
      campaignId: 42,
      business: baseBusiness,
    });

    expect(result.runId).toBe(9101);
    expect(mock.db.transaction).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledTimes(1);
    const completedUpdate = mock.updateSets.find((set: any) => set.status === "completed");
    expect(completedUpdate).toBeDefined();
  });
});


describe("runStrategyAgent business ownership scoping (WBS-R4 security addendum)", () => {
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

  /**
   * Scoped mock: the businesses select honours the where conditions (the
   * production query is id + userId + isActive), so a business owned by
   * another tenant — or an inactive one — is genuinely invisible.
   */
  function createScopedBusinessDb(business: Record<string, unknown> | null) {
    let inserted = false;

    const flatten = (sql: any): any[] => {
      if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
      const out: any[] = [];
      for (const chunk of sql.queryChunks) {
        if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
          out.push(...flatten(chunk));
        } else {
          out.push(chunk);
        }
      }
      return out;
    };
    const columnFilters = (condition: unknown): Array<{ name: string; value: unknown }> => {
      const chunks = flatten(condition);
      const filters: Array<{ name: string; value: unknown }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string") {
          for (let j = i + 1; j < chunks.length; j++) {
            const candidate = chunks[j];
            if (
              candidate &&
              typeof candidate === "object" &&
              !("name" in candidate) &&
              "value" in candidate &&
              !Array.isArray(candidate.value)
            ) {
              filters.push({ name: chunk.name, value: candidate.value });
              break;
            }
          }
        }
      }
      return filters;
    };

    const db: any = {
      transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        const result = await callback({
          insert: vi.fn(() => ({
            values: vi.fn(async () => {
              inserted = true;
              return [{ insertId: 9101 }];
            }),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({ where: vi.fn(async () => [{ affectedRows: 1 }]) })),
          })),
        });
        return result;
      }),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((condition: unknown) => {
            const name = (table as Record<symbol, unknown>)[
              Symbol.for("drizzle:Name") as symbol
            ] as string;
            let rows: any[] = [];
            if (name === "campaigns") {
              rows = [{ id: 42, userId: 18, businessId: 7, workflowContext: {} }];
            } else if (name === "businesses" && business) {
              const filters = columnFilters(condition);
              rows = filters.every((f) => (business as any)[f.name] === f.value)
                ? [{ ...business }]
                : [];
            } else if (name === "agent_runs") {
              rows = [];
            }
            return {
              limit: vi.fn(async () => rows),
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => rows),
                then: (resolve: (value: unknown[]) => unknown) =>
                  Promise.resolve(rows).then(resolve),
              })),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(rows).then(resolve),
            };
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => [{ affectedRows: 1 }]) })),
      })),
    };

    return { db, get inserted() { return inserted; } };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed with BusinessDnaNotFoundError when the business belongs to another user", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");

    // The campaign (user 18) links to business 7, but business 7 is owned by
    // user 999: the owned-active scoped load must see nothing.
    const mock = createScopedBusinessDb({
      id: 7,
      userId: 999,
      name: "Foreign Business",
      productOrService: "payout platform for restaurants",
      targetCustomer: "restaurant owners",
      websiteEvidence: { productsServices: ["payouts"], targetCustomers: ["restaurant owners"] },
      isActive: true,
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    await expect(
      runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    expect(mock.db.transaction).not.toHaveBeenCalled();
    expect(mock.inserted).toBe(false);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("fails closed with BusinessDnaNotFoundError when the business is inactive", async () => {
    const { runStrategyAgent } = await import("./strategy-agent");
    const { getDb } = await import("../../queries/connection");

    const mock = createScopedBusinessDb({
      id: 7,
      userId: 18,
      name: "Inactive Business",
      productOrService: "payout platform for restaurants",
      targetCustomer: "restaurant owners",
      websiteEvidence: { productsServices: ["payouts"], targetCustomers: ["restaurant owners"] },
      isActive: false,
    });
    vi.mocked(getDb).mockReturnValue(mock.db as any);

    await expect(
      runStrategyAgent({ userId: 18, campaignId: 42, business: baseBusiness })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    expect(mock.db.transaction).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });
});
