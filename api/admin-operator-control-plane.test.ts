import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in operator control plane tests");
  }),
}));

vi.mock("./lib/workflow/budget-resume", () => ({
  resumeWorkflowAfterApprovedCostIncrease: vi.fn(),
}));

vi.mock("./lib/creative/creative-stale-claim-sweep", () => ({
  sweepStaleCreativeGenerationClaims: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { adminRouter } from "./admin-router";
import { resumeWorkflowAfterApprovedCostIncrease } from "./lib/workflow/budget-resume";
import { sweepStaleCreativeGenerationClaims } from "./lib/creative/creative-stale-claim-sweep";

const mockedResume = vi.mocked(resumeWorkflowAfterApprovedCostIncrease);
const mockedSweep = vi.mocked(sweepStaleCreativeGenerationClaims);

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      if (Array.isArray(value)) {
        if (!value.includes(row[chunk.name])) return false;
      } else if (row[chunk.name] !== value) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

function createFakeDb(seed: Record<string, Record<string, unknown>[]>) {
  const committed: { inserts: { table: string; values: Record<string, unknown> }[] } = { inserts: [] };
  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const rows = () => seed[name] ?? [];
        const chain: Record<string, unknown> = {
          where: (cond: unknown) => ({
            orderBy: () => ({
              limit: async (n: number) => rows().filter((r) => evalCond(cond, r)).slice(0, n),
            }),
            limit: async (n: number) => rows().filter((r) => evalCond(cond, r)).slice(0, n),
          }),
          orderBy: () => ({
            limit: async (n: number) => rows().slice(0, n),
          }),
          limit: async (n: number) => rows().slice(0, n),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        committed.inserts.push({ table: tableName(table), values });
        return [{ insertId: 1 }];
      },
    }),
  };
  return { db, committed };
}

function buildCtx(user: Record<string, unknown> | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: user ? { userId: user.id, type: "local", verified: true } : undefined,
  } as never;
}

const ADMIN = { id: 7, role: "admin" };
const auditRows = (committed: { inserts: { table: string; values: Record<string, unknown> }[] }) =>
  committed.inserts.filter((i) => i.table === "audit_events").map((i) => i.values);

const CAMPAIGN = {
  id: 42,
  userId: 18,
  businessId: 7,
  name: "Autumn Launch",
  status: "active",
  workflowState: "launch_approval_required",
  workflowContext: {},
  approvalMode: "assisted",
  autoPublish: false,
};

