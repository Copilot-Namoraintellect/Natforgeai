/**
 * R4-B4 — Claims / fidelity / quality governance, adversarially exercised.
 *
 * Drives the REAL governance gates with hostile inputs and proves the release
 * path fails closed on every unsafe, stale or mismatched condition while
 * approved artefacts retain immutable lineage:
 *
 *   - unsupported/ungrounded claims        → real validateCampaignCopy rejects
 *   - semantic fidelity failure            → real rendered-fidelity gate
 *     (observe reports wouldBlock; enforce blocks; stale lineage never
 *     evaluates, so a drifted brief can never be falsely blocked OR passed)
 *   - visual quality failure               → real visual-quality release gate
 *     (observe records; enforce blocks)
 *   - copy authority mismatch              → real envelope binding assertion
 *   - Strategy lineage drift post-seal     → seal refuses; prior package intact
 *   - Business DNA lineage drift           → artefact binding fails closed
 *   - image/render lineage mismatch        → leaflet binding fails closed
 *   - rejected creative                    → never seals
 *   - retry following rejection            → regenerated authority seals
 *   - retry following transient failure    → recovery seals exactly once
 *   - duplicate readiness event            → already_present, no re-seal
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";
import {
  buildDeterministicMessagePack,
  validateCampaignCopy,
  type CampaignMessagePack,
  type ValidationContext,
} from "./campaign-message-architect";
import {
  CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY,
  assertCreativeArtifactLineageMatchesEnvelope,
  buildPersistedCreativeArtifactLineage,
} from "./artifact-lineage";
import type { V2ApprovalEnvelope } from "./message-approval/contracts";
import {
  evaluateRenderedFidelityProductionGate,
} from "./fidelity/rendered-fidelity-production-gate";
import type { QualityAuthorityObservationInput } from "./contracts/observe-quality-authority";
import type { RenderedCreativeSemanticContent } from "./fidelity/rendered-semantic-fidelity";
import { evaluateVisualQualityReleaseGate } from "./quality/visual-quality-release-gate";
import type { VisualEvaluationEvidenceInput } from "./quality/visual-evaluation-contract";
import {
  assertCreativeReleasePackageIntact,
  buildCreativeReleasePackage,
  readSealedCreativeReleasePackage,
  syncCreativeReleasePackage,
  type CreativeReleasePackage,
} from "./release-package";

// ── Shared authority fixtures ───────────────────────────────────────────────

const USER_ID = 42;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const SNAPSHOT_ID = "strategy_snap_b4";
const BDNA_ID = "bdna_snap_b4";
const STRATEGY_HASH = hashStrategySnapshotPayload({ coreMessage: "Ride the summer." } as any);

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
  const fingerprint = buildGroundedCreativeBrief({ campaign }).fingerprint;
  campaign.workflowContext = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: 600,
      approvalRequestId: 901,
      status: "approved",
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: 2,
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
    strategyVersion: 2,
    businessDnaSnapshotId: BDNA_ID,
    strategyHashSha256: STRATEGY_HASH,
    strategyRunId: 600,
    approvalRequestId: 901,
  };
}

// ── Fake database (campaign tables only, for seal-path adversarial cases) ───

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

function rowsFor(name: string): any[] {
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
}

function createHarnessDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const rows = rowsFor(getTableName(table) ?? "").filter((r) =>
            getColumnFilters(condition).every((f) => r[f.name] === f.value)
          );
          const copies = rows.map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({ limit: async (_n: number) => copies }),
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
          if ((getTableName(table) ?? "") === "campaigns" && harness.campaign) {
            Object.assign(harness.campaign, payload);
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 0 }];
        },
      }),
    }),
  };
}

async function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

function completeEvidence(fingerprint: string) {
  return {
    contentPosts: [
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
    ],
    campaignAssets: [
      {
        id: 501,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "message_pack",
        title: "Campaign Message Pack",
        status: "approved",
        createdAt: "2026-06-01T09:00:00.000Z",
        metadata: { passed: true, ...authoritySpread(fingerprint) },
      },
      {
        id: 502,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack",
        status: "ready",
        createdAt: "2026-06-01T11:00:00.000Z",
        metadata: { ...authoritySpread(fingerprint) },
      },
    ],
  };
}

function seedGovernedCampaign() {
  harness.campaign = buildCampaign();
  harness.business = { id: BUSINESS_ID, userId: USER_ID, name: "Acme Surf Co" };
  const fingerprint = buildGroundedCreativeBrief({ campaign: harness.campaign }).fingerprint;
  const evidence = completeEvidence(fingerprint);
  harness.contentPosts = evidence.contentPosts;
  harness.campaignAssets = evidence.campaignAssets;
  harness.generatedImages = [];
  return fingerprint;
}

// ── Adversarial matrix ──────────────────────────────────────────────────────

describe("R4-B4 unsupported or ungrounded claims", () => {
  const ctx: ValidationContext = {
    businessName: "Acme Surf Co",
    campaignName: "Summer Board Drop",
    productOrService: "handmade surfboards",
    targetCustomer: "surfers",
    location: "Cape Town",
    websiteEvidence: {
      businessCategory: "retail",
      productsServices: ["handmade surfboards", "custom boards"],
      targetCustomers: ["surfers"],
    },
  };

  it("rejects copy that invents an offer the business never made", () => {
    const pack: CampaignMessagePack = {
      headline: "50% off everything this week only!",
      subheadline: "Massive clearance on all handmade surfboards.",
      benefitBullets: ["Half price boards", "Unbelievable deals"],
      cta: "Shop now",
      footerContact: { phone: undefined, whatsapp: undefined, email: undefined, website: undefined },
      platformCaptions: [
        { platform: "instagram", caption: "50% off everything!!!", cta: "Shop now", hashtags: [] },
      ],
      validation: { passed: false, score: 0, rejections: [], warnings: [] },
    };

    const result = validateCampaignCopy(pack, ctx);
    expect(result.passed).toBe(false);
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it("accepts the deterministic grounded pack built only from brief facts", () => {
    const pack = buildDeterministicMessagePack(ctx);
    const result = validateCampaignCopy(pack, ctx);
    expect(result.passed).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it("an unapproved (claim-rejected) pack row never seals into the release", async () => {
    await installDb();
    const fingerprint = seedGovernedCampaign();
    // The message pack row records the failed validation verdict.
    harness.campaignAssets[0].metadata.passed = false;
    harness.campaignAssets[0].metadata.validation = {
      passed: false,
      rejections: ["invented offer"],
    };

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
});

describe("R4-B4 semantic fidelity governance (real rendered-fidelity gate)", () => {
  // Fixture mirrors the gate's own acceptance suite (Zuto Hub): a B2B offer
  // with capabilities, an approved headline, and a faithful render.
  const APPROVED_HEADLINE = "Streamline B2B Payment Orchestration";

  const LINEAGE = {
    campaignId: 30,
    userId: 22,
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedStrategyFingerprint: "strategy-fp",
    approvedAt: "2026-07-01T08:00:00.000Z",
    status: "approved" as const,
    strategyRunStatus: "completed" as const,
  };

  function makeAuthority(
    overrides: Partial<QualityAuthorityObservationInput> = {}
  ): QualityAuthorityObservationInput {
    return {
      campaignId: 30,
      userId: 22,
      businessId: 24,
      businessName: "Zuto Hub",
      lineage: { ...LINEAGE },
      expectedApprovedStrategyFingerprint: "strategy-fp",
      funnelStage: "consideration",
      campaignWideCta: "Request a Consultation",
      campaignInputCta: "Request a Consultation",
      targetAudience: "B2B finance teams and merchant operators",
      offer: "Book a guided walkthrough",
      offerRequired: false,
      businessCapabilities: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
        "transaction reservations",
        "controlled payment-instruction services",
      ],
      legacySelectedCta: "Request a Consultation",
      ...overrides,
    };
  }

  function makeRendered(): RenderedCreativeSemanticContent {
    return {
      headline: APPROVED_HEADLINE,
      subheadline:
        "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      cta: "Request a Consultation",
      offer: "Book a guided walkthrough",
      claims: [
        "Verify available prefunded balances before payment instructions are issued",
        "Reserve transaction amounts with traceable administration",
        "Issue controlled payment instructions from a central account",
      ],
      contactDetails: [],
      businessName: "Zuto Hub",
    };
  }

  it("observe mode reports a semantic divergence without blocking", () => {
    const rendered = makeRendered();
    rendered.cta = "Buy now before midnight";
    rendered.claims = ["Guaranteed Olympic-grade performance for everyone"];

    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "observe",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
    });

    expect(outcome.mode).toBe("observe");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(true);
    expect(outcome.reasonCodes.length).toBeGreaterThan(0);
  });

  it("enforce mode fails closed on the same divergence", () => {
    const rendered = makeRendered();
    rendered.cta = "Buy now before midnight";

    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered,
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.wouldBlock).toBe(true);
  });

  it("a drifted strategy fingerprint is never evaluated, even in enforce mode", () => {
    const outcome = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority(),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    // Same-authority control: the faithful render passes cleanly.
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(false);

    // Drift: the campaign brief changed after approval — the gate must refuse
    // to evaluate rather than block or pass on stale authority.
    const drifted = evaluateRenderedFidelityProductionGate({
      mode: "enforce",
      authority: makeAuthority({ expectedApprovedStrategyFingerprint: "different-fp" }),
      approvedHeadline: APPROVED_HEADLINE,
      rendered: makeRendered(),
    });
    expect(drifted.status).toBe("not_requested");
    expect(drifted.notRequestedReason).toMatch(/^lineage_not_authoritative:stale_strategy/);
    expect(drifted.blocked).toBe(false);
  });
});

describe("R4-B4 visual quality governance (real visual-quality release gate)", () => {
  function strongEvidence(): VisualEvaluationEvidenceInput {
    return {
      renderMetrics: {
        width: 1080,
        height: 1350,
        ctaBoundingBox: { x: 160, y: 1118, w: 760, h: 72 },
        footerY: 1238,
        minFontSizeUsed: 20,
        didCrowd: false,
        usedContentHeight: 924,
        availableContentHeight: 942,
        primaryCardCount: 4,
        secondaryCardCount: 0,
      },
      brandRenderDiagnostics: {
        realLogoExpected: true,
        realLogoRendered: true,
        logoRenderMode: "image",
        logoRenderedHeight: 72,
        logoVisibleArea: 9000,
      },
      palette: {
        primary: "#0047AB",
        background: "#FFFFFF",
        text: "#0F172A",
        accent: "#F59E0B",
        source: "logo",
      },
      visualDirection: { density: "balanced", serviceLayout: "featured" },
    };
  }

  it("enforce mode blocks a low-contrast render; observe records it without blocking", () => {
    const weakEvidence = strongEvidence();
    weakEvidence.palette = { ...weakEvidence.palette!, text: "#CCCCCC" };

    const enforced = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: weakEvidence,
    });
    expect(enforced.evaluation.verdict).toBe("failed");
    expect(enforced.wouldBlock).toBe(true);
    expect(enforced.blocked).toBe(true);
    expect(enforced.failedDimensions.map((d) => d.dimensionId)).toContain(
      "readability_contrast"
    );

    const observed = evaluateVisualQualityReleaseGate({
      mode: "observe",
      evidence: {
        ...strongEvidence(),
        palette: { ...strongEvidence().palette!, text: "#CCCCCC" },
      },
    });
    expect(observed.wouldBlock).toBe(true);
    expect(observed.blocked).toBe(false);
  });

  it("a faithful render passes the enforce gate", () => {
    const decision = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: strongEvidence(),
    });
    expect(decision.evaluation.verdict).toBe("passed");
    expect(decision.blocked).toBe(false);
    expect(decision.wouldBlock).toBe(false);
  });
});

describe("R4-B4 copy authority mismatch (real envelope binding assertion)", () => {
  const APPROVED_COPY = {
    copyHashSha256: "c".repeat(64),
    copySchemaVersion: "v2",
    approvedRevisionId: "rev-1",
    assessmentHashSha256: "d".repeat(64),
    contextLockId: "ctx-1",
  };

  function makeEnvelope(): V2ApprovalEnvelope {
    return {
      copyHashSha256: APPROVED_COPY.copyHashSha256,
      copySchemaVersion: APPROVED_COPY.copySchemaVersion,
      approvedRevisionId: APPROVED_COPY.approvedRevisionId,
      assessmentHashSha256: APPROVED_COPY.assessmentHashSha256,
      contextLockId: APPROVED_COPY.contextLockId,
      campaignStrategySnapshotId: SNAPSHOT_ID,
      strategyHashSha256: STRATEGY_HASH,
      businessDnaSnapshotId: BDNA_ID,
    } as unknown as V2ApprovalEnvelope;
  }

  it("throws when a caption lineage was rebound to a different approved copy", () => {
    const lineage = buildPersistedCreativeArtifactLineage({
      artifactKind: "caption_pack",
      platform: null,
      parent: { artifactKind: "message_pack" },
      strategy: {
        strategySnapshotId: SNAPSHOT_ID,
        strategyVersion: 2,
        businessDnaSnapshotId: BDNA_ID,
        strategyHashSha256: STRATEGY_HASH,
        strategyRunId: 600,
        approvalRequestId: 901,
        creativeBriefFingerprint: "fp",
      },
      approvedCopy: {
        ...APPROVED_COPY,
        copyHashSha256: "e".repeat(64),
      },
    });

    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(lineage, makeEnvelope())
    ).toThrow(/approved-copy coordinates diverge/);
  });

  it("accepts the lineage bound to the exact approved envelope", () => {
    const lineage = buildPersistedCreativeArtifactLineage({
      artifactKind: "caption_pack",
      platform: null,
      parent: { artifactKind: "message_pack" },
      strategy: {
        strategySnapshotId: SNAPSHOT_ID,
        strategyVersion: 2,
        businessDnaSnapshotId: BDNA_ID,
        strategyHashSha256: STRATEGY_HASH,
        strategyRunId: 600,
        approvalRequestId: 901,
        creativeBriefFingerprint: "fp",
      },
      approvedCopy: { ...APPROVED_COPY },
    });

    expect(() =>
      assertCreativeArtifactLineageMatchesEnvelope(lineage, makeEnvelope())
    ).not.toThrow();
  });
});

describe("R4-B4 lineage drift against a sealed release", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedGovernedCampaign();
    await installDb();
  });

  async function sealOnce(): Promise<CreativeReleasePackage> {
    const result = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.seal",
    });
    expect(result.outcome).toBe("sealed");
    if (result.outcome === "incomplete") throw new Error("seed must seal");
    return readSealedCreativeReleasePackage(harness.campaign)!;
  }

  it("Business DNA lineage drift in an artefact fails the re-seal closed", async () => {
    const sealed = await sealOnce();
    assertCreativeReleasePackageIntact(sealed);

    // Governed caption packs (WBS12.3) persist ONLY the durable lineage key —
    // no top-level authority spread. Rebind that lineage to a different
    // Business DNA snapshot: exactly the drift an approval-bound artefact
    // must resist.
    harness.campaignAssets[1].metadata = {
      creativeBriefFingerprint:
        harness.campaignAssets[1].metadata.creativeBriefFingerprint,
      [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: {
        lineageSchemaVersion: 1,
        artifactKind: "caption_pack",
        platform: null,
        lineageFingerprintSha256: "f".repeat(64),
        strategy: {
          strategySnapshotId: SNAPSHOT_ID,
          strategyVersion: 2,
          businessDnaSnapshotId: "bdna_snap_TAMPERED",
          strategyHashSha256: STRATEGY_HASH,
          strategyRunId: 600,
          approvalRequestId: 901,
          creativeBriefFingerprint: null,
        },
        approvedCopy: null,
      },
    };

    const reseal = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.reseal",
    });
    expect(reseal.outcome).toBe("incomplete");
    if (reseal.outcome !== "incomplete") return;
    expect(reseal.reasons).toContain("caption_artefacts_stale");

    // The previously sealed package remains intact and immutable.
    const stillSealed = readSealedCreativeReleasePackage(harness.campaign);
    expect(stillSealed!.packageFingerprintSha256).toBe(sealed.packageFingerprintSha256);
    assertCreativeReleasePackageIntact(stillSealed!);
  });

  it("image/render lineage mismatch on the leaflet fails closed", async () => {
    // The leaflet post's Strategy coordinates were tampered after rendering.
    harness.contentPosts[0].metadata.strategySnapshotId = "strategy_snap_TAMPERED";

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

  it("Strategy lineage drift after sealing refuses the new seal and keeps history", async () => {
    const sealed = await sealOnce();

    // Brief edit invalidates the approved strategy (no re-approval yet).
    harness.campaign.coreMessage = "Drifted after seal";
    const stale = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.reseal",
    });
    expect(stale.outcome).toBe("incomplete");
    if (stale.outcome !== "incomplete") return;
    expect(stale.reasons).toContain("strategy_authority_stale");

    const intact = readSealedCreativeReleasePackage(harness.campaign);
    expect(intact!.packageFingerprintSha256).toBe(sealed.packageFingerprintSha256);
    expect(intact!.creativeBriefFingerprint).toBe(sealed.creativeBriefFingerprint);
  });

  it("duplicate readiness event converges on already_present without re-sealing", async () => {
    const first = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.first",
    });
    expect(first.outcome).toBe("sealed");

    const duplicate = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.duplicate",
    });
    expect(duplicate.outcome).toBe("already_present");

    const sealed = readSealedCreativeReleasePackage(harness.campaign);
    expect(sealed!.sealedBy).toBe("test.first");
    assertCreativeReleasePackageIntact(sealed!);
  });
});

describe("R4-B4 rejection and recovery paths", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedGovernedCampaign();
    await installDb();
  });

  it("rejected creative does not seal; retry after regeneration seals once", async () => {
    // Rejection: the approved pack is invalidated.
    harness.campaignAssets[0].metadata.passed = false;
    harness.campaignAssets[0].status = "rejected";

    const rejected = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.rejected",
    });
    expect(rejected.outcome).toBe("incomplete");
    expect(readSealedCreativeReleasePackage(harness.campaign)).toBeNull();

    // Retry following rejection: the pack is rebuilt and approved under the
    // same brief; the release now seals.
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    harness.campaignAssets.push({
      id: 511,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "message_pack",
      title: "Campaign Message Pack v2",
      status: "approved",
      createdAt: "2026-06-03T09:00:00.000Z",
      metadata: { passed: true, ...authoritySpread(fingerprint) },
    });

    const recovered = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.recovered",
    });
    expect(recovered.outcome).toBe("sealed");
    const sealed = readSealedCreativeReleasePackage(harness.campaign);
    expect(
      sealed!.artefacts.some((ref) => ref.kind === "message_pack" && ref.recordId === 511)
    ).toBe(true);
    assertCreativeReleasePackageIntact(sealed!);
  });

  it("retry following a transient generation failure seals exactly once", async () => {
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    // Remove the seeded ready pack: the transient failure IS the only caption
    // artefact at this point in the pipeline.
    harness.campaignAssets = harness.campaignAssets.filter(
      (asset) => asset.assetType !== "caption_pack"
    );
    // Transient failure left a failed caption row behind.
    harness.campaignAssets.push({
      id: 502,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "caption_pack",
      title: "Caption Pack (failed attempt)",
      status: "failed",
      createdAt: "2026-06-01T11:00:00.000Z",
      metadata: { ...authoritySpread(fingerprint) },
    });

    const failedFirst = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.failed-attempt",
    });
    expect(failedFirst.outcome).toBe("incomplete");

    // Recovery: a successful regeneration supersedes the failed row.
    harness.campaignAssets.push({
      id: 503,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "caption_pack",
      title: "Caption Pack",
      status: "ready",
      createdAt: "2026-06-01T11:05:00.000Z",
      metadata: { ...authoritySpread(fingerprint) },
    });

    const recovered = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.recovered",
    });
    expect(recovered.outcome).toBe("sealed");
    const sealed = readSealedCreativeReleasePackage(harness.campaign)!;
    expect(sealed.artefacts.filter((ref) => ref.kind === "caption_pack")).toHaveLength(1);

    const replay = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "test.replay",
    });
    expect(replay.outcome).toBe("already_present");
  });
});
