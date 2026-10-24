import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R5 operations tests");
  }),
}));

vi.mock("./lib/governance/r5-stream-evidence", () => ({
  readR5ListeningEvidence: vi.fn(),
  readR5ListeningRollup: vi.fn(),
  readR5InterpretationEvidence: vi.fn(),
  readR5OpportunityEvidence: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { operationsRouter } from "./operations-router";
import {
  readR5InterpretationEvidence,
  readR5ListeningEvidence,
  readR5OpportunityEvidence,
} from "./lib/governance/r5-stream-evidence";
import { R5_SAFE_NEXT_ACTIONS } from "./lib/governance/r5-operations-projection";
import {
  buildCtx,
  createFakeDb,
  listeningBinding,
  type FakeDbOptions,
} from "./r5-test-support";

const mockedListening = vi.mocked(readR5ListeningEvidence);
const mockedInterpretation = vi.mocked(readR5InterpretationEvidence);
const mockedOpportunity = vi.mocked(readR5OpportunityEvidence);

/* ── Shared fixtures / helpers ────────────────────────────────────────── */

const ADMIN = { id: 7, role: "admin" };
const NORMAL_USER = { id: 9, role: "user" };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ENV_KEY = "R5_OPERATION_RETRY_ADMIN_ENABLED";
const ORIGINAL_ENV = process.env[ENV_KEY];
const LISTENING_ABSENT = { available: false, reason: "stream_tables_absent", bindings: [] };
const INTERPRETATION_ABSENT = {
  available: false,
  reason: "stream_tables_absent",
  interpretationsLast24h: 0,
};
const OPPORTUNITY_ABSENT = {
  available: false,
  reason: "stream_tables_absent",
  openCandidates: 0,
  handedOff: 0,
  candidatesLast24h: 0,
};

beforeAll(() => {
  process.env[ENV_KEY] = "true";
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = "true";
  mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  mockedInterpretation.mockResolvedValue(INTERPRETATION_ABSENT as never);
  mockedOpportunity.mockResolvedValue(OPPORTUNITY_ABSENT as never);
});

function emptySeed() {
  return {
    businesses: [],
    campaigns: [],
    approval_requests: [],
    social_integrations: [],
    credit_wallets: [],
    user_usage: [],
    subscriptions: [],
    subscription_tiers: [],
    publishing_queue: [],
    queue_terminal_failures: [],
    queue_replay_requests: [],
    creative_generation_claims: [],
    credit_reservations: [],
    audit_events: [],
  } as Record<string, Record<string, unknown>[]>;
}

function useSeed(
  seed: Record<string, Record<string, unknown>[]>,
  options?: FakeDbOptions
) {
  vi.mocked(getDb).mockReturnValue(createFakeDb(seed, options).db as never);
  return seed;
}

function addBusiness(
  seed: Record<string, Record<string, unknown>[]>,
  id: number,
  userId: number,
  name = "Biz"
) {
  seed.businesses.push({ id, userId, name });
}

function addCampaign(
  seed: Record<string, Record<string, unknown>[]>,
  id: number,
  userId: number,
  businessId: number
) {
  seed.campaigns.push({
    id,
    userId,
    businessId,
    name: "Campaign",
    workflowState: "campaign_live",
    workflowContext: {},
  });
}

function adminCaller() {
  return operationsRouter.createCaller(buildCtx(ADMIN));
}

function queueItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    campaignId: 4,
    status: "failed",
    retryCount: 3,
    maxRetries: 3,
    nextRetryAt: null,
    publishedAt: null,
    lastError: null,
    ...overrides,
  };
}

function terminalFailureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    failureKey: "qtf:v1:publishing:publish-5",
    queueName: "publishing",
    bullmqJobId: "publish-5",
    terminalReason: "retries_exhausted",
    attemptsMade: 3,
    attemptsConfigured: 3,
    userId: 18,
    campaignId: 4,
    publishingQueueItemId: 5,
    agentRunId: null,
    errorCode: "provider_timeout",
    errorSummary: null,
    failedAt: new Date(),
    status: "open",
    ...overrides,
  };
}

