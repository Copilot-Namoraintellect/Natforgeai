import { describe, expect, it } from "vitest";
import {
  buildCampaignPerformanceDataset,
  computePerformanceDatasetFingerprint,
  microUsdToDecimalString,
  PERFORMANCE_DATASET_SCHEMA_VERSION,
  type CampaignPerformanceDataset,
} from "./dataset";
import type {
  AiUsageSource,
  ContentPostSource,
  EngagementEventSource,
  LeadSource,
  ManualPublicationSource,
  PerformanceDatasetInput,
  QueuePublicationSource,
} from "./sources";
import {
  assemblePublishPackage,
  type PublishPackage,
} from "../../publish/publish-package-contract";
import { serializePublishPackageForQueue } from "../../publish/publish-package-queue-store";
import { buildPersistedCreativeArtifactLineage } from "../../creative/artifact-lineage";

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

const creativeLineage = buildPersistedCreativeArtifactLineage({
  artifactKind: "platform_caption",
  platform: "instagram",
  parent: { artifactKind: "message_pack", artifactId: 500 },
  strategy: strategyCoords,
  approvedCopy,
});

const contentPosts: ContentPostSource[] = [
  {
    id: 101,
    title: "IG Post",
    type: "social_post",
    platform: "instagram",
    status: "published",
    metadata: { approved: true, creativeArtifactLineage: creativeLineage },
  },
  {
    id: 102,
    title: "TikTok Post",
    type: "social_post",
    platform: "tiktok",
    status: "published",
    metadata: { creativeArtifactLineage: creativeLineage },
  },
  { id: 103, title: "FB Post", type: "social_post", platform: "facebook", status: "published", metadata: {} },
  { id: 104, title: "Manual Post", type: "social_post", platform: "linkedin", status: "published", metadata: { publishMode: "manual" } },
];

function governedQueuePub(
  id: number,
  platform: string,
  contentPostId: number,
  externalPostId: string
): QueuePublicationSource {
  return {
    id,
    contentPostId,
    platform,
    status: "published",
    scheduledAt: "2026-05-01T09:00:00Z",
    publishedAt: "2026-05-01T10:00:00Z",
    externalPostId,
    metadata: serializePublishPackageForQueue(makePackage(platform, contentPostId)),
    receiptExternalUrl: `https://cdn.example.com/${externalPostId}`,
    receiptAuditEventId: 900 + id,
  };
}