describe("operator control plane — authorization (F4/F5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["getCampaignLifecycle", (c: any) => c.getCampaignLifecycle({ campaignId: 42 })],
    ["resumeBudgetPausedCampaign", (c: any) => c.resumeBudgetPausedCampaign({ campaignId: 42 })],
    ["sweepStaleCreativeClaims", (c: any) => c.sweepStaleCreativeClaims({})],
  ] as const)("%s rejects unauthenticated callers", async (_name, call) => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    await expect(call(adminRouter.createCaller(buildCtx(null)) as never)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it.each([
    ["getCampaignLifecycle", (c: any) => c.getCampaignLifecycle({ campaignId: 42 })],
    ["resumeBudgetPausedCampaign", (c: any) => c.resumeBudgetPausedCampaign({ campaignId: 42 })],
    ["sweepStaleCreativeClaims", (c: any) => c.sweepStaleCreativeClaims({})],
  ] as const)("%s rejects verified non-admin callers", async (_name, call) => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    await expect(
      call(adminRouter.createCaller(buildCtx({ id: 9, role: "user" })) as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("operator control plane — lifecycle inspection (F3/F4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects malformed identifiers before any read", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = adminRouter.createCaller(buildCtx(ADMIN));
    await expect(caller.getCampaignLifecycle({ campaignId: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.getCampaignLifecycle({ campaignId: -3 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.resumeBudgetPausedCampaign({ campaignId: 1.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers why a campaign is not progressing, without any secret material", async () => {
    const fake = createFakeDb({
      campaigns: [{ ...CAMPAIGN, workflowContext: { campaignLiveAt: null } }],
      approval_requests: [
        { approvalType: "campaign_launch", status: "pending", campaignId: 42, createdAt: new Date("2026-10-20T00:00:00Z") },
      ],
      strategy_snapshots: [{ version: 1, snapshotId: "s-1", campaignId: 42, capturedAt: new Date() }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    const projection = await adminRouter.createCaller(buildCtx(ADMIN)).getCampaignLifecycle({ campaignId: 42 });

    expect(projection.campaign).toMatchObject({ id: 42, userId: 18 });
    expect(projection.status).toBe("blocked");
    expect(projection.blocker).toMatchObject({
      classification: "blocked",
      reason: "pending_launch_approval",
      recoverability: "recoverable_user_approval",
      safeNextAction: "inspect_pending_approval",
    });
    expect(projection.approvals.pendingTypes).toEqual(["campaign_launch"]);

    const serialized = JSON.stringify(projection);
    for (const forbidden of ["ownerToken", "password", "accessToken", "refreshToken", "secret"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("NOT_FOUND for an unknown campaign id (identifier tampering)", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    await expect(
      adminRouter.createCaller(buildCtx(ADMIN)).getCampaignLifecycle({ campaignId: 9999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("operator control plane — governed recovery (F4/F5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resumes via the governed continuation, deriving ownership from the campaign row", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume.mockResolvedValue({ outcome: "resumed", kind: "agent_run_complete", continuationId: 77 });

    const result = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .resumeBudgetPausedCampaign({ campaignId: 42 });

    expect(result).toEqual({ outcome: "resumed", kind: "agent_run_complete", continuationId: 77 });
    expect(mockedResume).toHaveBeenCalledWith({ userId: 18, campaignId: 42 });
    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.campaign_budget_resume",
      targetType: "campaign",
      targetId: 42,
      outcome: "resumed",
      kind: "agent_run_complete",
      continuationId: 77,
      campaignUserId: 18,
    });
  });

  it("surfaces still_blocked honestly and audits it", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume.mockResolvedValue({ outcome: "still_blocked", reason: "credits still insufficient" });

    const result = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .resumeBudgetPausedCampaign({ campaignId: 42 });

    expect(result.outcome).toBe("still_blocked");
    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      outcome: "still_blocked",
      stillBlockedReason: "credits still insufficient",
    });
  });

  it("unsupported manual override: a campaign with no cost pause is left untouched and unaudited", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume.mockResolvedValue(null);

    const result = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .resumeBudgetPausedCampaign({ campaignId: 42 });

    expect(result).toEqual({ outcome: "no_cost_pause" });
    expect(auditRows(fake.committed)).toHaveLength(0);
  });

  it("replayed recovery is retry-safe and audited each time", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume
      .mockResolvedValueOnce({ outcome: "resumed", kind: "strategy_approval", continuationId: 5 })
      .mockResolvedValueOnce({ outcome: "already_resumed" });
    const caller = adminRouter.createCaller(buildCtx(ADMIN));

    await caller.resumeBudgetPausedCampaign({ campaignId: 42 });
    await caller.resumeBudgetPausedCampaign({ campaignId: 42 });

    const rows = auditRows(fake.committed);
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata).toMatchObject({ outcome: "resumed" });
    expect(rows[1].metadata).toMatchObject({ outcome: "already_resumed" });
    // Distinct fingerprints: each privileged invocation is its own evidence.
    expect(rows[0].eventFingerprint).not.toBe(rows[1].eventFingerprint);
  });

  it("NOT_FOUND before delegating when the campaign does not exist", async () => {
    const fake = createFakeDb({ campaigns: [CAMPAIGN] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await expect(
      adminRouter.createCaller(buildCtx(ADMIN)).resumeBudgetPausedCampaign({ campaignId: 9999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockedResume).not.toHaveBeenCalled();
  });

  it("sweep validates its window and audits the governed report", async () => {
    const fake = createFakeDb({});
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const before = Date.now();
    mockedSweep.mockResolvedValue({
      staleBefore: new Date(before - 30 * 60_000).toISOString(),
      found: 2,
      healthyIgnored: 5,
      recovered: [{ claimId: 1, userId: 18, campaignId: 42, recoveryKind: "expired_lease" }],
      ambiguousLeftUntouched: [],
    });

    const caller = adminRouter.createCaller(buildCtx(ADMIN));
    await expect(caller.sweepStaleCreativeClaims({ staleBeforeMinutes: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.sweepStaleCreativeClaims({ staleBeforeMinutes: 24 * 60 + 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mockedSweep).not.toHaveBeenCalled();

    const report = await caller.sweepStaleCreativeClaims({});
    expect(report.found).toBe(2);
    expect(mockedSweep).toHaveBeenCalledTimes(1);
    const sweepArg = mockedSweep.mock.calls[0][0];
    const ageMs = before - (sweepArg.staleBefore as Date).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(ageMs).toBeLessThan(31 * 60_000);

    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.stale_creative_claim_sweep",
      found: 2,
      healthyIgnored: 5,
      recovered: 1,
      ambiguousLeftUntouched: 0,
    });
  });
});