/** Owner 18 / business 6 / campaign 4 / failed queue item 5 / open tf 501. */
function recoverySeed() {
  const seed = emptySeed();
  addBusiness(seed, 6, 18, "Acme");
  addCampaign(seed, 4, 18, 6);
  seed.publishing_queue.push(queueItemRow());
  seed.queue_terminal_failures.push(terminalFailureRow());
  return seed;
}

/* ── Secret / forbidden-procedure scanners ────────────────────────────── */

const FORBIDDEN_TERMS = [
  "accesstoken",
  "refreshtoken",
  "pageaccesstoken",
  "passwordhash",
  "secret",
  "credential",
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** Case-insensitive substring scan of BOTH keys and values. */
function expectSecretFree(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const term of FORBIDDEN_TERMS) {
    expect(serialized).not.toContain(term);
  }
  for (const key of collectKeys(value)) {
    const lower = key.toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      expect(lower).not.toContain(term);
    }
  }
}

function procedureNames(): string[] {
  return Object.keys(
    (operationsRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures
  );
}

const FORBIDDEN_PROCEDURE_PATTERN = /force|override|setState|approve/i;

function expectNoForbiddenProcedures() {
  const names = procedureNames();
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name).not.toMatch(FORBIDDEN_PROCEDURE_PATTERN);
  }
}

/* ═══ F8 acceptance — charter checks 1-24 ═══ */

describe("WBS-R5-F8 acceptance — listening projection (F8.1-F8.4, F8.10)", () => {
  it("F8.1 — healthy listening projection: HEALTHY, no blockers, fresh signals", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    // Raw credential material exists in the durable table but is never
    // selected by the projection (F8.19 asserts the scan).
    seed.social_integrations.push({
      id: 8001,
      businessId: 10,
      userId: 100,
      platform: "instagram",
      status: "connected",
      accessTokenEncrypted: "enc-access-token-material",
      refreshTokenEncrypted: "enc-refresh-token-material",
      pageAccessTokenEncrypted: "enc-page-token",
    });
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        listeningBinding({
          status: "active",
          lastFailureAt: null,
          lastFailureClass: null,
          lastFailureCode: null,
          signalsLast24h: 5,
        }),
      ],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("HEALTHY");
    expect(projection.blockers).toEqual([]);
    expect(projection.listening.available).toBe(true);
    expect(projection.listening.bindings[0].signalsLast24h).toBe(5);
    expect(projection.staleness.isStale).toBe(false);
  });

  it("F8.2 — stale listening: STALE_OPERATION blocker + staleness flag", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        listeningBinding({
          status: "stale",
          lastSuccessAt: new Date(Date.now() - 8 * DAY_MS),
          lastFailureAt: null,
          lastFailureClass: null,
          lastFailureCode: null,
        }),
      ],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "STALE_OPERATION",
        area: "listening",
        recoveryClass: "OPERATOR_ACTION",
      }),
    ]);
    expect(projection.staleness.isStale).toBe(true);
    expect(projection.health).toBe("BLOCKED_OPERATOR");
  });

  it("F8.3 — ingestion blocker visible: OPERATOR_ACTION recovery, BLOCKED_OPERATOR", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        listeningBinding({
          status: "blocked",
          lastFailureAt: new Date(Date.now() - HOUR_MS),
          lastFailureClass: "OPERATOR_ACTION",
          lastFailureCode: "webhook_disabled",
        }),
      ],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("BLOCKED_OPERATOR");
    const blocker = projection.blockers.find((b) => b.area === "listening");
    expect(blocker).toMatchObject({ recoveryClass: "OPERATOR_ACTION" });
    expect(blocker?.blockerClass).toBe("STALE_OPERATION");
  });

  it("F8.4 — interpretation/opportunity areas report stream_tables_absent until B/D migrations run", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect("interpretation" in projection).toBe(true);
    expect(projection.interpretation).toEqual(INTERPRETATION_ABSENT);
    expect("opportunity" in projection).toBe(true);
    expect(projection.opportunity).toEqual(OPPORTUNITY_ABSENT);
  });

  it("F8.10 — unsupported provider capability: BLOCKED_CONFIGURATION", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [listeningBinding({ mechanism: "unsupported", status: "unsupported" })],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("BLOCKED_CONFIGURATION");
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "UNSUPPORTED_PROVIDER_CAPABILITY",
        recoveryClass: "OPERATOR_ACTION",
        safeNextAction: "reconnect_provider_integration",
      }),
    ]);
  });
});

