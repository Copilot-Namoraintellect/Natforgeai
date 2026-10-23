/**
 * R4-B2 — Immutable creative release package.
 *
 * Proves the release package is deterministic, lineage-bound, fail-closed on
 * incomplete or mismatched evidence, idempotent under retry, and immutable
 * once sealed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";
import {
  CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY,
  assertCreativeReleasePackageIntact,
  buildCreativeReleasePackage,
  computeCreativeReleasePackageFingerprint,
  deriveCreativeReleasePackageIdentity,
  readSealedCreativeReleasePackage,
  syncCreativeReleasePackage,
  syncCreativeReleasePackageSafely,
  type CreativeReleasePackage,
} from "./release-package";

// ── Fake database ───────────────────────────────────────────────────────────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function flattenSqlChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
  const out: any[] = [];
  for (const chunk of sql.queryChunks) {
    if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      out.push(...flattenSqlChunks(chunk));
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function getColumnFilters(condition: unknown): Array<{ name: string; value: unknown }> {
  const chunks = flattenSqlChunks(condition);
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
}

const harness = vi.hoisted(() => ({
  campaign: undefined as any,
  business: undefined as any,
  contentPosts: [] as any[],
  campaignAssets: [] as any[],
  generatedImages: [] as any[],
}));

function createHarnessDb() {
  const rowsFor = (name: string): any[] => {
    switch (name) {
      case "campaigns":
        return harness.campaign ? [harness.campaign] : [];
      case "businesses":
        return harness.business ? [harness.business] : [];
      case "content_posts":
        return harness.contentPosts;
      case "campaign_assets":
        return harness.campaignAssets;
      case "generated_images":
        return harness.generatedImages;
      default:
        return [];
    }
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const base = rowsFor(name);
          const rows = base.filter((r) =>
            getColumnFilters(condition).every((f) => r[f.name] === f.value)
          );
          const copies = rows.map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({
              limit: async (_n: number) => copies,
            }),
            limit: async (_n: number) => copies,
            then: (resolve: (value: any[]) => unknown) =>
              Promise.resolve(copies).then(resolve),
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: async () => {
          const name = getTableName(table) ?? "";
          if (name === "campaigns" && harness.campaign) {
            Object.assign(harness.campaign, payload);
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 0 }];
        },
      }),
    }),
  };
}

// ── Seeds ───────────────────────────────────────────────────────────────────

const USER_ID = 42;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const STRATEGY_RUN_ID = 600;
const APPROVAL_REQUEST_ID = 901;
const SNAPSHOT_ID = "strategy_snap_b2";
const BDNA_ID = "bdna_snap_b2";
const STRATEGY_VERSION = 2;
const STRATEGY_PAYLOAD = {
  coreMessage: "Ride the summer.",
  valueProposition: "Handmade boards, built locally.",
  positioning: "Premium local craft",
  campaignTheme: "Summer board drop",
  personas: [{ name: "Sipho" }],
};
const STRATEGY_HASH = hashStrategySnapshotPayload(STRATEGY_PAYLOAD as any);

function fingerprintOf(campaign: any): string {
  return buildGroundedCreativeBrief({ campaign }).fingerprint;
}

function buildCampaign(briefOverrides: Record<string, unknown> = {}) {
  const campaign: any = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    platforms: "instagram,facebook",
    workflowState: "creatives_ready",
  };
  Object.assign(campaign, briefOverrides);
  const fingerprint = fingerprintOf(campaign);
  campaign.workflowContext = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      status: "approved",
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: STRATEGY_VERSION,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
    },
  };
  return campaign;
}

function authoritySpread(fingerprint: string) {
  return {
    creativeBriefFingerprint: fingerprint,
    strategySnapshotId: SNAPSHOT_ID,
    strategyVersion: STRATEGY_VERSION,
    businessDnaSnapshotId: BDNA_ID,
    strategyHashSha256: STRATEGY_HASH,
    strategyRunId: STRATEGY_RUN_ID,
    approvalRequestId: APPROVAL_REQUEST_ID,
  };
}

function seedCompleteEvidence(fingerprint: string) {
  harness.contentPosts = [
    {
      id: 801,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      title: "Master Campaign Post",
      type: "social_post",
      status: "draft",
      createdAt: "2026-06-01T10:00:00.000Z",
      metadata: {
        assetType: "leaflet",
        assetKind: "master_campaign_post",
        imageStatus: "ready",
        imageUrl: "https://cdn.example.com/leaflet.png",
        ...authoritySpread(fingerprint),
      },
    },
  ];
  harness.campaignAssets = [
    {
      id: 501,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "message_pack",
      title: "Campaign Message Pack",
      status: "approved",
      createdAt: "2026-06-01T09:00:00.000Z",
      metadata: {
        passed: true,
        ...authoritySpread(fingerprint),
      },
    },
    {
      id: 502,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "caption_pack",
      title: "Caption Pack",
      status: "ready",
      createdAt: "2026-06-01T11:00:00.000Z",
      metadata: {
        ...authoritySpread(fingerprint),
      },
    },
    {
      id: 503,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "hashtag_set",
      title: "Master Hashtag Set",
      status: "ready",
      createdAt: "2026-06-01T11:30:00.000Z",
      metadata: {
        ...authoritySpread(fingerprint),
      },
    },
  ];
  harness.generatedImages = [
    {
      id: 601,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      contentPostId: 801,
      status: "completed",
    },
  ];
}

async function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

function freshHarness() {
  harness.campaign = buildCampaign();
  harness.business = {
    id: BUSINESS_ID,
    userId: USER_ID,
    name: "Acme Surf Co",
    industry: "retail",
  };
  seedCompleteEvidence(fingerprintOf(harness.campaign));
}

describe("creative release package identity", () => {
  it("derives a deterministic identity from campaign + brief fingerprint", () => {
    const id = deriveCreativeReleasePackageIdentity(29, "abc123");
    expect(id).toBe("crp:29:abc123");
    expect(deriveCreativeReleasePackageIdentity(29, "abc123")).toBe(id);
    expect(() => deriveCreativeReleasePackageIdentity(0, "abc123")).toThrow();
    expect(() => deriveCreativeReleasePackageIdentity(29, "")).toThrow();
  });
});

describe("buildCreativeReleasePackage (pure)", () => {
  beforeEach(freshHarness);

  it("seals a complete governed evidence set with full lineage binding", () => {
    const fingerprint = fingerprintOf(harness.campaign);
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      business: harness.business,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      generatedImages: harness.generatedImages,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });

    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;
    const pkg = result.package;
    expect(pkg.packageId).toBe(`crp:${CAMPAIGN_ID}:${fingerprint}`);
    expect(pkg.creativeBriefFingerprint).toBe(fingerprint);
    expect(pkg.strategy).toEqual({
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: STRATEGY_VERSION,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      creativeBriefFingerprint: fingerprint,
    });
    const kinds = pkg.artefacts.map((a) => a.kind).sort();
    expect(kinds).toEqual([
      "caption_pack",
      "leaflet",
      "message_pack",
      "supporting_asset",
    ]);
    expect(pkg.quality.renderedLeafletReady).toBe(true);
    expect(Object.isFrozen(pkg)).toBe(true);
    assertCreativeReleasePackageIntact(pkg);
  });

  it("produces the same package fingerprint regardless of seal metadata", () => {
    const base = {
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
    };
    const a = buildCreativeReleasePackage({
      ...base,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "one",
    });
    const b = buildCreativeReleasePackage({
      ...base,
      sealedAtIso: "2026-06-13T00:00:00.000Z",
      sealedBy: "two",
    });
    expect(a.status).toBe("sealed");
    expect(b.status).toBe("sealed");
    if (a.status !== "sealed" || b.status !== "sealed") return;
    expect(a.package.packageFingerprintSha256).toBe(
      b.package.packageFingerprintSha256
    );
  });

  it("fails closed without approved strategy authority", () => {
    harness.campaign.workflowContext = {};
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("strategy_authority_missing");
  });

  it("fails closed when the strategy approval is stale after a brief edit", () => {
    harness.campaign.coreMessage = "Repositioned after approval";
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("strategy_authority_stale");
  });

  it("fails closed when the approved message pack is missing", () => {
    harness.campaignAssets = harness.campaignAssets.filter(
      (a) => a.assetType !== "message_pack"
    );
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("message_pack_missing");
  });

  it("fails closed when the message pack never passed approval", () => {
    harness.campaignAssets[0].metadata.passed = false;
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("message_pack_not_approved");
  });

  it("fails closed when the leaflet was never rendered", () => {
    delete harness.contentPosts[0].metadata.imageStatus;
    delete harness.contentPosts[0].metadata.imageUrl;
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("leaflet_not_rendered");
  });

  it("fails closed when caption artefacts are missing", () => {
    harness.campaignAssets = harness.campaignAssets.filter(
      (a) => a.assetType !== "caption_pack"
    );
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("caption_artefacts_missing");
  });

  it("fails closed when an artefact binds to different strategy coordinates", () => {
    harness.campaignAssets[2].metadata.strategySnapshotId = "strategy_snap_OTHER";
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("artefact_lineage_mismatch");
  });

  it("fails closed when a supporting output was created under an older brief fingerprint", () => {
    harness.campaignAssets[2].metadata.creativeBriefFingerprint = "old-fingerprint";
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("output_stale");
  });

  it("fails closed when a supporting output is in a failed state", () => {
    harness.campaignAssets[2].status = "failed";
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") return;
    expect(result.reasons).toContain("output_failed");
  });

  it("records ungoverned legacy rows without bundling them", () => {
    harness.campaignAssets.push({
      id: 599,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "carousel_ad",
      title: "Legacy carousel",
      status: "ready",
      createdAt: "2026-05-01T09:00:00.000Z",
      metadata: {},
    });
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;
    expect(result.package.legacyArtefactIds).toContain(599);
    expect(
      result.package.artefacts.some((ref) => ref.recordId === 599)
    ).toBe(false);
  });
});

describe("syncCreativeReleasePackage (impure, idempotent)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    freshHarness();
    await installDb();
  });

  it("seals the package into the campaign workflow context", async () => {
    const result = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(result.outcome).toBe("sealed");

    const sealed = readSealedCreativeReleasePackage(harness.campaign);
    expect(sealed).not.toBeNull();
    expect(sealed!.sealedBy).toBe("test.seal");
    assertCreativeReleasePackageIntact(sealed!);
  });

  it("retry converges on already_present without mutating the sealed record", async () => {
    const first = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(first.outcome).toBe("sealed");

    const sealedAfterFirst = readSealedCreativeReleasePackage(harness.campaign);
    const sealedAt = sealedAfterFirst!.sealedAtIso;

    const second = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal-retry",
    });
    expect(second.outcome).toBe("already_present");
    expect(second.packageId).toBe(first.packageId);

    const sealedAfterRetry = readSealedCreativeReleasePackage(harness.campaign);
    expect(sealedAfterRetry!.sealedAtIso).toBe(sealedAt);
    expect(sealedAfterRetry!.sealedBy).toBe("test.seal");
    expect(
      computeCreativeReleasePackageFingerprint(sealedAfterRetry!)
    ).toBe(first.packageFingerprintSha256);
  });

  it("a new brief identity supersedes the previous package", async () => {
    const first = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(first.outcome).toBe("sealed");

    // Regenerate the evidence under a new brief fingerprint (post-edit cycle).
    // The campaign ROW retains its workflow context — including the previously
    // sealed package — while the brief fields and evidence move forward.
    const previousContext = harness.campaign.workflowContext;
    harness.campaign = buildCampaign({ coreMessage: "Repositioned message" });
    harness.campaign.workflowContext = {
      ...previousContext,
      ...harness.campaign.workflowContext,
    };
    const newFingerprint = fingerprintOf(harness.campaign);
    seedCompleteEvidence(newFingerprint);

    const second = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal-after-regen",
    });
    expect(second.outcome).toBe("superseded_sealed");
    expect(second.packageId).toBe(`crp:${CAMPAIGN_ID}:${newFingerprint}`);
    expect(second.supersedesPackageId).toBe(first.packageId);

    const sealed = readSealedCreativeReleasePackage(harness.campaign);
    expect(sealed!.packageId).toBe(second.packageId);
    assertCreativeReleasePackageIntact(sealed!);
  });

  it("does not seal when evidence is incomplete", async () => {
    harness.campaignAssets = harness.campaignAssets.filter(
      (a) => a.assetType !== "caption_pack"
    );
    const result = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") return;
    expect(result.reasons).toContain("caption_artefacts_missing");
    expect(readSealedCreativeReleasePackage(harness.campaign)).toBeNull();
  });

  it("returns incomplete for an unknown campaign", async () => {
    const result = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: 99999,
      sealedBy: "test.seal",
    });
    expect(result).toEqual({
      outcome: "incomplete",
      reasons: ["campaign_missing"],
    });
  });

  it("never mutates creative artefact rows while sealing", async () => {
    const postsBefore = JSON.parse(JSON.stringify(harness.contentPosts));
    const assetsBefore = JSON.parse(JSON.stringify(harness.campaignAssets));
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(JSON.parse(JSON.stringify(harness.contentPosts))).toEqual(postsBefore);
    expect(JSON.parse(JSON.stringify(harness.campaignAssets))).toEqual(assetsBefore);
  });
});

describe("assertCreativeReleasePackageIntact", () => {
  beforeEach(freshHarness);

  it("throws when sealed strategy coordinates are tampered after sealing", () => {
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;

    const tampered: CreativeReleasePackage = {
      ...result.package,
      strategy: {
        ...result.package.strategy,
        strategyHashSha256: "f".repeat(64),
      },
    };
    expect(() => assertCreativeReleasePackageIntact(tampered)).toThrow(
      /fingerprint mismatch/
    );
  });

  it("throws when the artefact manifest is tampered after sealing", () => {
    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });
    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;

    const tampered: CreativeReleasePackage = {
      ...result.package,
      artefacts: [
        ...result.package.artefacts,
        {
          kind: "leaflet",
                          recordType: "content_post",
            recordId: 999,
            title: "Injected",
            creativeBriefFingerprint: null,
            lineageFingerprintSha256: null,
        },
      ],
    };
    expect(() => assertCreativeReleasePackageIntact(tampered)).toThrow(
      /fingerprint mismatch/
    );
  });
});

describe("syncCreativeReleasePackageSafely", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    freshHarness();
    await installDb();
  });

  it("returns null for standalone content with no campaign", async () => {
    const result = await syncCreativeReleasePackageSafely({
      userId: USER_ID,
      campaignId: null,
      sealedBy: "router.render",
    });
    expect(result).toBeNull();
  });

  it("swallows database failures without throwing", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("connection lost");
    });
    const result = await syncCreativeReleasePackageSafely({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "router.render",
    });
    expect(result).toBeNull();
  });

  it("exposes the sealed package under the documented context key", async () => {
    await syncCreativeReleasePackageSafely({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "router.render",
    });
    const context = harness.campaign.workflowContext as Record<string, unknown>;
    expect(context[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]).toBeTruthy();
  });
});