function baseInput(overrides: Partial<PerformanceDatasetInput> = {}): PerformanceDatasetInput {
  return {
    campaign: {
      id: 7,
      userId: 22,
      businessId: 5,
      goal: "Drive bookings",
      primaryOutcome: "drive online bookings",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      workflowContext: {
        strategyApprovalLineage: {
          creativeBriefFingerprint: "brief-fingerprint-1",
          strategyRunId: 55,
          strategySnapshotId: "strategy_abc",
          strategyVersion: 3,
          businessDnaSnapshotId: "shadow-bdna-5-xyz",
          strategyHashSha256: SHA_A,
          approvalRequestId: 77,
          status: "approved",
        },
      },
    },
    window: { start: "2026-05-01", end: "2026-05-31" },
    strategySnapshot: {
      id: 300,
      snapshotId: "strategy_abc",
      strategyRunId: 55,
      businessDnaSnapshotId: "shadow-bdna-5-xyz",
      version: 3,
      creativeBriefFingerprint: "brief-fingerprint-1",
      strategyHashSha256: SHA_A,
      snapshot: {
        funnelStages: [
          { stage: "awareness", metrics: ["impressions", "reach"] },
          { stage: "conversion", metrics: ["conversions", "impressions"] },
        ],
      },
      capturedAt: "2026-04-20T00:00:00Z",
    },
    strategyApproval: { id: 77, status: "approved", approvedAt: "2026-04-21T00:00:00Z" },
    publications: [
      governedQueuePub(401, "instagram", 101, "ext-ig-1"),
      governedQueuePub(402, "tiktok", 102, "ext-tt-1"),
      {
        id: 403,
        contentPostId: 103,
        platform: "facebook",
        status: "published",
        scheduledAt: null,
        publishedAt: "2026-05-03T10:00:00Z",
        externalPostId: "ext-fb-1",
        metadata: null,
      },
      {
        id: 404,
        contentPostId: null,
        platform: "twitter",
        status: "failed",
        scheduledAt: null,
        publishedAt: null,
        externalPostId: null,
        metadata: null,
      },
    ],
    manualPublications: [
      { contentPostId: 104, platform: "linkedin", publishedAt: "2026-05-04T10:00:00Z", metadata: { publishMode: "manual" } },
    ],
    contentPosts,
    analyticsRows: [
      { id: 1, metricType: "impressions", platform: "instagram", value: 10000, date: "2026-05-01" },
      { id: 2, metricType: "clicks", platform: "instagram", value: 300, date: "2026-05-02" },
      { id: 3, metricType: "conversions", platform: null, value: 12, date: "2026-05-15" },
      { id: 4, metricType: "impressions", platform: "tiktok", value: 5000, date: "2026-06-01" },
    ],
    engagementEvents: [
      { id: 501, campaignId: 7, platform: "instagram", eventType: "like", externalContentId: "ext-ig-1", eventTimestamp: "2026-05-01T12:00:00Z" },
      { id: 502, campaignId: 7, platform: "instagram", eventType: "comment", externalContentId: "ext-ig-1", eventTimestamp: "2026-05-02T12:00:00Z" },
      { id: 503, campaignId: null, platform: "instagram", eventType: "like", externalContentId: null, eventTimestamp: "2026-05-01T12:00:00Z" },
      { id: 504, campaignId: 7, platform: "tiktok", eventType: "share", externalContentId: "ext-tt-1", eventTimestamp: "2026-04-10T12:00:00Z" },
    ],
    leads: [
      { id: 601, campaignId: 7, status: "won", createdAt: "2026-05-10T00:00:00Z" },
      { id: 602, campaignId: 7, status: "new", createdAt: "2026-05-12T00:00:00Z" },
      { id: 603, campaignId: null, status: "won", createdAt: "2026-05-11T00:00:00Z" },
      { id: 604, campaignId: 7, status: "won", createdAt: "2026-06-10T00:00:00Z" },
    ],
    aiUsageRows: [
      { id: 701, campaignId: 7, agentType: "creative", model: "gpt-4o-mini", actualCostUsd: 2_500_000, creditsDeducted: 100, createdAt: "2026-05-05T00:00:00Z" },
      { id: 702, campaignId: null, agentType: "strategy", model: "gpt-4o-mini", actualCostUsd: 1_000_000, creditsDeducted: 40, createdAt: "2026-05-05T00:00:00Z" },
    ],
    ...overrides,
  };
}

function build(overrides: Partial<PerformanceDatasetInput> = {}): CampaignPerformanceDataset {
  return buildCampaignPerformanceDataset(baseInput(overrides));
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      out.push(key);
      allStrings((value as Record<string, unknown>)[key], out);
    }
  }
  return out;
}

describe("determinism", () => {
  it("produces a byte-identical dataset and fingerprint for identical inputs", () => {
    const a = build();
    const b = build();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.identity.fingerprint).toBe(b.identity.fingerprint);
    expect(a.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent: shuffled source rows yield the same fingerprint", () => {
    const input = baseInput();
    const shuffled: PerformanceDatasetInput = {
      ...input,
      publications: [...(input.publications ?? [])].reverse(),
      analyticsRows: [...(input.analyticsRows ?? [])].reverse(),
      engagementEvents: [...(input.engagementEvents ?? [])].reverse(),
      leads: [...(input.leads ?? [])].reverse(),
      aiUsageRows: [...(input.aiUsageRows ?? [])].reverse(),
      contentPosts: [...(input.contentPosts ?? [])].reverse(),
    };
    const a = buildCampaignPerformanceDataset(input);
    const b = buildCampaignPerformanceDataset(shuffled);
    expect(a.identity.fingerprint).toBe(b.identity.fingerprint);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fingerprint matches the canonical digest of the dataset without identity.fingerprint", () => {
    const dataset = build();
    const { fingerprint, ...identity } = dataset.identity;
    expect(computePerformanceDatasetFingerprint({ ...dataset, identity })).toBe(fingerprint);
  });
});