describe("WBS-R5-F8 acceptance — policy / billing blockers (F8.5-F8.7)", () => {
  it("F8.5 — pending approval: POLICY_REQUIRES_APPROVAL / GOVERNANCE_APPROVAL / inspect_pending_approval", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    seed.approval_requests.push({
      id: 9001,
      userId: 100,
      campaignId: null,
      status: "pending",
      approvalType: "sensitive_reply",
      riskLevel: "high",
      createdAt: new Date(),
    });
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("BLOCKED_OPERATOR");
    expect(projection.safeNextAction).toBe("inspect_pending_approval");
    expect(projection.policy.pendingCount).toBe(1);
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "POLICY_REQUIRES_APPROVAL",
        area: "policy",
        recoveryClass: "GOVERNANCE_APPROVAL",
        safeNextAction: "inspect_pending_approval",
      }),
    ]);
  });

  it("F8.6 — exhausted wallet: BUDGET_EXHAUSTED / BLOCKED_CONFIGURATION", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    addCampaign(seed, 3001, 100, 10);
    seed.credit_wallets.push({ id: 1, userId: 100, balance: 0 });
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("BLOCKED_CONFIGURATION");
    expect(projection.safeNextAction).toBe("resume_budget_continuation");
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "BUDGET_EXHAUSTED",
        area: "billing_quota",
        recoveryClass: "GOVERNANCE_APPROVAL",
      }),
    ]);
  });

  it("F8.7 — plan quota reached: QUOTA_EXHAUSTED visible", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    addCampaign(seed, 3001, 100, 10);
    seed.user_usage.push({ id: 1, userId: 100, campaignsCreated: 10, successfulResults: 2 });
    seed.subscriptions.push({ id: 1, userId: 100, tierId: 1, status: "active" });
    seed.subscription_tiers.push({ id: 1, maxCampaigns: 10, maxResults: 5 });
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "QUOTA_EXHAUSTED",
        area: "billing_quota",
        recoveryClass: "GOVERNANCE_APPROVAL",
      }),
    ]);
    expect(projection.billingQuota.usage).toMatchObject({
      campaignsCreated: 10,
      maxCampaigns: 10,
    });
  });
});

describe("WBS-R5-F8 acceptance — auto-recovery and provider auth (F8.8, F8.9, F8.23)", () => {
  function autoRecoverSeed() {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    addCampaign(seed, 3001, 100, 10);
    seed.publishing_queue.push(
      queueItemRow({
        id: 6001,
        campaignId: 3001,
        status: "retrying",
        retryCount: 1,
        nextRetryAt: new Date(Date.now() + HOUR_MS),
      })
    );
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        listeningBinding({
          status: "active",
          lastFailureAt: new Date(Date.now() - HOUR_MS),
          lastFailureClass: "AUTO_RECOVER",
          lastFailureCode: "http_429",
        }),
      ],
    } as never);
    return seed;
  }

  it("F8.8 — rate-limit auto-recovery: AUTO_RECOVERING health, RATE_LIMITED/AUTO_RECOVER, action none", async () => {
    useSeed(autoRecoverSeed());

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("AUTO_RECOVERING");
    expect(projection.safeNextAction).toBe("none");
    expect(projection.engagement.retryingItems).toEqual([
      expect.objectContaining({ id: 6001 }),
    ]);
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "RATE_LIMITED",
        area: "listening",
        recoveryClass: "AUTO_RECOVER",
        safeNextAction: "none",
      }),
    ]);
  });

  it("F8.23 — AUTO_RECOVER remains non-human: no surfaced operator action", async () => {
    useSeed(autoRecoverSeed());

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    const rateLimited = projection.blockers.find((b) => b.blockerClass === "RATE_LIMITED");
    expect(rateLimited).toMatchObject({
      recoveryClass: "AUTO_RECOVER",
      safeNextAction: "none",
    });
    // The system retry owns the condition: the projection surfaces NO human
    // action for it (safeNextAction stays "none").
    expect(projection.safeNextAction).toBe("none");
    expect(
      projection.blockers.every(
        (b) => b.recoveryClass !== "AUTO_RECOVER" || b.safeNextAction === "none"
      )
    ).toBe(true);
  });

  it("F8.9 — expired provider credential: PROVIDER_AUTH_EXPIRED / reconnect action", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    seed.social_integrations.push({
      id: 8001,
      businessId: 10,
      userId: 100,
      platform: "instagram",
      status: "expired",
    });
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [listeningBinding({ status: "active" })],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.health).toBe("BLOCKED_OPERATOR");
    expect(projection.safeNextAction).toBe("reconnect_provider_integration");
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        blockerClass: "PROVIDER_AUTH_EXPIRED",
        area: "listening",
        recoveryClass: "OPERATOR_ACTION",
        safeNextAction: "reconnect_provider_integration",
      }),
    ]);
  });
});

