import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "./queries/connection";
import { createFakeDb, buildCtx } from "./r5-test-support";
import { leadGovernanceRouter } from "./lead-governance-router";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R6-F lead governance tests");
  }),
}));

vi.mock("./lib/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const ADMIN = { id: 7, role: "admin" };
// Deadlines are relative to the real clock: the router uses the current time.
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const ENV_KEY = "R6_LEAD_RECOVERY_ADMIN_ENABLED";
const ORIGINAL_ENV = process.env[ENV_KEY];

type Seed = Record<string, Record<string, unknown>[]>;

function seedWithPending(): Seed {
  return {
    businesses: [{ id: 10, userId: 7, name: "Acme" }],
    leads: [
      { id: 5, userId: 7, businessId: 10, status: "new", score: 0 },
      { id: 6, userId: 7, businessId: 10, status: "new", score: 0 },
      { id: 7, userId: 7, businessId: 10, status: "new", score: 0 },
    ],
    lead_privacy_states: [
      { id: 1, leadId: 5, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: PAST },
      { id: 2, leadId: 6, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: FUTURE },
      { id: 3, leadId: 7, userId: 7, businessId: 10, privacyState: "ACTIVE" },
    ],
    audit_events: [],
  };
}

function useSeed(seed: Seed, options?: { failAuditInsert?: Error }) {
  const fake = createFakeDb(seed, options);
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
  vi.mocked(getDb).mockReturnValue(fake.db as never);
  return fake;
}

describe("leadGovernance.retryOperation — governed recovery (F6/F7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[ENV_KEY] = "true";
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = ORIGINAL_ENV;
  });

  it("kill switch is default-off: recovery is unavailable without explicit enablement", async () => {
    delete process.env[ENV_KEY];
    useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "R6 lead recovery is disabled." });
  });

  it("unauthenticated and non-admin operators are rejected", async () => {
    useSeed(seedWithPending());
    const anon = leadGovernanceRouter.createCaller(buildCtx(null));
    await expect(
      anon.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const user = leadGovernanceRouter.createCaller(buildCtx({ id: 9, role: "user" }));
    await expect(
      user.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retention sweep expires due leads and audits exactly once", async () => {
    const fake = useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const result = await caller.retryOperation({
      operationKind: "retention_sweep",
      operationId: 10,
      reason: "scheduled retention reconciliation",
    });
    expect(result).toMatchObject({ outcome: "expired", evaluatedCount: 2, expiredCount: 1 });
    const row = fake.seed.lead_privacy_states.find((r) => r.leadId === 5);
    expect(row).toMatchObject({ privacyState: "RETENTION_EXPIRED", previousState: "RETENTION_PENDING" });
    const future = fake.seed.lead_privacy_states.find((r) => r.leadId === 6);
    expect(future).toMatchObject({ privacyState: "RETENTION_PENDING" });
    expect(fake.seed.audit_events).toHaveLength(1);
    expect(fake.seed.audit_events[0].metadata).toMatchObject({
      action: "admin.lead_retention_sweep",
      targetType: "lead_operation",
      targetId: "retention_sweep:10",
      evaluatedCount: 2,
      expiredCount: 1,
    });
  });

  it("duplicate recovery converges without a second audit event", async () => {
    const fake = useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 });
    const again = await caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 });
    expect(again).toMatchObject({ outcome: "converged", expiredCount: 0 });
    expect(fake.seed.audit_events).toHaveLength(1);
  });

  it("concurrent recoveries converge on durable CAS guards", async () => {
    const fake = useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const [a, b] = await Promise.all([
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 }),
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 }),
    ]);
    const totalExpired = a.expiredCount + b.expiredCount;
    expect(totalExpired).toBe(1);
    const expired = fake.seed.lead_privacy_states.find((r) => r.leadId === 5);
    expect(expired).toMatchObject({ privacyState: "RETENTION_EXPIRED" });
    // At most one real mutation ⇒ at most one audit event.
    expect(fake.seed.audit_events.length).toBeLessThanOrEqual(1);
  });

  it("stale expectedDueCount is rejected with CONFLICT", async () => {
    useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10, expectedDueCount: 5 })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "stale sweep state: expected 5 due, current 1",
    });
  });

  it("matching expectedDueCount proceeds (fresh recovery)", async () => {
    const fake = useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const result = await caller.retryOperation({
      operationKind: "retention_sweep",
      operationId: 10,
      expectedDueCount: 1,
    });
    expect(result).toMatchObject({ outcome: "expired", expiredCount: 1 });
    expect(fake.seed.audit_events).toHaveLength(1);
  });

  it("forged businessId is rejected (tenant binding re-derived server-side)", async () => {
    useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 9999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "business not found" });
  });

  it("audit failure rolls back the sweep (no unaudited mutation persists)", async () => {
    const fake = useSeed(seedWithPending(), { failAuditInsert: new Error("audit ledger unavailable") });
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    const row = fake.seed.lead_privacy_states.find((r) => r.leadId === 5);
    expect(row).toMatchObject({ privacyState: "RETENTION_PENDING" });
    expect(fake.seed.audit_events).toHaveLength(0);
  });

  it("schema-absent environment fails closed", async () => {
    const seed = seedWithPending();
    const fake = createFakeDb(seed);
    vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 0 }]] as never);
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const row = fake.seed.lead_privacy_states.find((r) => r.leadId === 5);
    expect(row).toMatchObject({ privacyState: "RETENTION_PENDING" });
  });

  it("recovery converges then the projection reflects the expired state", async () => {
    const fake = useSeed(seedWithPending());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await caller.retryOperation({ operationKind: "retention_sweep", operationId: 10 });
    const p = await caller.getLeadOperations({ leadId: 5 });
    expect(p.privacy.status).toBe("RETENTION_EXPIRED");
    expect(p.health).toBe("BLOCKED_OPERATOR");
    expect(p.blockers[0].blockerClass).toBe("RETENTION_EXPIRED");
    expect(p.operatorActionRequired).toBe(true);
  });
});
