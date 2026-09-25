import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDb } from "../../../queries/connection";
import { loadCampaignPerformanceDataset } from "./loader";
import {
  assemblePublishPackage,
  type PublishPackage,
} from "../../publish/publish-package-contract";
import { serializePublishPackageForQueue } from "../../publish/publish-package-queue-store";

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const strategyCoords = {
  strategySnapshotId: "strategy_abc",
  strategyVersion: 3,
  businessDnaSnapshotId: "shadow-bdna-5-xyz",
  strategyHashSha256: SHA_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief-fingerprint-1",
};

const approvedCopy = {
  copyHashSha256: SHA_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: SHA_C,
  contextLockId: "lock-1",
};

function makePackage(platform: string, contentPostId: number): PublishPackage {
  return assemblePublishPackage({
    identity: {
      campaignId: 7,
      userId: 22,
      businessId: 5,
      destination: { platform, integrationId: 9 },
      intent: { mode: "immediate", scheduledAtIso: null },
      strategyAuthority: strategyCoords,
      approvedCopy,
      selectedContent: {
        artifactKind: "platform_caption",
        artifactId: contentPostId,
        lineageFingerprintSha256: SHA_D,
        strategy: strategyCoords,
        approvedCopy,
      },
      captionArtifact: null,
      visualArtifact: null,
      evidence: { launchApprovalRequestId: 88 },
    },
    classification: "governed",
    legacyReasons: [],
    payload: { text: "Hello world", mediaUrls: [], mediaType: null },
    createdAtIso: "2026-05-01T10:00:00Z",
  });
}

const creativeLineage = {
  lineageSchemaVersion: 1,
  artifactKind: "platform_caption",
  platform: "instagram",
  parent: { artifactKind: "message_pack", artifactId: 500 },
  lineageFingerprintSha256: SHA_D,
  strategy: strategyCoords,
  approvedCopy,
};

function workflowContext(status: string) {
  return {
    strategyApprovalLineage: {
      creativeBriefFingerprint: "brief-fingerprint-1",
      strategyRunId: 55,
      strategySnapshotId: "strategy_abc",
      strategyVersion: 3,
      businessDnaSnapshotId: "shadow-bdna-5-xyz",
      strategyHashSha256: SHA_A,
      approvalRequestId: 77,
      status,
    },
  };
}

