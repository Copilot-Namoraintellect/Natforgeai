/**
 * R4-F5 — Governance / Operator Acceptance Suite.
 *
 * Fourteen adversarial acceptance scenarios proving the governance
 * invariants end to end. Where a scenario is covered in depth by a
 * dedicated suite (admin audit ledger, operator control plane), this file
 * re-asserts it compactly so a single suite enumerates the full contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in governance acceptance tests");
  }),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => {}),
}));

vi.mock("./lib/workflow/budget-resume", () => ({
  resumeWorkflowAfterApprovedCostIncrease: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { adminRouter } from "./admin-router";
import { campaignRouter } from "./campaign-router";
import { businessRouter } from "./business-router";
import { approvalRouter } from "./approval-router";
import { publishingRouter } from "./publishing-router";
import { learningPromotionRouter } from "./learning-promotion-router";
import { resumeWorkflowAfterApprovedCostIncrease } from "./lib/workflow/budget-resume";
import { materializeGovernedBusinessDna } from "./lib/business-dna-governance";
import { buildGroundedCreativeBrief } from "./lib/creative/brief-grounding";
import { isLineageAuthoritative } from "./lib/workflow/strategy-approval";
import { isLaunchApprovalEvidenceUsable } from "./lib/workflow/launch-approval";
import { assertCreativeArtifactLineageMatchesEnvelope } from "./lib/creative/artifact-lineage";
import { detectEvidenceDrift, isSuperseded } from "./lib/learning/learning-record-authority";

const mockedResume = vi.mocked(resumeWorkflowAfterApprovedCostIncrease);

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

/** Fake drizzle with condition evaluation, op logging and tx staging. */
function createFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { audit_events: [], ...seed };
  const committed: { inserts: { table: string; values: Record<string, unknown> }[] } = { inserts: [] };
  const ops: string[] = [];
  let nextInsertId = 700;

  const makeClient = (prefix: string, staging: typeof committed | null) => ({
    select: () => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const rows = () => tables[name] ?? [];
        const makeResult = (cond: unknown) => {
          const filtered = () => rows().filter((r) => evalCond(cond, r));
          const result: Record<string, unknown> = {
            orderBy: () => ({
              limit: async (n: number) => filtered().slice(0, n),
            }),
            limit: async (n: number) => {
              ops.push(`${prefix}select:${name}`);
              return filtered().slice(0, n);
            },
          };
          // Some queries await the where() result directly (thenable builder).
          result.then = (onFulfilled: unknown, onRejected: unknown) =>
            Promise.resolve(filtered()).then(onFulfilled as never, onRejected as never);
          return result;
        };
        const chain: Record<string, unknown> = {
          where: (cond: unknown) => makeResult(cond),
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
        const name = tableName(table);
        ops.push(`${prefix}insert:${name}`);
        const insertId = nextInsertId++;
        (staging ?? committed).inserts.push({ table: name, values });
        return [{ insertId }];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const name = tableName(table);
          ops.push(`${prefix}update:${name}`);
          mutations.push({ kind: "update", table: name, cond, values });
          const matched = (tables[name] ?? []).filter((r) => evalCond(cond, r)).length;
          return Promise.resolve([{ affectedRows: matched }]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = tableName(table);
        ops.push(`${prefix}delete:${name}`);
        mutations.push({ kind: "delete", table: name, cond });
        const matched = (tables[name] ?? []).filter((r) => evalCond(cond, r)).length;
        return Promise.resolve([{ affectedRows: matched }]);
      },
    }),
  });

  const mutations: { kind: string; table: string; cond: unknown; values?: Record<string, unknown> }[] = [];

  const db = {
    ...makeClient("", null),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const staging: typeof committed = { inserts: [] };
      const result = await cb(makeClient("tx:", staging));
      committed.inserts.push(...staging.inserts);
      return result;
    },
  };
  return { db, committed, ops, mutations };
}

function buildCtx(user: Record<string, unknown> | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: user ? { userId: user.id, type: "local", verified: true } : undefined,
  } as never;
}

const USER_A = { id: 18, role: "user" };
const USER_B = { id: 33, role: "user" };
const ADMIN = { id: 7, role: "admin" };

beforeEach(() => vi.clearAllMocks());

