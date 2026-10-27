import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R6 readiness tests");
  }),
}));

vi.mock("./lib/redis", () => ({
  isRedisConfigured: vi.fn(() => false),
  getRedisClient: vi.fn(),
}));

vi.mock("./lib/queue/bullmq", () => ({
  getPublishingQueueStats: vi.fn(),
  getPublishingWorker: vi.fn(),
}));

vi.mock("./lib/alerts", () => ({
  createAlert: vi.fn().mockResolvedValue(undefined),
  listAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  resolveAlerts: vi.fn(),
  getAlertSummary: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lib/env", () => ({
  env: {
    postLiveLifecycleEnabled: false,
    postLiveLifecycleIntervalMs: 300_000,
    postLiveMetricsObservationEnabled: true,
    postLiveMetricsObservationIntervalMs: 300_000,
  },
}));

vi.mock("./lib/workflow/post-live-lifecycle-scheduler", () => ({
  getPostLiveLifecycleSchedulerStatus: vi.fn(),
}));

vi.mock("./lib/workflow/post-live-metrics-observation-scheduler", () => ({
  getPostLiveMetricsObservationSchedulerStatus: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { healthRouter } from "./health-router";
import { createFakeDb, buildCtx } from "./r5-test-support";

const ADMIN = { id: 7, role: "admin" };

type Seed = Record<string, Record<string, unknown>[]>;

function seed(): Seed {
  return {
    businesses: [{ id: 10, userId: 7, name: "Acme" }],
    leads: [
      { id: 5, userId: 7, businessId: 10, status: "new", score: 0 },
      { id: 6, userId: 7, businessId: 10, status: "contacted", score: 0 },
    ],
    lead_privacy_states: [
      { id: 1, leadId: 6, userId: 7, businessId: 10, privacyState: "SUPPRESSED" },
    ],
    audit_events: [],
  };
}

function useSeed(s: Seed) {
  const fake = createFakeDb(s);
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
  vi.mocked(getDb).mockReturnValue(fake.db as never);
  return fake;
}

describe("health.getR6LeadGovernanceReadiness (F4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unauthenticated and non-admin callers are rejected", async () => {
    useSeed(seed());
    const anon = healthRouter.createCaller(buildCtx(null));
    await expect(anon.getR6LeadGovernanceReadiness()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const user = healthRouter.createCaller(buildCtx({ id: 9, role: "user" }));
    await expect(user.getR6LeadGovernanceReadiness()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reports stream components unavailable (honest) and privacy governance attention", async () => {
    useSeed(seed());
    const caller = healthRouter.createCaller(buildCtx(ADMIN));
    const readiness = await caller.getR6LeadGovernanceReadiness();
    expect(readiness.components.identity).toBe("unavailable");
    expect(readiness.components.scoring).toBe("unavailable");
    expect(readiness.components.qualification).toBe("unavailable");
    expect(readiness.components.nurture).toBe("unavailable");
    expect(readiness.components.salesHandoff).toBe("unavailable");
    expect(readiness.components.conversion).toBe("unavailable");
    expect(readiness.components.privacyGovernance).toBe("attention");
    expect(readiness.counters.leadsTotal).toBe(2);
    expect(readiness.counters.privacySuppressed).toBe(1);
    expect(readiness.counters.retentionExpired).toBe(0);
    expect(readiness.topBlockedBusinesses).toEqual([
      expect.objectContaining({ businessId: 10, blockedLeads: 1 }),
    ]);
  });

  it("blocked when a retention-expired lead exists", async () => {
    const s = seed();
    s.lead_privacy_states.push({ id: 2, leadId: 5, userId: 7, businessId: 10, privacyState: "RETENTION_EXPIRED" });
    useSeed(s);
    const caller = healthRouter.createCaller(buildCtx(ADMIN));
    const readiness = await caller.getR6LeadGovernanceReadiness();
    expect(readiness.components.privacyGovernance).toBe("blocked");
    expect(readiness.counters.retentionExpired).toBe(1);
  });

  it("ready when no privacy overlay exists", async () => {
    const s = seed();
    s.lead_privacy_states = [];
    useSeed(s);
    const caller = healthRouter.createCaller(buildCtx(ADMIN));
    const readiness = await caller.getR6LeadGovernanceReadiness();
    expect(readiness.components.privacyGovernance).toBe("ready");
    expect(readiness.counters.privacySuppressed).toBe(0);
  });

  it("carries no PII or secrets in the readiness payload", async () => {
    const s = seed();
    s.leads[0].email = "canary@example.com";
    s.leads[0].name = "Canary RealName";
    useSeed(s);
    const caller = healthRouter.createCaller(buildCtx(ADMIN));
    const readiness = await caller.getR6LeadGovernanceReadiness();
    const text = JSON.stringify(readiness);
    expect(text).not.toContain("canary@example.com");
    expect(text).not.toContain("Canary RealName");
    expect(text).not.toMatch(/accessToken|refreshToken|password|secret/i);
  });
});