describe("identity", () => {
  it("carries schema version, campaign, user, business and window", () => {
    const dataset = build();
    expect(dataset.identity).toMatchObject({
      schemaVersion: PERFORMANCE_DATASET_SCHEMA_VERSION,
      campaignId: 7,
      userId: 22,
      businessId: 5,
      window: { start: "2026-05-01", end: "2026-05-31" },
    });
  });

  it("rejects malformed or inverted windows", () => {
    expect(() => build({ window: { start: "2026-05-01", end: "nope" } })).toThrowError(
      expect.objectContaining({ code: "BAD_REQUEST" })
    );
    expect(() => build({ window: { start: "2026-05-31", end: "2026-05-01" } })).toThrowError(
      expect.objectContaining({ code: "BAD_REQUEST" })
    );
  });
});

describe("strategy authority", () => {
  it("captures snapshot coordinates, objective and funnel metric hints with provenance", () => {
    const dataset = build();
    const authority = dataset.strategyAuthority;
    expect(authority.status).toBe("approved");
    expect(authority.snapshot).toEqual({
      snapshotId: "strategy_abc",
      strategyVersion: 3,
      strategyHashSha256: SHA_A,
      strategyRunId: 55,
      businessDnaSnapshotId: "shadow-bdna-5-xyz",
      creativeBriefFingerprint: "brief-fingerprint-1",
      capturedAt: "2026-04-20T00:00:00Z",
    });
    expect(authority.approval).toEqual({
      approvalRequestId: 77,
      lineageStatus: "approved",
      requestStatus: "approved",
      approvedAt: "2026-04-21T00:00:00Z",
    });
    expect(authority.objective).toEqual({ text: "drive online bookings", source: "primaryOutcome" });
    // deduped, first-seen order, honest about being hints rather than thresholds
    expect(authority.successMetrics).toEqual({
      available: true,
      metrics: ["impressions", "reach", "conversions"],
      source: "strategy_snapshot_funnel_metrics",
    });
    expect(authority.provenance).toContainEqual({ table: "strategy_snapshots", id: 300 });
    expect(authority.provenance).toContainEqual({
      table: "campaigns",
      id: 7,
      column: "workflowContext.strategyApprovalLineage",
    });
    expect(authority.provenance).toContainEqual({ table: "approval_requests", id: 77 });
  });

  it("falls back to the campaign goal when primaryOutcome is absent", () => {
    const input = baseInput();
    const campaign = { ...input.campaign, primaryOutcome: null };
    const dataset = build({ campaign });
    expect(dataset.strategyAuthority.objective).toEqual({ text: "Drive bookings", source: "goal" });
  });

  it("surfaces missing required strategy authority", () => {
    const dataset = build({ strategySnapshot: null, strategyApproval: null });
    expect(dataset.strategyAuthority.status).toBe("missing");
    expect(dataset.strategyAuthority.snapshot).toBeNull();
    const issue = dataset.readiness.issues.find((i) => i.code === "strategy_authority_missing");
    expect(issue?.severity).toBe("required");
    expect(dataset.readiness.status).toBe("authority_missing");
    expect(dataset.readiness.requiredIssueCount).toBe(1);
  });

  it("surfaces an unapproved strategy snapshot as a required issue", () => {
    const input = baseInput();
    const campaign = {
      ...input.campaign,
      workflowContext: {
        strategyApprovalLineage: {
          ...(input.campaign.workflowContext as Record<string, Record<string, unknown>>)
            .strategyApprovalLineage,
          status: "pending",
        },
      },
    };
    const dataset = build({ campaign });
    expect(dataset.strategyAuthority.status).toBe("unapproved");
    const issue = dataset.readiness.issues.find((i) => i.code === "strategy_approval_missing");
    expect(issue?.severity).toBe("required");
    expect(dataset.readiness.status).toBe("authority_missing");
  });
});