describe("WBS-R5-F8 acceptance — operator authorization (F8.11-F8.14)", () => {
  it("F8.11 — unauthenticated rejected (UNAUTHORIZED); normal user rejected (FORBIDDEN)", async () => {
    useSeed(emptySeed());
    const anonymous = operationsRouter.createCaller(buildCtx(null));

    await expect(anonymous.getBusinessOperations({ businessId: 10 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anonymous.retryOperation({ operationKind: "terminal_failure", operationId: 501 })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const userCaller = operationsRouter.createCaller(buildCtx(NORMAL_USER));
    await expect(userCaller.getBusinessOperations({ businessId: 10 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      userCaller.retryOperation({ operationKind: "terminal_failure", operationId: 501 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("F8.12 — cross-business recovery assertion rejected (FORBIDDEN, no leak)", async () => {
    const seed = recoverySeed();
    useSeed(seed);

    await expect(
      adminCaller().retryOperation({
        operationKind: "publishing_queue_item",
        operationId: 5,
        businessId: 999,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "business assertion mismatch",
    });
    expect(seed.queue_replay_requests).toHaveLength(0);
    expect(seed.audit_events).toHaveLength(0);
  });

  it("F8.13 — admin cross-business operator read succeeds by design", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100, "Other Owners Business");
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expect(projection.business).toMatchObject({ id: 10, userId: 100 });
  });

  it("F8.14 — stale recovery rejected with bounded CONFLICT", async () => {
    useSeed(recoverySeed());

    await expect(
      adminCaller().retryOperation({
        operationKind: "publishing_queue_item",
        operationId: 5,
        expectedStatus: "published",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "stale operation state: expected published, current failed",
    });
  });
});

describe("WBS-R5-F8 acceptance — recovery convergence (F8.15, F8.16)", () => {
  it("F8.15 — duplicate recovery converges: requeued then already_recovering; exactly one replay request + one audit event", async () => {
    const seed = useSeed(recoverySeed());
    const caller = adminCaller();

    const first = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: 5,
      reason: "operator recovery",
    });
    expect(first).toMatchObject({ outcome: "requeued", currentStatus: "failed" });

    const second = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: 5,
      reason: "operator recovery",
    });
    expect(second).toMatchObject({
      outcome: "already_recovering",
      replayRequestId: first.replayRequestId,
    });

    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.queue_replay_requests[0]).toMatchObject({
      replayKey: "r5f:op-retry:pqi:5",
      requestedByUserId: 18,
      status: "requested",
    });
    expect(seed.audit_events).toHaveLength(1);
  });

  it("F8.16 — concurrent recovery converges on replayKey uniqueness without error", async () => {
    const seed = useSeed(recoverySeed());
    const caller = adminCaller();

    // Both calls are issued against the same durable terminal failure; the
    // second lands after the first commits and converges through the
    // fake-db's ER_DUP_ENTRY replayKey path — the same unique authority that
    // converges concurrent operators in production.
    const first = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: 501,
    });
    expect(first).toMatchObject({ outcome: "requeued" });

    const second = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: 501,
    });
    expect(second).toMatchObject({ outcome: "already_recovering" });

    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.queue_replay_requests[0]).toMatchObject({
      replayKey: "r5f:op-retry:tf:501",
    });
    expect(seed.audit_events).toHaveLength(1);
  });
});

