import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R5 operations tests");
  }),
}));

vi.mock("./lib/governance/r5-stream-evidence", () => ({
  readR5ListeningEvidence: vi.fn(),
  readR5ListeningRollup: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { operationsRouter } from "./operations-router";
import { readR5ListeningEvidence } from "./lib/governance/r5-stream-evidence";
import { buildCtx, createFakeDb } from "./r5-test-support";

const mockedListening = vi.mocked(readR5ListeningEvidence);

const ADMIN = { id: 7, role: "admin" };
const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const LISTENING_ABSENT = { available: false, reason: "stream_tables_absent", bindings: [] };

/**
 * Business fixture set:
 *  - biz 10 (user 100): exhausted credit wallet        -> BLOCKED_CONFIGURATION
 *  - biz 11 (user 101): pending approval + integration -> BLOCKED_OPERATOR
 *  - biz 12 (user 102): no R5 evidence at all          -> UNSUPPORTED
 *  - biz 13 (user 103): failed queue item (security code,
 *    ANOTHER business's campaign queue rows exist too) -> FAIL_CLOSED
 */
function baseSeed() {
  return {
    businesses: [
      { id: 10, userId: 100, name: "Acme" },
      { id: 11, userId: 101, name: "Beta" },
      { id: 12, userId: 102, name: "Gamma" },
      { id: 13, userId: 103, name: "Delta" },
    ],
    campaigns: [
      { id: 1001, businessId: 10, userId: 100, workflowState: "campaign_live", workflowContext: {} },
      { id: 1002, businessId: 11, userId: 101, workflowState: "campaign_live", workflowContext: {} },
      { id: 1003, businessId: 13, userId: 103, workflowState: "campaign_live", workflowContext: {} },
    ],
    social_integrations: [
      { id: 8001, businessId: 11, userId: 101, platform: "instagram", status: "connected" },
    ],
    credit_wallets: [{ id: 1, userId: 100, balance: 0 }],
    approval_requests: [
      {
        id: 9001,
        userId: 101,
        campaignId: null,
        status: "pending",
        approvalType: "sensitive_reply",
        riskLevel: "high",
        createdAt: new Date(NOW.getTime() - HOUR_MS),
      },
    ],
    publishing_queue: [
      {
        id: 5001,
        campaignId: 1002,
        status: "published",
        publishedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
        retryCount: 0,
        maxRetries: 3,
        nextRetryAt: null,
        lastError: null,
      },
      {
        id: 5002,
        // Owned by DELTA's campaign: must never surface inside Beta's (biz 11)
        // projection even though Beta has queue activity of its own.
        campaignId: 1003,
        status: "failed",
        publishedAt: null,
        retryCount: 3,
        maxRetries: 3,
        nextRetryAt: null,
        lastError: "security_policy_denied",
      },
    ],
    queue_terminal_failures: [
      {
        id: 7001,
        campaignId: 1003,
        status: "open",
        queueName: "publishing",
        terminalReason: "retries_exhausted",
        errorCode: "provider_timeout",
        failedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
      },
    ],
    queue_replay_requests: [],
    creative_generation_claims: [],
    credit_reservations: [],
    user_usage: [],
    subscriptions: [],
    subscription_tiers: [],
  } as Record<string, Record<string, unknown>[]>;
}

function useSeed(seed: Record<string, Record<string, unknown>[]>) {
  vi.mocked(getDb).mockReturnValue(createFakeDb(seed).db as never);
}

describe("operations router — authorization (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it.each([
    ["getBusinessOperations", (c: any) => c.getBusinessOperations({ businessId: 10 })],
    ["listOperationalStates", (c: any) => c.listOperationalStates({})],
    ["getOperationsSummary", (c: any) => c.getOperationsSummary()],
  ] as const)("%s rejects unauthenticated callers", async (_name, call) => {
    useSeed(baseSeed());
    await expect(call(operationsRouter.createCaller(buildCtx(null)) as never)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it.each([
    ["getBusinessOperations", (c: any) => c.getBusinessOperations({ businessId: 10 })],
    ["listOperationalStates", (c: any) => c.listOperationalStates({})],
    ["getOperationsSummary", (c: any) => c.getOperationsSummary()],
  ] as const)("%s rejects verified non-admin callers", async (_name, call) => {
    useSeed(baseSeed());
    await expect(
      call(operationsRouter.createCaller(buildCtx({ id: 9, role: "user" })) as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("operations router — getBusinessOperations (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it("returns the canonical projection for an admin caller", async () => {
    useSeed(baseSeed());
    const projection = await operationsRouter
      .createCaller(buildCtx(ADMIN))
      .getBusinessOperations({ businessId: 10 });

    expect(projection.business).toMatchObject({ id: 10, userId: 100, name: "Acme" });
    expect(projection.health).toBe("BLOCKED_CONFIGURATION");
    const budget = projection.blockers.find((b) => b.blockerClass === "BUDGET_EXHAUSTED");
    expect(budget).toMatchObject({
      recoveryClass: "GOVERNANCE_APPROVAL",
      safeNextAction: "resume_budget_continuation",
      area: "billing_quota",
    });
    expect(projection.billingQuota.walletExhausted).toBe(true);
  });

  it("carries listening evidence from the stream-evidence bridge", async () => {
    useSeed(baseSeed());
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        {
          integrationId: 8001,
          provider: "meta",
          platform: "instagram",
          providerAccountId: "acct-9",
          mechanism: "webhook",
          status: "blocked",
          cursorUpdatedAt: null,
          lastSuccessAt: new Date(NOW.getTime() - 4 * HOUR_MS),
          lastFailureAt: new Date(NOW.getTime() - HOUR_MS),
          lastFailureClass: "OPERATOR_ACTION",
          lastFailureCode: "webhook_disabled",
          lastFailureReason: null,
          acceptedCount: 10,
          duplicateCount: 0,
          rejectedCount: 0,
          signalsLast24h: 0,
          latestSignalObservedAt: null,
        },
      ],
    } as never);

    const projection = await operationsRouter
      .createCaller(buildCtx(ADMIN))
      .getBusinessOperations({ businessId: 11 });

    expect(projection.listening.available).toBe(true);
    expect(projection.listening.bindings).toHaveLength(1);
    expect(projection.health).toBe("BLOCKED_OPERATOR");
    expect(projection.blockers.some((b) => b.area === "listening")).toBe(true);
  });

  it("never leaks queue items owned by another business's campaign (tenant scoping)", async () => {
    useSeed(baseSeed());
    const projection = await operationsRouter
      .createCaller(buildCtx(ADMIN))
      .getBusinessOperations({ businessId: 11 });

    // Delta's failed/security queue rows and open terminal failure belong to
    // campaign 1003; Beta only owns campaign 1002 (one published item).
    expect(projection.engagement.campaignIds).toEqual([1002]);
    expect(projection.engagement.queueCounts).toEqual({ published: 1 });
    expect(projection.engagement.failedItems).toEqual([]);
    expect(projection.engagement.safetyBlockedCount).toBe(0);
    expect(projection.queueRecovery.openTerminalFailureCount).toBe(0);
    expect(projection.queueRecovery.openReplayRequestCount).toBe(0);
    expect(
      projection.blockers.some(
        (b) => b.blockerClass === "SECURITY_REJECTION" || b.area === "queue_recovery"
      )
    ).toBe(false);
  });

  it("surfaces the cross-business evidence for the OWNING business", async () => {
    useSeed(baseSeed());
    const projection = await operationsRouter
      .createCaller(buildCtx(ADMIN))
      .getBusinessOperations({ businessId: 13 });

    expect(projection.engagement.failedItems).toEqual([
      { id: 5002, lastError: "security_policy_denied" },
    ]);
    expect(projection.queueRecovery.openTerminalFailureCount).toBe(1);
    expect(projection.health).toBe("FAIL_CLOSED");
    expect(projection.blockers.some((b) => b.blockerClass === "SECURITY_REJECTION")).toBe(true);
  });

  it("NOT_FOUND for an unknown business; bounded message only", async () => {
    useSeed(baseSeed());
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).getBusinessOperations({ businessId: 9999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "business not found" });
  });

  it("rejects malformed identifiers before any projection", async () => {
    useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));
    await expect(caller.getBusinessOperations({ businessId: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.getBusinessOperations({ businessId: -3 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.getBusinessOperations({ businessId: 1.5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("projection output is secret-free", async () => {
    useSeed(baseSeed());
    for (const businessId of [10, 11, 12, 13]) {
      const projection = await operationsRouter
        .createCaller(buildCtx(ADMIN))
        .getBusinessOperations({ businessId });
      const serialized = JSON.stringify(projection);
      for (const forbidden of ["accessToken", "refreshToken", "password", "secret", "contentText"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });
});

describe("operations router — listOperationalStates (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it("lists projected states most-recent-first with full blockers", async () => {
    useSeed(baseSeed());
    const result = await operationsRouter
      .createCaller(buildCtx(ADMIN))
      .listOperationalStates({});

    expect(result.total).toBe(4);
    expect(result.items.map((i) => i.business.id)).toEqual([13, 12, 11, 10]);
    expect(result.items.map((i) => i.health)).toEqual([
      "FAIL_CLOSED",
      "UNSUPPORTED",
      "BLOCKED_OPERATOR",
      "BLOCKED_CONFIGURATION",
    ]);
    const blocked = result.items.find((i) => i.business.id === 10)!;
    expect(blocked.blockers.some((b) => b.blockerClass === "BUDGET_EXHAUSTED")).toBe(true);
    expect(blocked.safeNextAction).toBe("resume_budget_continuation");
    expect(blocked.staleness.thresholdMs).toBeGreaterThan(0);
    expect(typeof blocked.capabilitiesPresent).toBe("number");
  });

  it("filters by health", async () => {
    useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    const operators = await caller.listOperationalStates({ health: "BLOCKED_OPERATOR" });
    expect(operators.items.map((i) => i.business.id)).toEqual([11]);

    const unsupported = await caller.listOperationalStates({ health: "UNSUPPORTED" });
    expect(unsupported.items.map((i) => i.business.id)).toEqual([12]);

    const healthy = await caller.listOperationalStates({ health: "HEALTHY" });
    expect(healthy.items).toEqual([]);
  });

  it("respects limit and offset over the businesses window", async () => {
    useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    const first = await caller.listOperationalStates({ limit: 2, offset: 0 });
    expect(first.items.map((i) => i.business.id)).toEqual([13, 12]);
    expect(first.limit).toBe(2);
    expect(first.offset).toBe(0);

    const second = await caller.listOperationalStates({ limit: 2, offset: 2 });
    expect(second.items.map((i) => i.business.id)).toEqual([11, 10]);
  });

  it("rejects out-of-range pagination and unknown health values", async () => {
    useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));
    await expect(caller.listOperationalStates({ limit: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.listOperationalStates({ limit: 101 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.listOperationalStates({ offset: -1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.listOperationalStates({ health: "SOMETHING_ELSE" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("operations router — getOperationsSummary (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it("counts projected businesses by health and blocker class", async () => {
    useSeed(baseSeed());
    const summary = await operationsRouter.createCaller(buildCtx(ADMIN)).getOperationsSummary();

    expect(summary.totalBusinesses).toBe(4);
    expect(summary.projectedCount).toBe(4);
    expect(summary.truncated).toBe(false);
    expect(summary.healthCounts).toMatchObject({
      HEALTHY: 0,
      DEGRADED: 0,
      BLOCKED_OPERATOR: 1,
      BLOCKED_CONFIGURATION: 1,
      AUTO_RECOVERING: 0,
      UNSUPPORTED: 1,
      FAIL_CLOSED: 1,
    });
    expect(summary.blockerClassCounts).toMatchObject({
      BUDGET_EXHAUSTED: 1,
      POLICY_REQUIRES_APPROVAL: 1,
      SECURITY_REJECTION: 1,
      STALE_OPERATION: 1,
    });
    expect(typeof summary.generatedAt).toBe("string");
  });

  it("marks truncated when the businesses table exceeds the bounded window", async () => {
    const seed = baseSeed();
    for (let i = 0; i < 30; i++) {
      seed.businesses.push({ id: 100 + i, userId: 1000 + i, name: `Extra ${i}` });
    }
    useSeed(seed);

    const summary = await operationsRouter.createCaller(buildCtx(ADMIN)).getOperationsSummary();
    expect(summary.totalBusinesses).toBe(34);
    expect(summary.projectedCount).toBe(25);
    expect(summary.truncated).toBe(true);
    expect(summary.healthCounts.UNSUPPORTED).toBe(25); // the 25 most-recent extras fill the window
  });
});