describe("published artifacts", () => {
  it("represents each platform publication independently", () => {
    const dataset = build();
    const queuePubs = dataset.publications.filter((p) => p.kind === "queue");
    expect(queuePubs).toHaveLength(3);
    const platforms = queuePubs.map((p) => p.queue?.platform).sort();
    expect(platforms).toEqual(["facebook", "instagram", "tiktok"]);
    const instagram = dataset.publications.find((p) => p.queue?.platform === "instagram");
    const tiktok = dataset.publications.find((p) => p.queue?.platform === "tiktok");
    expect(instagram?.provider.externalPostId).toBe("ext-ig-1");
    expect(tiktok?.provider.externalPostId).toBe("ext-tt-1");
    expect(instagram?.artifactId).not.toBe(tiktok?.artifactId);
    // The failed queue row is not a publication.
    expect(dataset.publications.some((p) => p.queue?.queueItemId === 404)).toBe(false);
  });

  it("retains governed publication lineage: package, strategy authority, approved copy, receipt", () => {
    const dataset = build();
    const instagram = dataset.publications.find((p) => p.queue?.platform === "instagram");
    expect(instagram?.lineage).toBe("governed");
    const expectedPackage = makePackage("instagram", 101);
    expect(instagram?.package?.packageId).toBe(expectedPackage.packageId);
    expect(instagram?.package?.packageFingerprintSha256).toBe(
      expectedPackage.packageFingerprintSha256
    );
    expect(instagram?.package?.classification).toBe("governed");
    expect(instagram?.package?.strategyAuthority?.strategySnapshotId).toBe("strategy_abc");
    expect(instagram?.package?.approvedCopy?.copyHashSha256).toBe(SHA_B);
    expect(instagram?.provider.externalUrl).toBe("https://cdn.example.com/ext-ig-1");
    expect(instagram?.content).toEqual({
      contentPostId: 101,
      title: "IG Post",
      type: "social_post",
      platform: "instagram",
      status: "published",
    });
    expect(instagram?.creativeLineage?.lineageFingerprintSha256).toBe(
      creativeLineage.lineageFingerprintSha256
    );
    expect(instagram?.provenance).toContainEqual({ table: "publishing_queue", id: 401 });
    expect(instagram?.provenance).toContainEqual({ table: "content_posts", id: 101 });
    expect(instagram?.provenance).toContainEqual({ table: "audit_events", id: 1301 });
  });

  it("classifies package-less queue publications explicitly as legacy", () => {
    const dataset = build();
    const facebook = dataset.publications.find((p) => p.queue?.platform === "facebook");
    expect(facebook?.lineage).toBe("legacy");
    expect(facebook?.package).toBeNull();
    const issue = dataset.readiness.issues.find(
      (i) => i.code === "publication_lineage_incomplete" && i.subject?.id === 403
    );
    expect(issue?.severity).toBe("optional");
    expect(issue?.message).toContain("legacy");
  });

  it("classifies governed-marked rows with a missing/tampered package as invalid_package", () => {
    const input = baseInput();
    const publications: QueuePublicationSource[] = [
      {
        id: 410,
        contentPostId: 101,
        platform: "instagram",
        status: "published",
        scheduledAt: null,
        publishedAt: "2026-05-05T10:00:00Z",
        externalPostId: "ext-x-1",
        metadata: { publishPackageRequired: true },
      },
    ];
    const dataset = buildCampaignPerformanceDataset({ ...input, publications });
    const pub = dataset.publications.find((p) => p.queue?.queueItemId === 410);
    expect(pub?.lineage).toBe("invalid_package");
    const issue = dataset.readiness.issues.find(
      (i) => i.code === "publication_lineage_incomplete" && i.subject?.id === 410
    );
    expect(issue?.message).toContain("integrity");
  });

  it("classifies manual publications explicitly as legacy without fabricating lineage", () => {
    const dataset = build();
    const manual = dataset.publications.find((p) => p.kind === "manual");
    expect(manual?.lineage).toBe("legacy");
    expect(manual?.queue).toBeNull();
    expect(manual?.package).toBeNull();
    expect(manual?.provider.externalPostId).toBeNull();
    expect(manual?.provenance).toEqual([{ table: "content_posts", id: 104 }]);
    const issue = dataset.readiness.issues.find(
      (i) => i.code === "publication_lineage_incomplete" && i.subject?.id === 104
    );
    expect(issue?.message).toContain("manually");
  });

  it("reports no_publication_evidence when nothing was actually published", () => {
    const dataset = build({ publications: [], manualPublications: [] });
    expect(dataset.publications).toHaveLength(0);
    const issue = dataset.readiness.issues.find((i) => i.code === "no_publication_evidence");
    expect(issue?.severity).toBe("optional");
  });
});