describe("WBS-R5-F8 acceptance — audit ledger (F8.17, F8.18)", () => {
  it("F8.17 — exactly one canonical admin_mutation event with closed-vocabulary identity", async () => {
    const seed = useSeed(recoverySeed());

    await adminCaller().retryOperation({
      operationKind: "terminal_failure",
      operationId: 501,
      reason: "operator recovery",
    });

    expect(seed.audit_events).toHaveLength(1);
    expect(seed.audit_events[0]).toMatchObject({
      eventType: "admin_mutation",
      source: "admin",
      userId: ADMIN.id,
      outcome: "succeeded",
      businessId: 6,
      campaignId: 4,
    });
    expect(seed.audit_events[0].metadata).toMatchObject({
      action: "admin.r5_operation_retry",
      targetType: "r5_operation",
      targetId: "terminal_failure:501",
      outcome: "requeued",
      currentStatusBefore: "open",
    });
  });

  it("F8.18 — audit failure fails closed loudly; durable replay converges on retry", async () => {
    const seed = recoverySeed();
    seed.queue_terminal_failures.push(
      terminalFailureRow({ id: 551, publishingQueueItemId: null, campaignId: null })
    );
    useSeed(seed, { failAuditInsert: new Error("audit ledger unavailable") });
    const caller = adminCaller();

    await expect(
      caller.retryOperation({ operationKind: "terminal_failure", operationId: 551 })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    // The governed mutation committed but the endpoint refused success without
    // ledger evidence. The same call now converges on the durable replay row.
    const retry = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: 551,
    });
    expect(retry).toMatchObject({ outcome: "already_recovering" });
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.queue_replay_requests[0]).toMatchObject({
      terminalFailureId: 551,
      replayKey: "r5f:op-retry:tf:551",
    });
    expect(seed.audit_events).toHaveLength(0);
  });
});

describe("WBS-R5-F8 acceptance — secret hygiene (F8.19, F8.20)", () => {
  it("F8.19 — projection carries no tokens, credentials or payload material", async () => {
    const seed = emptySeed();
    addBusiness(seed, 10, 100);
    // Durable rows contain raw provider credential material; the column
    // allow-list must keep every variant out of the projection.
    seed.social_integrations.push({
      id: 8001,
      businessId: 10,
      userId: 100,
      platform: "instagram",
      status: "connected",
      accessTokenEncrypted: "accessToken-value-leak-check",
      refreshTokenEncrypted: "refreshToken-value-leak-check",
      pageAccessTokenEncrypted: "pageAccessToken-value-leak-check",
      passwordHash: "passwordHash-value-leak-check",
      webhookSecret: "whsec-value-leak-check",
    });
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [listeningBinding({ status: "active", lastFailureReason: null })],
    } as never);
    useSeed(seed);

    const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
    expectSecretFree(projection);
  });

  it("F8.20 — recovery responses and audit metadata carry no raw provider credentials", async () => {
    const seed = recoverySeed();
    seed.publishing_queue = [
      queueItemRow({ lastError: "raw provider body: accessToken=abc refreshToken=def secret=xyz" }),
    ];
    seed.queue_terminal_failures = [
      terminalFailureRow({ errorSummary: "credential material: Bearer ghi pageAccessToken=jkl" }),
    ];
    useSeed(seed);
    const caller = adminCaller();

    const replay = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: 5,
    });
    expectSecretFree(replay);

    const tfReplay = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: 501,
    });
    expectSecretFree(tfReplay);

    expect(seed.audit_events).toHaveLength(2);
    for (const event of seed.audit_events) {
      expectSecretFree(event.metadata);
    }
  });
});

