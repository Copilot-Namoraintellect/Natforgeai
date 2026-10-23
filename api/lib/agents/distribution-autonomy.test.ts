import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

vi.mock("./runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [], suggestedFixes: [] })),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runAgent } from "./runner";
import { runDistributionAgent, DISTRIBUTION_PLATFORMS } from "./distribution-agent";
import { buildDistributionBillingIdentity } from "../workflow/agent-billing-identity";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function makeReleasePackage(campaignId: number, userId: number, postIds: number[], fingerprint = "brieffp1") {
  return {
    packageId: `crp:${campaignId}:${fingerprint}`,
    packageFingerprintSha256: createHash("sha256").update("pkg").digest("hex"),
    campaignId,
    userId,
    creativeBriefFingerprint: fingerprint,
    strategy: {
      strategySnapshotId: "snap-1",
      strategyVersion: 1,
      businessDnaSnapshotId: "dna-1",
      strategyHashSha256: createHash("sha256").update("s").digest("hex"),
      strategyRunId: 11,
      approvalRequestId: 12,
      creativeBriefFingerprint: fingerprint,
    },
    artefacts: postIds.map((id) => ({
      kind: "leaflet",
      recordType: "content_post",
      recordId: id,
      title: `Post ${id}`,
      creativeBriefFingerprint: fingerprint,
    })),
    quality: { renderedLeafletReady: true },
    sealedAtIso: "2026-06-29T00:00:00.000Z",
    sealedBy: "creative-agent",
    supersedesPackageId: null,
    legacyArtefactIds: [],
    supersededArtefactIds: [],
  };
}

/**
 * Fake DB for the distribution agent: captures queue inserts and the
 * workflow-context write; serves configurable campaigns, posts, recorded runs
 * and existing queue rows.
 */
function createDistributionDb({
  campaign,
  posts,
  recordedRun = null,
  existingQueueRows = [],
}: {
  campaign: Record<string, unknown> | null;
  posts: Array<Record<string, unknown>>;
  recordedRun?: Record<string, unknown> | null;
  existingQueueRows?: Array<{ id?: number; contentPostId: number | null; platform: string | null; status?: string }>;
}) {
  const queueInserts: unknown[] = [];
  const approvalInserts: unknown[] = [];
  const updates: Array<{ table: string; values: unknown }> = [];

  const whereResult = (table: unknown) => {
    const name = getTableName(table) ?? "";
    let limitResult: unknown[] = [];
    let rowsResult: unknown[] | null = null;

    if (name === "campaigns") limitResult = campaign ? [campaign] : [];
    else if (name === "agent_runs") limitResult = recordedRun ? [recordedRun] : [];
    else if (name === "content_posts") rowsResult = posts;

    return {
      limit: vi.fn(async () => limitResult),
      then: (resolve: (value: unknown[]) => unknown) =>
        resolve(rowsResult ?? limitResult),
    };
  };

  const db = {
    select: vi.fn((fields?: unknown) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const name = getTableName(table) ?? "";
          if (name === "publishing_queue") {
            return {
              then: (resolve: (value: unknown[]) => unknown) => resolve(existingQueueRows),
            };
          }
          return whereResult(table);
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const name = getTableName(table) ?? "";
        if (name === "publishing_queue") queueInserts.push(values);
        else if (name === "approval_requests") approvalInserts.push(values);
        return Promise.resolve([{ insertId: 1000 + queueInserts.length }]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          updates.push({ table: getTableName(table) ?? "unknown", values });
          return [];
        }),
      })),
    })),
  } as never;

  return { db, queueInserts, approvalInserts, updates };
}

const POSTS = [
  { id: 501, userId: 42, campaignId: 29, title: "Launch post", platform: "facebook", type: "social", hook: "H", caption: "C", cta: "Go" },
  { id: 502, userId: 42, campaignId: 29, title: "Story", platform: "instagram", type: "social", hook: "H2", caption: "C2", cta: "Go2" },
];