describe("factual outcomes", () => {
  it("retains analytics provenance to persisted row ids", () => {
    const dataset = build();
    expect(dataset.outcomes.rowsConsidered).toBe(4);
    expect(dataset.outcomes.observations.map((o) => o.id)).toEqual(["ao:1", "ao:2", "ao:3"]);
    expect(dataset.outcomes.observations[0].provenance).toEqual({
      kind: "analytics",
      analyticsId: 1,
      metricType: "impressions",
      platform: "instagram",
      date: "2026-05-01",
    });
    expect(dataset.outcomes.totals.impressions).toBe(10000);
    expect(dataset.outcomes.totals.clicks).toBe(300);
    expect(dataset.outcomes.totals.conversions).toBe(12);
  });

  it("links engagement evidence only when campaign-linked and window-scoped", () => {
    const dataset = build();
    expect(dataset.engagement.inWindowEventCount).toBe(2);
    expect(dataset.engagement.unlinkedEventCount).toBe(1);
    expect(dataset.engagement.facts).toEqual([
      expect.objectContaining({ platform: "instagram", eventType: "comment", eventCount: 1, sourceEventIds: [502] }),
      expect.objectContaining({ platform: "instagram", eventType: "like", eventCount: 1, sourceEventIds: [501] }),
    ]);
    const issue = dataset.readiness.issues.find((i) => i.code === "unlinked_engagement_data");
    expect(issue?.severity).toBe("optional");
    expect(issue?.message).toContain("1 engagement event(s)");
    // The out-of-window linked event (504) is excluded, not counted unlinked.
    const allIds = dataset.engagement.facts.flatMap((f) => [...f.sourceEventIds]);
    expect(allIds).not.toContain(504);
  });

  it("links lead/conversion evidence only when campaign-linked", () => {
    const dataset = build();
    expect(dataset.leads.inWindowLeadCount).toBe(2);
    expect(dataset.leads.byStatus).toEqual({ new: 1, won: 1 });
    expect(dataset.leads.conversionsWon).toBe(1);
    expect(dataset.leads.leadIds).toEqual([601, 602]);
    expect(dataset.leads.provenance).toEqual([
      { table: "leads", id: 601 },
      { table: "leads", id: 602 },
    ]);
  });
});

describe("spend / cost", () => {
  it("uses persisted ai_usage cost only and classifies coverage honestly as partial", () => {
    const dataset = build();
    expect(dataset.spend.available).toBe(true);
    expect(dataset.spend.coverage).toBe("partial");
    expect(dataset.spend.basis).toEqual(["ai_usage"]);
    expect(dataset.spend.totalCostUsd).toBe("2.5");
    expect(dataset.spend.facts).toHaveLength(1);
    expect(dataset.spend.facts[0]).toEqual(
      expect.objectContaining({
        aiUsageId: 701,
        agentType: "creative",
        actualCostUsd: "2.5",
        provenance: { table: "ai_usage", id: 701 },
      })
    );
    expect(dataset.spend.classificationNote).toContain("partial");
  });

  it("never fabricates spend when cost evidence is absent", () => {
    const dataset = build({ aiUsageRows: [] });
    expect(dataset.spend.available).toBe(false);
    expect(dataset.spend.coverage).toBe("none");
    expect(dataset.spend.totalCostUsd).toBeNull();
    expect(dataset.spend.facts).toHaveLength(0);
    const issue = dataset.readiness.issues.find((i) => i.code === "cost_evidence_unavailable");
    expect(issue?.severity).toBe("optional");
  });

  it("converts micro-USD integers to exact decimal strings", () => {
    expect(microUsdToDecimalString(0)).toBe("0");
    expect(microUsdToDecimalString(1_000_000)).toBe("1");
    expect(microUsdToDecimalString(2_500_000)).toBe("2.5");
    expect(microUsdToDecimalString(123_456)).toBe("0.123456");
    expect(microUsdToDecimalString(1_234_567_890)).toBe("1234.56789");
  });
});