describe("WBS-R5-F8 acceptance — forbidden recovery surface (F8.21, F8.22)", () => {
  it("F8.21 — policy denial cannot be overridden; no force/override procedure exists", async () => {
    const seed = recoverySeed();
    seed.publishing_queue = [queueItemRow({ status: "safety_blocked" })];
    useSeed(seed);

    await expect(
      adminCaller().retryOperation({ operationKind: "publishing_queue_item", operationId: 5 })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("approval flow"),
    });
    expect(seed.queue_replay_requests).toHaveLength(0);
    expect(seed.audit_events).toHaveLength(0);
    expectNoForbiddenProcedures();
  });

  it("F8.22 — terminal states cannot be force-reopened; no state setter exists", async () => {
    const seed = recoverySeed();
    seed.publishing_queue = [queueItemRow({ status: "published" })];
    seed.queue_terminal_failures = [terminalFailureRow({ status: "resolved" })];
    useSeed(seed);
    const caller = adminCaller();

    await expect(
      caller.retryOperation({ operationKind: "publishing_queue_item", operationId: 5 })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("duplicate publication"),
    });
    await expect(
      caller.retryOperation({ operationKind: "terminal_failure", operationId: 501 })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "terminal failure is not open" });

    expect(seed.queue_replay_requests).toHaveLength(0);
    expectNoForbiddenProcedures();
  });
});

describe("WBS-R5-F8 acceptance — operator next-action quality (F8.24)", () => {
  it("F8.24 — every blocked fixture surfaces a closed-vocabulary, human-readable next action", async () => {
    const fixtures: Array<{
      name: string;
      setup: (seed: Record<string, Record<string, unknown>[]>) => void;
      expectedAction: string;
      expectedClass: string;
    }> = [
      {
        name: "F8.3 ingestion blocked",
        setup: (seed) => {
          addBusiness(seed, 10, 100);
          mockedListening.mockResolvedValue({
            available: true,
            bindings: [
              listeningBinding({
                status: "blocked",
                lastFailureAt: new Date(Date.now() - HOUR_MS),
                lastFailureClass: "OPERATOR_ACTION",
                lastFailureCode: "webhook_disabled",
              }),
            ],
          } as never);
        },
        expectedAction: "requeue_stale_operation",
        expectedClass: "STALE_OPERATION",
      },
      {
        name: "F8.5 pending approval",
        setup: (seed) => {
          addBusiness(seed, 10, 100);
          seed.approval_requests.push({
            id: 9001,
            userId: 100,
            campaignId: null,
            status: "pending",
            approvalType: "sensitive_reply",
            riskLevel: "high",
            createdAt: new Date(),
          });
        },
        expectedAction: "inspect_pending_approval",
        expectedClass: "POLICY_REQUIRES_APPROVAL",
      },
      {
        name: "F8.6 budget exhausted",
        setup: (seed) => {
          addBusiness(seed, 10, 100);
          addCampaign(seed, 3001, 100, 10);
          seed.credit_wallets.push({ id: 1, userId: 100, balance: 0 });
        },
        expectedAction: "resume_budget_continuation",
        expectedClass: "BUDGET_EXHAUSTED",
      },
      {
        name: "F8.9 provider auth expired",
        setup: (seed) => {
          addBusiness(seed, 10, 100);
          seed.social_integrations.push({
            id: 8001,
            businessId: 10,
            userId: 100,
            platform: "instagram",
            status: "expired",
          });
          mockedListening.mockResolvedValue({
            available: true,
            bindings: [listeningBinding({ status: "active" })],
          } as never);
        },
        expectedAction: "reconnect_provider_integration",
        expectedClass: "PROVIDER_AUTH_EXPIRED",
      },
      {
        name: "F8.10 unsupported capability",
        setup: (seed) => {
          addBusiness(seed, 10, 100);
          mockedListening.mockResolvedValue({
            available: true,
            bindings: [listeningBinding({ mechanism: "unsupported", status: "unsupported" })],
          } as never);
        },
        expectedAction: "reconnect_provider_integration",
        expectedClass: "UNSUPPORTED_PROVIDER_CAPABILITY",
      },
    ];

    for (const fixture of fixtures) {
      mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
      const seed = emptySeed();
      fixture.setup(seed);
      useSeed(seed);

      const projection = await adminCaller().getBusinessOperations({ businessId: 10 });
      expect(projection.safeNextAction).toBe(fixture.expectedAction);
      expect(
        (R5_SAFE_NEXT_ACTIONS as readonly string[]).includes(projection.safeNextAction)
      ).toBe(true);
      expect(projection.safeNextAction).not.toBe("none");

      const matched = projection.blockers.find(
        (b) => b.safeNextAction === projection.safeNextAction
      );
      expect(matched).toBeDefined();
      expect(matched?.blockerClass).toBe(fixture.expectedClass);
      expect(matched!.evidence.length).toBeGreaterThan(10);
      expect(matched!.evidence).not.toContain("{");
      expect(matched!.evidence).not.toContain("}");
    }
  });
});