function createTables(overrides: Record<string, unknown[]> = {}) {
  const campaign = {
    id: 7,
    userId: 22,
    businessId: 5,
    goal: "Drive bookings",
    primaryOutcome: "drive online bookings",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    workflowContext: workflowContext("approved"),
  };
  const analyticsRows = [
    { id: 1, metricType: "impressions", platform: "instagram", value: 10000, date: "2026-05-01" },
    { id: 2, metricType: "clicks", platform: "instagram", value: 300, date: "2026-05-02" },
    { id: 3, metricType: "conversions", platform: null, value: 12, date: "2026-05-15" },
  ];
  return {
    campaigns: [campaign],
    analytics: analyticsRows,
    strategy_snapshots: [
      {
        id: 300,
        snapshotId: "strategy_abc",
        userId: 22,
        campaignId: 7,
        businessId: 5,
        strategyRunId: 55,
        businessDnaSnapshotId: "shadow-bdna-5-xyz",
        version: 3,
        creativeBriefFingerprint: "brief-fingerprint-1",
        strategyHashSha256: SHA_A,
        snapshot: { funnelStages: [{ stage: "awareness", metrics: ["impressions"] }] },
        capturedAt: "2026-04-20T00:00:00Z",
      },
    ],
    approval_requests: [{ id: 77, userId: 22, status: "approved", approvedAt: "2026-04-21T00:00:00Z" }],
    publishing_queue: [
      {
        id: 401,
        userId: 22,
        campaignId: 7,
        contentPostId: 101,
        integrationId: 9,
        platform: "instagram",
        scheduledAt: "2026-05-01T09:00:00Z",
        status: "published",
        publishedAt: "2026-05-01T10:00:00Z",
        externalPostId: "ext-ig-1",
        retryCount: 0,
        maxRetries: 3,
        approvalRequired: false,
        metadata: serializePublishPackageForQueue(makePackage("instagram", 101)),
      },
      {
        id: 402,
        userId: 22,
        campaignId: 7,
        contentPostId: 102,
        integrationId: null,
        platform: "tiktok",
        scheduledAt: null,
        status: "published",
        publishedAt: "2026-05-02T10:00:00Z",
        externalPostId: "ext-tt-1",
        retryCount: 0,
        maxRetries: 3,
        approvalRequired: false,
        metadata: null,
      },
    ],
    audit_events: [
      {
        id: 1301,
        eventType: "publication_success",
        campaignId: 7,
        metadata: {
          publicationReceipt: {
            queueItemId: 401,
            externalUrl: "https://cdn.example.com/ext-ig-1",
          },
        },
      },
    ],
    content_posts: [
      {
        id: 101,
        userId: 22,
        campaignId: 7,
        title: "IG Post",
        type: "social_post",
        platform: "instagram",
        status: "published",
        publishedAt: "2026-05-01T10:00:00Z",
        metadata: { approved: true, creativeArtifactLineage: creativeLineage },
      },
      {
        id: 102,
        userId: 22,
        campaignId: 7,
        title: "TikTok Post",
        type: "social_post",
        platform: "tiktok",
        status: "published",
        publishedAt: "2026-05-02T10:00:00Z",
        metadata: {},
      },
      {
        id: 104,
        userId: 22,
        campaignId: 7,
        title: "Manual Post",
        type: "social_post",
        platform: "linkedin",
        status: "published",
        publishedAt: "2026-05-04T10:00:00Z",
        metadata: { publishMode: "manual" },
      },
    ],
    social_engagement_events: [
      {
        id: 501,
        userId: 22,
        campaignId: 7,
        platform: "instagram",
        eventType: "like",
        externalContentId: "ext-ig-1",
        eventTimestamp: "2026-05-01T12:00:00Z",
      },
      {
        id: 503,
        userId: 22,
        campaignId: null,
        platform: "instagram",
        eventType: "like",
        externalContentId: null,
        eventTimestamp: "2026-05-01T12:00:00Z",
      },
    ],
    leads: [
      { id: 601, userId: 22, campaignId: 7, status: "won", createdAt: "2026-05-10T00:00:00Z" },
      { id: 603, userId: 22, campaignId: null, status: "won", createdAt: "2026-05-11T00:00:00Z" },
    ],
    ai_usage: [
      {
        id: 701,
        userId: 22,
        campaignId: 7,
        agentType: "creative",
        model: "gpt-4o-mini",
        actualCostUsd: 2_500_000,
        creditsDeducted: 100,
        createdAt: "2026-05-05T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

function createMockDb(tables: Record<string, unknown[]>) {
  const state = {
    selectTables: [] as string[],
    insertTables: [] as string[],
    updateTables: [] as string[],
    deleteTables: [] as string[],
  };
  const chainFor = (rows: unknown[]) => {
    const chain: any = {
      limit: vi.fn(async (n: number) => rows.slice(0, n)),
      orderBy: vi.fn(() => chain),
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table) ?? "";
        state.selectTables.push(name);
        return {
          where: vi.fn(() => chainFor(tables[name] ?? [])),
          orderBy: vi.fn(() => chainFor(tables[name] ?? [])),
          then: (resolve: any, reject: any) =>
            Promise.resolve(tables[name] ?? []).then(resolve, reject),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => {
      state.insertTables.push(getTableName(table) ?? "unknown");
      return { values: vi.fn() };
    }),
    update: vi.fn((table: unknown) => {
      state.updateTables.push(getTableName(table) ?? "unknown");
      return { set: vi.fn(() => ({ where: vi.fn(async () => []) })) };
    }),
    delete: vi.fn((table: unknown) => {
      state.deleteTables.push(getTableName(table) ?? "unknown");
      return { where: vi.fn(async () => []) };
    }),
  };
  return db as any;
}

describe("loadCampaignPerformanceDataset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assembles the canonical dataset from persisted rows", async () => {
    const db = createMockDb(createTables());
    vi.mocked(getDb).mockReturnValue(db);

    const dataset = await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });

    expect(dataset.identity.window).toEqual({ start: "2026-05-01", end: "2026-05-31" });
    expect(dataset.strategyAuthority.status).toBe("approved");
    expect(dataset.strategyAuthority.snapshot?.snapshotId).toBe("strategy_abc");
    expect(dataset.strategyAuthority.approval.approvedAt).toBe("2026-04-21T00:00:00Z");
    expect(dataset.strategyAuthority.successMetrics.metrics).toEqual(["impressions"]);

    const kinds = dataset.publications.map((p) => `${p.kind}:${p.lineage}`).sort();
    expect(kinds).toEqual(["manual:legacy", "queue:governed", "queue:legacy"]);
    const governed = dataset.publications.find((p) => p.lineage === "governed");
    expect(governed?.package?.packageId).toBe(makePackage("instagram", 101).packageId);
    expect(governed?.provider.externalUrl).toBe("https://cdn.example.com/ext-ig-1");
    expect(governed?.creativeLineage?.lineageFingerprintSha256).toBe(SHA_D);

    expect(dataset.outcomes.observations.map((o) => o.id)).toEqual(["ao:1", "ao:2", "ao:3"]);
    expect(dataset.engagement.inWindowEventCount).toBe(1);
    expect(dataset.engagement.unlinkedEventCount).toBe(1);
    expect(dataset.leads.leadIds).toEqual([601]);
    expect(dataset.leads.conversionsWon).toBe(1);
    expect(dataset.spend.totalCostUsd).toBe("2.5");
    expect(dataset.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is read-only: selects only, never insert/update/delete", async () => {
    const db = createMockDb(createTables());
    vi.mocked(getDb).mockReturnValue(db);

    await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });

    expect(db.state.insertTables).toEqual([]);
    expect(db.state.updateTables).toEqual([]);
    expect(db.state.deleteTables).toEqual([]);
    expect(db.state.selectTables.length).toBeGreaterThan(0);
  });

  it("prefers the explicit evaluation window", async () => {
    const db = createMockDb(createTables());
    vi.mocked(getDb).mockReturnValue(db);

    const dataset = await loadCampaignPerformanceDataset({
      userId: 22,
      campaignId: 7,
      windowStart: "2026-05-10",
      windowEnd: "2026-05-20",
    });

    expect(dataset.identity.window).toEqual({ start: "2026-05-10", end: "2026-05-20" });
    expect(dataset.outcomes.observations.map((o) => o.id)).toEqual(["ao:3"]);
  });

  it("falls back to the observed analytics span when the campaign has no dates", async () => {
    const tables = createTables({
      campaigns: [
        {
          id: 7,
          userId: 22,
          businessId: 5,
          goal: "Drive bookings",
          primaryOutcome: "drive online bookings",
          startDate: null,
          endDate: null,
          workflowContext: workflowContext("approved"),
        },
      ],
    });
    const db = createMockDb(tables);
    vi.mocked(getDb).mockReturnValue(db);

    const dataset = await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });

    expect(dataset.identity.window).toEqual({ start: "2026-05-01", end: "2026-05-15" });
  });

  it("throws NOT_FOUND when the campaign does not belong to the user", async () => {
    const db = createMockDb(createTables({ campaigns: [] }));
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws BAD_REQUEST when no evaluation window can be resolved", async () => {
    const tables = createTables({
      campaigns: [
        {
          id: 7,
          userId: 22,
          businessId: 5,
          goal: "Drive bookings",
          primaryOutcome: null,
          startDate: null,
          endDate: null,
          workflowContext: null,
        },
      ],
      analytics: [],
      strategy_snapshots: [],
      approval_requests: [],
    });
    const db = createMockDb(tables);
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is deterministic across identical loads", async () => {
    const db = createMockDb(createTables());
    vi.mocked(getDb).mockReturnValue(db);

    const a = await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });
    const b = await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.identity.fingerprint).toBe(b.identity.fingerprint);
  });
});