describe("time-window filtering", () => {
  it("scopes analytics, engagement, leads and cost to the window deterministically", () => {
    const dataset = build({ window: { start: "2026-05-10", end: "2026-05-20" } });
    expect(dataset.outcomes.observations.map((o) => o.id)).toEqual(["ao:3"]);
    expect(dataset.engagement.inWindowEventCount).toBe(0);
    expect(dataset.leads.leadIds).toEqual([601, 602]);
    // ai_usage row 701 was recorded 2026-05-05, before this window.
    expect(dataset.spend.facts.map((f) => f.aiUsageId)).toEqual([]);
    // Rebuilding with the same window yields identical output.
    const again = build({ window: { start: "2026-05-10", end: "2026-05-20" } });
    expect(again.identity.fingerprint).toBe(dataset.identity.fingerprint);
  });

  it("reports insufficient_date_overlap when the window covers no evidence dates", () => {
    const dataset = build({ window: { start: "2026-07-01", end: "2026-07-31" } });
    const issue = dataset.readiness.issues.find((i) => i.code === "insufficient_date_overlap");
    expect(issue?.severity).toBe("optional");
    expect(issue?.message).toContain("2026-07-01..2026-07-31");
  });

  it("reports no_analytics_observations when the window has no analytics rows", () => {
    const dataset = build({ analyticsRows: [] });
    const issue = dataset.readiness.issues.find((i) => i.code === "no_analytics_observations");
    expect(issue?.severity).toBe("optional");
  });
});

describe("readiness", () => {
  it("marks the dataset ready when authority and evidence are complete", () => {
    const input = baseInput();
    const dataset = buildCampaignPerformanceDataset({
      ...input,
      publications: [governedQueuePub(401, "instagram", 101, "ext-ig-1")],
      manualPublications: [],
      engagementEvents: (input.engagementEvents ?? []).filter((e) => e.campaignId === 7),
    });
    expect(dataset.readiness.status).toBe("ready");
    expect(dataset.readiness.issues).toHaveLength(0);
    expect(dataset.readiness.requiredIssueCount).toBe(0);
    expect(dataset.readiness.optionalIssueCount).toBe(0);
  });

  it("marks the dataset degraded when only optional evidence is missing", () => {
    const dataset = build({ aiUsageRows: [] });
    expect(dataset.readiness.status).toBe("degraded");
    expect(dataset.readiness.requiredIssueCount).toBe(0);
    expect(dataset.readiness.optionalIssueCount).toBeGreaterThan(0);
  });
});

describe("immutability and factual language", () => {
  it("never mutates source inputs", () => {
    const input = baseInput();
    const snapshot = JSON.stringify(input);
    deepFreeze(input);
    const dataset = buildCampaignPerformanceDataset(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.identity)).toBe(true);
    expect(Object.isFrozen(dataset.publications)).toBe(true);
  });

  it("produces no recommendation or causal language", () => {
    const dataset = build();
    const banned = /\b(should|recommend|recommended|because|caused|causes?\b|due to|therefore|improve|suggest)\b/i;
    const strings = allStrings(dataset);
    for (const text of strings) {
      expect(text).not.toMatch(banned);
    }
    expect(dataset).not.toHaveProperty("recommendations");
    expect(dataset).not.toHaveProperty("insights");
    expect(dataset).not.toHaveProperty("causes");
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