describe("WBS-R5-F8 acceptance — connected harness (end-to-end flow)", () => {
  it("fixture → projection → recovery where allowed → audit → updated projection", async () => {
    const seed = emptySeed();
    addBusiness(seed, 20, 200, "Connected Biz");
    addCampaign(seed, 2000, 200, 20);
    seed.publishing_queue.push(
      queueItemRow({ id: 6000, campaignId: 2000, status: "failed", lastError: null })
    );
    seed.queue_terminal_failures.push(
      terminalFailureRow({
        id: 7000,
        campaignId: 2000,
        publishingQueueItemId: 6000,
        userId: 200,
      })
    );
    seed.approval_requests.push({
      id: 9500,
      userId: 200,
      campaignId: null,
      status: "pending",
      approvalType: "strategy_review",
      riskLevel: "low",
      createdAt: new Date(),
    });
    mockedListening.mockResolvedValue({
      available: true,
      bindings: [
        listeningBinding({
          status: "blocked",
          lastFailureAt: new Date(Date.now() - HOUR_MS),
          lastFailureClass: "OPERATOR_ACTION",
          lastFailureCode: "webhook_disabled",
        }),
      ],
    } as never);
    useSeed(seed);
    const caller = adminCaller();

    // 1. Canonical projection of the blocked fixture.
    const before = await caller.getBusinessOperations({ businessId: 20 });
    expect(before.health).toBe("BLOCKED_OPERATOR");
    expect(before.queueRecovery.openTerminalFailureCount).toBe(1);
    expect(before.queueRecovery.openReplayRequestCount).toBe(0);
    expect(before.policy.pendingCount).toBe(1);
    expect(before.blockers.map((b) => b.blockerClass).sort()).toEqual(
      ["POLICY_REQUIRES_APPROVAL", "STALE_OPERATION", "STALE_OPERATION"].sort()
    );

    // 2. Governed recovery of the eligible piece (terminal replay).
    const recovery = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: 6000,
      businessId: 20,
      expectedStatus: "failed",
      reason: "operator terminal replay",
    });
    expect(recovery).toMatchObject({
      outcome: "requeued",
      operationId: 6000,
      currentStatus: "failed",
    });

    // 3. Exactly one canonical audit event for the real mutation.
    expect(seed.audit_events).toHaveLength(1);
    expect(seed.audit_events[0].metadata).toMatchObject({
      action: "admin.r5_operation_retry",
      targetType: "r5_operation",
      targetId: "publishing_queue_item:6000",
      outcome: "requeued",
    });
    expect(seed.queue_replay_requests).toHaveLength(1);

    // 4. Updated projection: replay intent recorded; governance approval and
    //    the listening blocker are NOT fabricated away by recovery.
    const after = await caller.getBusinessOperations({ businessId: 20 });
    expect(after.queueRecovery.openReplayRequestCount).toBe(1);
    expect(after.policy.pendingCount).toBe(1);
    expect(after.blockers.some((b) => b.blockerClass === "POLICY_REQUIRES_APPROVAL")).toBe(
      true
    );
    expect(
      after.blockers.some((b) => b.area === "listening" && b.blockerClass === "STALE_OPERATION")
    ).toBe(true);
    expect(after.health).toBe("BLOCKED_OPERATOR");
  });
});