function baseCampaign(workflowContext: Record<string, unknown> = {}) {
  return {
    id: 29,
    userId: 42,
    businessId: 5,
    name: "Summer drop",
    goal: "awareness",
    platforms: "facebook,instagram",
    workflowContext,
  };
}

const SCHEDULE = {
  schedule: [
    { contentPostId: 501, platform: "facebook", scheduledAt: "2027-03-01T10:00:00Z" },
    { contentPostId: 502, platform: "instagram", scheduledAt: "2027-03-01T11:00:00Z" },
  ],
};

describe("runDistributionAgent distribution autonomy (WBS-R4 C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the durable governed plan under the caller-stable billing identity", async () => {
    const { db, queueInserts, updates } = createDistributionDb({
      campaign: baseCampaign(),
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 610, output: SCHEDULE } as any);

    const billingIdentity = buildDistributionBillingIdentity({ campaignId: 29, audienceRunId: 505 });
    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
      billingIdentity,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toMatchObject({
      agentType: "distribution",
      billingIdempotencyKey: billingIdentity,
    });
    expect(queueInserts).toHaveLength(2);
    expect(result.queueIds).toEqual([1001, 1002]);
    expect(result.replayed).toBe(false);

    // Canonical schedule authority resolved the instants before persistence.
    expect((queueInserts[0] as { scheduledAt: Date }).scheduledAt.toISOString()).toBe(
      "2027-03-01T10:00:00.000Z"
    );

    // The durable plan coordinates bind campaign, user, content, platform.
    for (const row of queueInserts as Array<Record<string, unknown>>) {
      expect(row.userId).toBe(42);
      expect(row.campaignId).toBe(29);
      expect(row.maxRetries).toBe(3);
      expect(["approved", "pending_approval", "safety_blocked"]).toContain(row.status);
    }

    const campaignUpdate = updates.find((u) => u.table === "campaigns");
    const context = (campaignUpdate!.values as { workflowContext: Record<string, unknown> })
      .workflowContext;
    expect(context.distributionRunId).toBe(610);
    expect(context.distributionBillingKey).toBe(billingIdentity);
    expect(context.scheduledPosts).toBe(2);
  });

  it("collapses a duplicate keyed trigger onto the authoritative plan (no new rows, no LLM, no charge)", async () => {
    const billingIdentity = buildDistributionBillingIdentity({ campaignId: 29, audienceRunId: 505 });
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign({
        distributionRunId: 610,
        distributionBillingKey: billingIdentity,
      }),
      posts: POSTS,
      recordedRun: { id: 610, userId: 42, campaignId: 29, agentType: "distribution", status: "completed" },
      existingQueueRows: [
        { id: 1001, contentPostId: 501, platform: "facebook" },
        { id: 1002, contentPostId: 502, platform: "instagram" },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
      billingIdentity,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(queueInserts).toHaveLength(0);
    expect(result.replayed).toBe(true);
    expect(result.queueIds.slice().sort()).toEqual([1001, 1002]);
  });

  it("re-enters (fail-closed retry) when the recorded run did not complete", async () => {
    const billingIdentity = buildDistributionBillingIdentity({ campaignId: 29, audienceRunId: 505 });
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign({
        distributionRunId: 610,
        distributionBillingKey: billingIdentity,
      }),
      posts: POSTS,
      recordedRun: { id: 610, userId: 42, campaignId: 29, agentType: "distribution", status: "failed" },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 611, output: SCHEDULE } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
      billingIdentity,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(queueInserts).toHaveLength(2);
    expect(result.runId).toBe(611);
  });

  it("skips LLM-proposed content post ids that do not belong to this user/campaign", async () => {
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign(),
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 612,
      output: {
        schedule: [
          { contentPostId: 501, platform: "facebook", scheduledAt: "2027-03-01T10:00:00Z" },
          { contentPostId: 999, platform: "facebook", scheduledAt: "2027-03-01T10:00:00Z" },
        ],
      },
    } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    // The tampered/foreign id never becomes an executable row.
    expect(queueInserts).toHaveLength(1);
    expect((queueInserts[0] as { contentPostId: number }).contentPostId).toBe(501);
    expect(result.skipped).toEqual([
      { contentPostId: 999, platform: "facebook", reason: "unknown_content_post" },
    ]);
  });

  it("skips unsupported platforms (fail closed at plan time)", async () => {
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign(),
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 613,
      output: {
        schedule: [
          { contentPostId: 501, platform: "pinterest", scheduledAt: "2027-03-01T10:00:00Z" },
          { contentPostId: 502, platform: "instagram", scheduledAt: "2027-03-01T11:00:00Z" },
        ],
      },
    } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    expect(queueInserts).toHaveLength(1);
    expect((queueInserts[0] as { platform: string }).platform).toBe("instagram");
    expect(result.skipped).toEqual([
      { contentPostId: 501, platform: "pinterest", reason: "unsupported_platform" },
    ]);
    expect(DISTRIBUTION_PLATFORMS).not.toContain("pinterest");
  });

  it("does not duplicate a live queue row for the same post+platform", async () => {
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign(),
      posts: POSTS,
      existingQueueRows: [{ contentPostId: 501, platform: "facebook" }],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 614, output: SCHEDULE } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    expect(queueInserts).toHaveLength(1);
    expect((queueInserts[0] as { contentPostId: number }).contentPostId).toBe(502);
    expect(result.skipped).toEqual([
      { contentPostId: 501, platform: "facebook", reason: "duplicate_live_queue_row" },
    ]);
  });

  it("constrains scheduling to the sealed release package when one is released", async () => {
    const release = makeReleasePackage(29, 42, [501]);
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign({ creativeReleasePackage: release }),
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 615, output: SCHEDULE } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    expect(queueInserts).toHaveLength(1);
    expect((queueInserts[0] as { contentPostId: number }).contentPostId).toBe(501);
    expect(result.skipped).toEqual([
      { contentPostId: 502, platform: "instagram", reason: "outside_release_package" },
    ]);
  });

  it("falls back to existing gates when the sealed package is absent or malformed", async () => {
    const malformed = { ...makeReleasePackage(29, 42, [501]), packageId: "crp:29:TAMPERED" };
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign({ creativeReleasePackage: malformed }),
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 616, output: SCHEDULE } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    // Fail-closed per contract §3: tampered package reads as not released;
    // the existing per-item gates remain authoritative (both rows planned).
    expect(queueInserts).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it("rejects cross-business invocation (campaign owned by another user)", async () => {
    const { db, queueInserts } = createDistributionDb({
      campaign: null, // owner-scoped lookup returns nothing for user 42
      posts: POSTS,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await expect(
      runDistributionAgent({ userId: 42, campaignId: 29, approvalMode: "autonomous" })
    ).rejects.toThrow("Campaign not found");
    expect(runAgent).not.toHaveBeenCalled();
    expect(queueInserts).toHaveLength(0);
  });

  it("manual (unkeyed) invocation executes even when a keyed plan exists", async () => {
    const billingIdentity = buildDistributionBillingIdentity({ campaignId: 29, audienceRunId: 505 });
    const { db, queueInserts } = createDistributionDb({
      campaign: baseCampaign({
        distributionRunId: 610,
        distributionBillingKey: billingIdentity,
      }),
      posts: POSTS,
      existingQueueRows: [{ contentPostId: 501, platform: "facebook" }],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({ runId: 617, output: SCHEDULE } as any);

    const result = await runDistributionAgent({
      userId: 42,
      campaignId: 29,
      approvalMode: "autonomous",
    });

    // Manual click = new billable operation by design; only the exact
    // post+platform live row is protected from duplication.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0]).not.toHaveProperty("billingIdempotencyKey");
    expect(queueInserts).toHaveLength(1);
    expect((queueInserts[0] as { contentPostId: number }).contentPostId).toBe(502);
    expect(result.replayed).toBe(false);
  });
});
