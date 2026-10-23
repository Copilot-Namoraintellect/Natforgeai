import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/subscription", () => ({
  checkLimit: vi.fn(async () => ({ allowed: true })),
  incrementCampaignUsage: vi.fn(),
  incrementResultUsage: vi.fn(),
}));

vi.mock("./lib/agents/strategy-agent", () => ({
  runStrategyAgent: vi.fn(),
  chargeForStrategyRun: vi.fn(),
  reconcileStrategyRunCharge: vi.fn(async () => ({ alreadyCharged: true, chargedNow: false })),
  validateStrategyReadiness: vi.fn(() => ({ ready: true })),
  isSuccessfulStrategyOutput: vi.fn((output: any) => {
    return (
      typeof output === "object" &&
      output !== null &&
      typeof output.creativeBriefFingerprint === "string" &&
      !("outcome" in output)
    );
  }),
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "strategy_approved"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("./lib/creative/creative-generation-claim", () => ({
  generateOwnerToken: vi.fn(() => "test-owner-token"),
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "test-owner-token" },
  })),
  attachCreativeGenerationOperationReference: vi.fn(async () => ({ attached: true })),
  releaseClaimSafely: vi.fn(),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 300_000)),
  createClaimHeartbeatController: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    assertStillOwned: vi.fn(async () => undefined),
    abortSignal: undefined,
    lostOwnership: false,
  })),
}));

vi.mock("./lib/creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "fp-current",
    productOrService: "service",
    targetBuyer: "buyer",
    mainPainPoint: "pain",
    preferredCta: "cta",
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

vi.mock("./lib/billing/credit-engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deductCredits: vi.fn(async () => ({ newBalance: 100 })),
    refundCredits: vi.fn(async () => ({ newBalance: 100 })),
  };
});

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface HarnessOptions {
  business?: Record<string, unknown> | null;
  businessId?: number;
}

function createHarness({ business, businessId = 7 }: HarnessOptions = {}) {
  const state = {
    campaigns: [] as any[],
    businesses:
      business === null
        ? []
        : [
            {
              id: businessId,
              userId: 18,
              name: "Test Business",
              onboardingComplete: true,
              productOrService: "service",
              targetCustomer: "buyer",
              websiteEvidence: { confidence: 0.8 },
              ...business,
            },
          ],
    nextId: 100,
  };

  const insertCalls: any[] = [];

  const rowsFor = (table: unknown): any[] => {
    const name = getTableName(table);
    if (name === "campaigns") return state.campaigns.map((c) => ({ ...c }));
    if (name === "businesses") return state.businesses.map((b) => ({ ...b }));
    if (name === "agent_runs") return [];
    return [];
  };

  const db = {
    state,
    insertCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rows = rowsFor(table);
          return {
            limit: vi.fn(async () => rows.slice(0, 1)),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async (n: number) => rows.slice(0, n)),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(rows).then(resolve),
            })),
            then: (resolve: (value: unknown[]) => unknown) =>
              Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: any) => {
        const name = getTableName(table);
        if (name === "campaigns") {
          const id = state.nextId++;
          const row = { id, ...values };
          state.campaigns.push(row);
          insertCalls.push(row);
          return [{ insertId: id }];
        }
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          if (name === "campaigns") {
            for (const row of state.campaigns) Object.assign(row, payload);
          }
          return [];
        }),
      })),
    })),
  };

  return { db, state, insertCalls };
}

function buildOnboardedCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 18, tierSlug: "free", onboardingComplete: true },
    session: { verified: true },
  } as any;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const BOOTSTRAP_KEY = "bootstrap-key-0123456789abcdef";

