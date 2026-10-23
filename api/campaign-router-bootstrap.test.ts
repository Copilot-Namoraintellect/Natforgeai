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


// ── Security addendum (WBS-R4 Stream A): bootstrap idempotency boundaries ──

/**
 * Scoped harness: campaigns AND businesses are filtered by the where
 * conditions (userId scoping + bootstrapIdempotencyKey JSON_EXTRACT
 * emulation), so cross-tenant lookups genuinely miss. Two tenants are
 * seeded: user 18 (business 7) and user 999 (business 8).
 */
function createScopedHarness() {
  const state = {
    campaigns: [] as any[],
    businesses: [
      {
        id: 7,
        userId: 18,
        name: "Tenant A Business",
        onboardingComplete: true,
        preferredPlatforms: "instagram",
      },
      {
        id: 8,
        userId: 999,
        name: "Tenant B Business",
        onboardingComplete: true,
        preferredPlatforms: "instagram",
      },
    ],
    nextId: 100,
  };
  const insertCalls: any[] = [];

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

  const matches = (row: any, filters: Array<{ name: string; value: unknown }>) =>
    filters.every((f) => {
      if (f.name === "workflowContext" && typeof f.value === "string") {
        const ctx = row.workflowContext && typeof row.workflowContext === "object" ? row.workflowContext : {};
        return ctx.bootstrapIdempotencyKey === f.value;
      }
      return row[f.name] === f.value;
    });

  const db = {
    state,
    insertCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          const name = getTableName(table);
          const rows =
            name === "campaigns"
              ? state.campaigns.filter((c) => matches(c, columnFilters(condition)))
              : name === "businesses"
                ? state.businesses.filter((b) => matches(b, columnFilters(condition)))
                : [];
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
          if (getTableName(table) === "campaigns") {
            for (const row of state.campaigns) Object.assign(row, payload);
          }
          return [];
        }),
      })),
    })),
  };

  return { db, state, insertCalls };
}

function buildCtx(userId: number) {
  return {
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "free", onboardingComplete: true },
    session: { verified: true },
  } as any;
}

describe("bootstrap idempotency security boundaries (WBS-R4 security addendum)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("campaign.create: cross-tenant replay of a known key must not return the owner's campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { incrementCampaignUsage } = await import("./lib/subscription");
    const { campaignRouter } = await import("./campaign-router");

    const { db, state } = createScopedHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    // Tenant A bootstraps with key K.
    const ownerCreate = await campaignRouter
      .createCaller(buildCtx(18))
      .create({ name: "A campaign", goal: "Grow", businessId: 7, idempotencyKey: BOOTSTRAP_KEY });
    expect(ownerCreate).toMatchObject({ id: 100, success: true });
    const ownerRow = { ...state.campaigns[0] };

    // Tenant B submits the SAME key: tenant isolation is non-negotiable. B
    // must receive a normal new campaign — never A's id, never a replay flag.
    const foreignCreate = await campaignRouter
      .createCaller(buildCtx(999))
      .create({ name: "B campaign", goal: "Grow", businessId: 8, idempotencyKey: BOOTSTRAP_KEY });

    expect(foreignCreate.id).not.toBe(ownerCreate.id);
    expect((foreignCreate as any).idempotentReplay).toBeFalsy();
    expect(foreignCreate.success).toBe(true);
    expect(state.campaigns).toHaveLength(2);
    // B's row is scoped to B and leaks nothing of A's campaign.
    const foreignRow = state.campaigns[1];
    expect(foreignRow.userId).toBe(999);
    expect(foreignRow.workflowContext).toEqual({ bootstrapIdempotencyKey: BOOTSTRAP_KEY });
    expect(JSON.stringify(foreignCreate)).not.toContain(String(ownerCreate.id));
    // A's row is byte-identical after B's attempt.
    expect(state.campaigns[0]).toEqual(ownerRow);
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(2);
  });

  it("startCampaignWorkflow: cross-tenant replay of a known key must not return the owner's campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { incrementCampaignUsage } = await import("./lib/subscription");
    const { autonomousWorkflowRouter } = await import("./autonomous-workflow-router");

    const { db, state } = createScopedHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const ownerCreate = await autonomousWorkflowRouter
      .createCaller(buildCtx(18))
      .startCampaignWorkflow({
        businessId: 7,
        name: "A workflow",
        goal: "Grow",
        idempotencyKey: BOOTSTRAP_KEY,
      });
    expect(ownerCreate).toMatchObject({ id: 100, success: true });

    const foreignCreate = await autonomousWorkflowRouter
      .createCaller(buildCtx(999))
      .startCampaignWorkflow({
        businessId: 8,
        name: "B workflow",
        goal: "Grow",
        idempotencyKey: BOOTSTRAP_KEY,
      });

    expect(foreignCreate).toMatchObject({ success: true });
    expect((foreignCreate as any).idempotentReplay).toBeFalsy();
    expect(foreignCreate.id).not.toBe(ownerCreate.id);
    expect(state.campaigns).toHaveLength(2);
    expect(state.campaigns[1].userId).toBe(999);
    expect(JSON.stringify(foreignCreate)).not.toContain(String(ownerCreate.id));
    expect(incrementCampaignUsage).toHaveBeenCalledTimes(2);
  });

  it("identifier tampering: wrong type/length keys are rejected; null/empty fail closed", async () => {
    const { getDb } = await import("./queries/connection");
    const { campaignRouter } = await import("./campaign-router");

    const { db, state } = createScopedHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx(18));
    const base = { name: "T", goal: "G", businessId: 7 };

    // Too short (< 8) and too long (> 128) both rejected by zod.
    await expect(caller.create({ ...base, idempotencyKey: "short" })).rejects.toBeInstanceOf(Error);
    await expect(
      caller.create({ ...base, idempotencyKey: "x".repeat(129) })
    ).rejects.toBeInstanceOf(Error);
    // Wrong type (numeric key coerced by an attacker) rejected, no crash.
    await expect(
      caller.create({ ...base, idempotencyKey: 12345678 as unknown as string })
    ).rejects.toBeInstanceOf(Error);
    // null is not "absent" for an optional string — fail closed, no crash.
    await expect(
      caller.create({ ...base, idempotencyKey: null as unknown as string })
    ).rejects.toBeInstanceOf(Error);
    // Empty string violates min(8) — fail closed rather than treated as absent.
    await expect(caller.create({ ...base, idempotencyKey: "" })).rejects.toBeInstanceOf(Error);

    // Truly absent key: normal create, no bootstrap context persisted.
    const created = await caller.create(base);
    expect(created.success).toBe(true);
    expect(state.campaigns).toHaveLength(1);
    expect(state.campaigns[0].workflowContext).toBeUndefined();
  });

  it("unknown extra input fields are stripped and never persisted into the campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { campaignRouter } = await import("./campaign-router");

    const { db, state } = createScopedHarness();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx(18));
    const created = await caller.create({
      name: "Clean",
      goal: "Grow",
      businessId: 7,
      idempotencyKey: BOOTSTRAP_KEY,
      evilPayload: { role: "admin" },
      workflowContext: { injected: true },
    } as any);

    expect(created.success).toBe(true);
    const row = state.campaigns[0];
    expect("evilPayload" in row).toBe(false);
    expect("workflowContext" in row && (row as any).workflowContext).toEqual({
      bootstrapIdempotencyKey: BOOTSTRAP_KEY,
    });
  });
});