// 1 & 2 — authentication and role authorization on the operator surface.
describe("F5.1/F5.2 — operator surface fails closed on identity and role", () => {
  it.each([
    ["getCampaignLifecycle", (c: any) => c.getCampaignLifecycle({ campaignId: 42 })],
    ["resumeBudgetPausedCampaign", (c: any) => c.resumeBudgetPausedCampaign({ campaignId: 42 })],
    ["sweepStaleCreativeClaims", (c: any) => c.sweepStaleCreativeClaims({})],
    ["updateUserRole", (c: any) => c.updateUserRole({ userId: 42, role: "admin" })],
  ] as const)("%s: unauthenticated → UNAUTHORIZED, non-admin → FORBIDDEN", async (_name, call) => {
    const fake = createFakeDb({ campaigns: [{ id: 42, userId: 18 }] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    await expect(call(adminRouter.createCaller(buildCtx(null)) as never)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      call(adminRouter.createCaller(buildCtx({ id: 9, role: "user" })) as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// 3 — cross-business access across user surfaces.
describe("F5.3 — cross-business access is rejected or inert everywhere", () => {
  it("campaign read/update/delete for user A against user B's campaign", async () => {
    const fake = createFakeDb({
      campaigns: [
        { id: 42, userId: 33, name: "B campaign", status: "active", workflowState: "strategy_pending" },
      ],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = campaignRouter.createCaller(buildCtx(USER_A));

    expect(await caller.get({ id: 42 })).toBeNull();

    // The protection is the owner-scoped WHERE: no mutation issued for user
    // A can match user B's campaign row.
    const bCampaign = { id: 42, userId: 33 };

    const updateRes = await caller.update({ id: 42, name: "hijacked" });
    expect(updateRes).toMatchObject({ success: true });
    for (const mutation of fake.mutations.filter((m) => m.kind === "update" && m.table === "campaigns")) {
      expect(evalCond(mutation.cond, bCampaign)).toBe(false);
    }

    const deleteRes = await caller.delete({ id: 42 });
    expect(deleteRes).toMatchObject({ success: true });
    for (const mutation of fake.mutations.filter((m) => m.kind === "delete" && m.table === "campaigns")) {
      expect(evalCond(mutation.cond, bCampaign)).toBe(false);
    }
  });

  it("approval decision, publishing approval and learning promotion against foreign rows", async () => {
    const fake = createFakeDb({
      approval_requests: [
        { id: 5, userId: 33, campaignId: 42, status: "pending", approvalType: "campaign_launch" },
      ],
      publishing_queue: [{ id: 9, userId: 33, campaignId: 42, status: "pending_approval" }],
      learning_records: [{ id: 3, userId: 33, campaignId: 42 }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await expect(
      approvalRouter.createCaller(buildCtx(USER_A)).approveAction({ approvalId: 5 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      publishingRouter.createCaller(buildCtx(USER_A)).approvePost({ queueId: 9 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      learningPromotionRouter
        .createCaller(buildCtx(USER_A))
        .propose({ learningRecordId: 3, recommendationId: "rec-1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("business profile and Business DNA ownership boundaries", async () => {
    const fake = createFakeDb({
      businesses: [{ id: 11, userId: 33, name: "B business", isActive: true }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = businessRouter.createCaller(buildCtx(USER_A));

    const updateRes = await caller.update({ id: 11, name: "hijacked" });
    expect(updateRes).toMatchObject({ success: true });
    for (const mutation of fake.mutations.filter((m) => m.kind === "update" && m.table === "businesses")) {
      expect(evalCond(mutation.cond, { id: 11, userId: 33 })).toBe(false);
    }

    await expect(
      materializeGovernedBusinessDna({ userId: USER_A.id, businessId: 11 })
    ).rejects.toThrow(/not found/i);
  });
});

// 4 — identifier tampering.
describe("F5.4 — malformed and tampered identifiers fail closed", () => {
  it("wrong-typed identifiers are rejected by schema validation", async () => {
    const fake = createFakeDb({ campaigns: [{ id: 42, userId: 18 }] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await expect(
      campaignRouter.createCaller(buildCtx(USER_A)).get({ id: "abc" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      publishingRouter.createCaller(buildCtx(USER_A)).approvePost({ queueId: "9" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      adminRouter.createCaller(buildCtx(ADMIN)).getCampaignLifecycle({ campaignId: 0 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("out-of-range numeric identifiers on legacy endpoints grant no access", async () => {
    const fake = createFakeDb({
      campaigns: [{ id: 42, userId: 33, status: "active", workflowState: "strategy_pending" }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = campaignRouter.createCaller(buildCtx(USER_A));
    expect(await caller.get({ id: -1 })).toBeNull();
    expect(await caller.get({ id: 2 ** 40 })).toBeNull();
  });
});

// 5 — stale Strategy authority (pure authority layer).
describe("F5.5 — stale Strategy authority is never authoritative", () => {
  const campaign = { id: 42, userId: 18, coreMessage: "Original brief" };
  const fingerprint = buildGroundedCreativeBrief({ campaign }).fingerprint;
  const context = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: 900,
      strategySnapshotId: "snap-1",
      strategyVersion: 1,
      businessDnaSnapshotId: "dna-1",
      strategyHashSha256: "hash-1",
      approvalRequestId: 7,
      status: "approved",
    },
  };

  it("current lineage is authoritative", () => {
    expect(isLineageAuthoritative({ ...campaign, workflowContext: context }, { strategyRunId: 900 })).toBe(true);
  });

  it("a changed brief (fingerprint drift) makes the lineage stale", () => {
    const drifted = { ...campaign, coreMessage: "Changed brief" };
    expect(isLineageAuthoritative({ ...drifted, workflowContext: context }, { strategyRunId: 900 })).toBe(false);
  });

  it("a forged strategy run id is not authoritative", () => {
    expect(isLineageAuthoritative({ ...campaign, workflowContext: context }, { strategyRunId: 999 })).toBe(false);
  });
});

// 6 — creative lineage mismatch.
describe("F5.6 — creative lineage mismatch fails closed against the envelope", () => {
  const persisted = {
    schemaVersion: 1,
    artifactKind: "message_pack",
    artifactId: 5,
    strategy: {
      strategySnapshotId: "snap-1",
      strategyVersion: 1,
      businessDnaSnapshotId: "dna-1",
      strategyHashSha256: "hash-1",
      strategyRunId: 900,
      approvalRequestId: 7,
      creativeBriefFingerprint: "fp-1",
    },
    approvedCopy: {
      copyHashSha256: "copy-hash",
      copySchemaVersion: 1,
      approvedRevisionId: 3,
      assessmentHashSha256: "assess-hash",
      contextLockId: "lock-1",
    },
  };
  const envelope = {
    copyHashSha256: "copy-hash",
    copySchemaVersion: 1,
    approvedRevisionId: 3,
    assessmentHashSha256: "assess-hash",
    contextLockId: "lock-1",
    campaignStrategySnapshotId: "snap-1",
    strategyHashSha256: "hash-1",
    businessDnaSnapshotId: "dna-1",
  };

  it("matching lineage is accepted", () => {
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(persisted as never, envelope as never)
    ).not.toThrow();
  });

  it("tampered approved-copy coordinates are rejected", () => {
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(persisted as never, {
        ...envelope,
        copyHashSha256: "attacker-hash",
      } as never)
    ).toThrow();
  });

  it("tampered Strategy snapshot coordinates are rejected", () => {
    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(
        {
          ...persisted,
          strategy: { ...persisted.strategy, strategySnapshotId: "snap-forged" },
        } as never,
        envelope as never
      )
    ).toThrow();
  });
});

// 7 — launch/package authority mismatch.
describe("F5.7 — launch approval evidence mismatch fails closed", () => {
  const fingerprint = buildGroundedCreativeBrief({ campaign: { id: 42, coreMessage: "Brief" } }).fingerprint;
  const campaign = {
    id: 42,
    userId: 18,
    coreMessage: "Brief",
    workflowContext: {
      launchApprovalLineage: {
        creativeBriefFingerprint: fingerprint,
        approvalRequestId: 21,
        status: "approved",
      },
    },
  };
  const approval = {
    id: 21,
    campaignId: 42,
    userId: 18,
    approvalType: "campaign_launch",
    status: "approved",
  };

  it("corroborated launch evidence is usable", () => {
    expect(isLaunchApprovalEvidenceUsable(campaign, approval)).toBe(true);
  });

  it("a bare row pointing at a different request, a pending row, or another campaign is not usable", () => {
    expect(isLaunchApprovalEvidenceUsable(campaign, { ...approval, id: 22 })).toBe(false);
    expect(isLaunchApprovalEvidenceUsable(campaign, { ...approval, status: "pending" })).toBe(false);
    expect(isLaunchApprovalEvidenceUsable(campaign, { ...approval, campaignId: 43 })).toBe(false);
  });
});

// 8 — learning provenance mismatch.
describe("F5.8 — learning evidence drift and supersession surface honestly", () => {
  const record = {
    id: 1,
    campaignId: 42,
    evaluationVersion: "v1",
    windowStart: "2026-10-01",
    windowEnd: "2026-10-07",
    provenance: { inputDigest: "" },
  };

  it("evidence arriving after evaluation is drift", () => {
    const observationsA = [{ id: "obs-a" }] as never;
    const baseline = detectEvidenceDrift(record as never, observationsA);
    const withStoredDigest = {
      ...record,
      provenance: { inputDigest: baseline.recomputedDigest },
    };
    expect(detectEvidenceDrift(withStoredDigest as never, observationsA).drifted).toBe(false);
    expect(detectEvidenceDrift(withStoredDigest as never, [{ id: "obs-b" }] as never).drifted).toBe(true);
  });

  it("a newer record for the same campaign supersedes the older one", () => {
    const older = { id: 1, campaignId: 42, evaluationVersion: "v1", windowEnd: "2026-10-07", windowStart: "2026-10-01" } as never;
    const newer = { id: 2, campaignId: 42, evaluationVersion: "v2", windowEnd: "2026-10-14", windowStart: "2026-10-08" } as never;
    expect(isSuperseded(older, [newer])).toBe(true);
    expect(isSuperseded(newer, [older])).toBe(false);
  });
});

// 9 — admin mutation cannot bypass the audit ledger.
describe("F5.9 — a privileged mutation rolls back when its audit cannot persist", () => {
  it("updateUserRole: audit insert failure → rollback, zero committed evidence", async () => {
    const fake = createFakeDb({ users: [{ id: 42, role: "user" }] });
    const failingDb = {
      ...fake.db,
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        const staging = { inserts: [] as { table: string; values: Record<string, unknown> }[] };
        try {
          return await cb({
            select: fake.db.select,
            update: fake.db.update,
            delete: fake.db.delete,
            insert: (table: unknown) => ({
              values: async (values: Record<string, unknown>) => {
                if (tableName(table) === "audit_events") throw new Error("audit write failed");
                staging.inserts.push({ table: tableName(table), values });
                return [{ insertId: 1 }];
              },
            }),
          });
        } finally {
          // Never commit on failure.
          void staging;
        }
      },
    };
    vi.mocked(getDb).mockReturnValue(failingDb as never);

    await expect(
      adminRouter.createCaller(buildCtx(ADMIN)).updateUserRole({ userId: 42, role: "admin" })
    ).rejects.toThrow("audit write failed");
    expect(fake.committed.inserts).toHaveLength(0);
  });
});

// 10 — replayed privileged mutation is retry-safe and fully audited.
describe("F5.10 — replayed privileged mutation is retry-safe", () => {
  it("a retried resume is idempotent and each invocation is audited", async () => {
    const fake = createFakeDb({ campaigns: [{ id: 42, userId: 18 }] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume
      .mockResolvedValueOnce({ outcome: "resumed", kind: "agent_run_complete", continuationId: 7 })
      .mockResolvedValueOnce({ outcome: "already_resumed" });
    const caller = adminRouter.createCaller(buildCtx(ADMIN));

    await caller.resumeBudgetPausedCampaign({ campaignId: 42 });
    await caller.resumeBudgetPausedCampaign({ campaignId: 42 });

    const audits = fake.committed.inserts.filter((i) => i.table === "audit_events");
    expect(audits).toHaveLength(2);
    expect(audits[0].values.metadata).toMatchObject({ outcome: "resumed" });
    expect(audits[1].values.metadata).toMatchObject({ outcome: "already_resumed" });
    expect(audits[0].values.eventFingerprint).not.toBe(audits[1].values.eventFingerprint);
  });
});

// 11 — unsupported manual overrides do not exist.
describe("F5.11 — no force-state / manual-override authority exists", () => {
  it("the admin surface exposes no force/override/setter procedures", () => {
    const procedures = Object.keys((adminRouter as any)._def?.procedures ?? {});
    expect(procedures.length).toBeGreaterThan(0);
    for (const name of procedures) {
      expect(/force|override|setState|set_workflow|markComplete/i.test(name)).toBe(false);
    }
    // And the governed no-pause path changes nothing.
    expect(procedures).toContain("resumeBudgetPausedCampaign");
    expect(procedures).toContain("getCampaignLifecycle");
  });

  it("resuming a campaign without a cost pause is a safe no-op with no audit noise", async () => {
    const fake = createFakeDb({ campaigns: [{ id: 42, userId: 18 }] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume.mockResolvedValue(null);
    const res = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .resumeBudgetPausedCampaign({ campaignId: 42 });
    expect(res).toEqual({ outcome: "no_cost_pause" });
    expect(fake.committed.inserts).toHaveLength(0);
  });
});

// 12 — secret/token exposure attempts find nothing.
describe("F5.12 — operator reads expose no secret material", () => {
  it("lifecycle projection and admin user rows serialize zero credentials", async () => {
    const fake = createFakeDb({
      campaigns: [
        {
          id: 42,
          userId: 18,
          businessId: 11,
          name: "Campaign",
          status: "active",
          workflowState: "launch_approval_required",
          workflowContext: {},
          approvalMode: "assisted",
          autoPublish: false,
        },
      ],
      approval_requests: [
        { approvalType: "campaign_launch", status: "pending", campaignId: 42, createdAt: new Date() },
      ],
      users: [
        {
          id: 18,
          username: "user18",
          email: "u@example.com",
          name: "User",
          role: "user",
          authType: "local",
          passwordHash: "$2b$12$credentialexamplehash",
          firebaseUid: "uid-secret",
          googleId: "gid-secret",
          lastSignInAt: new Date(),
          createdAt: new Date(),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    const caller = adminRouter.createCaller(buildCtx(ADMIN));

    const projection = await caller.getCampaignLifecycle({ campaignId: 42 });
    const users = await caller.users({});

    const serialized = JSON.stringify({ projection, users });
    for (const forbidden of [
      "passwordHash",
      "firebaseUid",
      "googleId",
      "ownerToken",
      "accessToken",
      "refreshToken",
      "credential",
      "$2b$12$credentialexamplehash",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// 13 — valid operator lifecycle inspection.
describe("F5.13 — valid operator lifecycle inspection answers the blocker question", () => {
  it("returns the full projection for a launch-gated campaign", async () => {
    const fake = createFakeDb({
      campaigns: [
        {
          id: 42,
          userId: 18,
          businessId: 11,
          name: "Campaign",
          status: "active",
          workflowState: "launch_approval_required",
          workflowContext: {},
          approvalMode: "assisted",
          autoPublish: false,
        },
      ],
      approval_requests: [
        { approvalType: "campaign_launch", status: "pending", campaignId: 42, createdAt: new Date() },
      ],
      strategy_snapshots: [{ version: 2, snapshotId: "s-2", campaignId: 42, capturedAt: new Date() }],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    const projection = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .getCampaignLifecycle({ campaignId: 42 });

    expect(projection.status).toBe("blocked");
    expect(projection.blocker.reason).toBe("pending_launch_approval");
    expect(projection.blocker.recoverability).toBe("recoverable_user_approval");
    expect(projection.strategy.latestVersion).toBe(2);
  });
});

// 14 — valid governed recovery action.
describe("F5.14 — valid governed recovery resumes through the existing continuation", () => {
  it("resumes a cost-paused campaign and records canonical evidence", async () => {
    const fake = createFakeDb({ campaigns: [{ id: 42, userId: 18 }] });
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    mockedResume.mockResolvedValue({ outcome: "resumed", kind: "strategy_approval", continuationId: 11 });

    const res = await adminRouter
      .createCaller(buildCtx(ADMIN))
      .resumeBudgetPausedCampaign({ campaignId: 42 });

    expect(res.outcome).toBe("resumed");
    expect(mockedResume).toHaveBeenCalledWith({ userId: 18, campaignId: 42 });
    const [audit] = fake.committed.inserts.filter((i) => i.table === "audit_events");
    expect(audit.values.metadata).toMatchObject({
      action: "admin.campaign_budget_resume",
      outcome: "resumed",
      kind: "strategy_approval",
    });
  });
});