describe("campaign bootstrap idempotency (WBS-R4 A1-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create replays with the same id and consumes usage exactly once", async () => {
    const { getDb } = await import("./queries/connection");
    const { incrementCampaignUsage } = await import("./lib/subscription");
    const { campaignRouter } = await import("./campaign-router");

    const { db, state } = createHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const first = await caller.create({
      name: "First",
      goal: "Grow",
      businessId: 7,
      idempotencyKey: BOOTSTRAP_KEY,
    });

    expect(first).toMatchObject({ id: 100, success: true });
    expect(state.campaigns).toHaveLength(1);
    expect(state.campaigns[0].workflowContext).toEqual({
      bootstrapIdempotencyKey: BOOTSTRAP_KEY,
    });
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(1);

    const second = await caller.create({
      name: "Second (retry)",
      goal: "Grow again",
      businessId: 7,
      idempotencyKey: BOOTSTRAP_KEY,
    });

    expect(second).toEqual({
      id: 100,
      success: true,
      workflowState: state.campaigns[0].workflowState,
      idempotentReplay: true,
    });
    expect(state.campaigns).toHaveLength(1);
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(1);
  });

  it("create with a different key inserts a new campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { incrementCampaignUsage } = await import("./lib/subscription");
    const { campaignRouter } = await import("./campaign-router");

    const { db, state } = createHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await caller.create({
      name: "First",
      goal: "Grow",
      businessId: 7,
      idempotencyKey: BOOTSTRAP_KEY,
    });
    const other = await caller.create({
      name: "Other",
      goal: "Grow",
      businessId: 7,
      idempotencyKey: "bootstrap-key-fedcba9876543210",
    });

    expect(other.idempotentReplay).toBeUndefined();
    expect(state.campaigns).toHaveLength(2);
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(2);
  });

  it("create rejects an idempotencyKey that is too short", async () => {
    const { getDb } = await import("./queries/connection");
    const { campaignRouter } = await import("./campaign-router");

    const { db } = createHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await expect(
      caller.create({
        name: "First",
        goal: "Grow",
        businessId: 7,
        idempotencyKey: "short",
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it("startCampaignWorkflow replays with the same id and consumes usage exactly once", async () => {
    const { getDb } = await import("./queries/connection");
    const { incrementCampaignUsage } = await import("./lib/subscription");
    const { autonomousWorkflowRouter } = await import("./autonomous-workflow-router");

    const { db, state } = createHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = autonomousWorkflowRouter.createCaller(buildOnboardedCtx());
    const first = await caller.startCampaignWorkflow({
      businessId: 7,
      name: "First",
      goal: "Grow",
      idempotencyKey: BOOTSTRAP_KEY,
    });

    expect(first).toMatchObject({ id: 100, success: true });
    expect(state.campaigns).toHaveLength(1);
    expect(state.campaigns[0].workflowContext).toMatchObject({
      bootstrapIdempotencyKey: BOOTSTRAP_KEY,
    });
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(1);

    const second = await caller.startCampaignWorkflow({
      businessId: 7,
      name: "Second (retry)",
      goal: "Grow again",
      idempotencyKey: BOOTSTRAP_KEY,
    });

    expect(second).toEqual({ id: 100, success: true, idempotentReplay: true });
    expect(state.campaigns).toHaveLength(1);
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(1);
  });
});

describe("campaign create auto-start continuity (WBS-R4 A1-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips auto-start and returns a DNA readiness block when the business profile is unready", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const { db } = createHarness({
      business: { productOrService: null, targetCustomer: null, websiteEvidence: null },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const result = await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
    });

    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.readiness).toMatchObject({
      ready: false,
      code: "BUSINESS_DNA_READINESS_FAILED",
      gate: "business_dna",
      missing: expect.arrayContaining(["primaryOffering", "targetCustomerSegments"]),
      action: { path: "/settings?tab=businesses", label: "Complete business profile" },
    });
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(onAgentRunComplete).not.toHaveBeenCalled();
  });

  it("returns a WEBSITE_EVIDENCE_INSUFFICIENT_CONFIDENCE block instead of silently skipping", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    const { db } = createHarness({
      business: { websiteEvidence: { confidence: 0.4 } },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const result = await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
    });

    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.readiness).toEqual({
      ready: false,
      code: "WEBSITE_EVIDENCE_INSUFFICIENT_CONFIDENCE",
      gate: "website_evidence",
      confidence: 0.4,
      userMessage: expect.stringContaining("40%"),
      action: { path: "/settings?tab=businesses", label: "Complete business profile" },
    });
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("auto-starts strategy on the normal path when every gate passes", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const { db } = createHarness();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 248 } as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const result = await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
    });

    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.readiness).toBeUndefined();
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith(248);
  });
});
