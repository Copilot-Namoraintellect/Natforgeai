import { describe, it, expect } from "vitest";
import {
  resolveCampaignPublicationReadiness,
  isLeafletRecord,
  isUsableLeafletUrl,
  getRecordFingerprint,
  isOutputCurrent,
  buildPublicationReadinessErrorMessage,
  findDurableLeafletRecord,
  findCaptionPackRecord,
} from "./publication-readiness";
import { buildGroundedCreativeBrief } from "./brief-grounding";

function buildCampaign(fields: Record<string, unknown> = {}) {
  return {
    id: 30,
    userId: 18,
    businessId: 24,
    name: "Campaign #30",
    goal: "Conversions",
    productOrService: "business payment platform",
    targetBuyer: "finance managers",
    mainPainPoint: "manual payroll and supplier payouts",
    preferredCta: "Book a Demo",
    primaryOutcome: "qualified demo requests",
    targetAudience: "finance managers in small businesses",
    coreMessage: "Streamline payouts and payroll for your team",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "professional",
    ...fields,
  };
}

function buildBusiness() {
  return {
    id: 24,
    userId: 18,
    name: "Test Business",
    industry: "fintech",
  };
}

function currentFingerprint(campaign: ReturnType<typeof buildCampaign>) {
  return buildGroundedCreativeBrief({ campaign, business: buildBusiness() }).fingerprint;
}

function staleFingerprint() {
  // A different brief produces a different fingerprint.
  return currentFingerprint(
    buildCampaign({ productOrService: "different service", mainPainPoint: "different pain point" })
  );
}

function buildContentPost(opts: Record<string, unknown> = {}) {
  return {
    id: 101,
    userId: 18,
    campaignId: 30,
    type: "social_post",
    platform: "Instagram",
    status: "draft",
    createdAt: new Date().toISOString(),
    ...opts,
  };
}

function buildCampaignAsset(opts: Record<string, unknown> = {}) {
  return {
    id: 201,
    userId: 18,
    campaignId: 30,
    assetType: "ad_copy",
    title: "Ad Variations",
    status: "ready",
    createdAt: new Date().toISOString(),
    ...opts,
  };
}

function buildGeneratedImage(opts: Record<string, unknown> = {}) {
  return {
    id: 301,
    userId: 18,
    campaignId: 30,
    contentPostId: 101,
    provider: "premium",
    url: "https://example.com/leaflet.png",
    status: "completed",
    createdAt: new Date().toISOString(),
    ...opts,
  };
}

function buildApproval(status: string) {
  return { id: 1, userId: 18, campaignId: 30, approvalType: "campaign_launch", status };
}

describe("publication-readiness resolver", () => {
  it("passes when leaflet, caption pack, outputs, and approvals are current", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({
          metadata: { creativeBriefFingerprint: fp },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.currentCreativeBriefFingerprint).toBe(fp);
    expect(result.requiredOutputs.leaflet.present).toBe(true);
    expect(result.requiredOutputs.leaflet.current).toBe(true);
    expect(result.requiredOutputs.captionPack.present).toBe(true);
    expect(result.requiredOutputs.captionPack.current).toBe(true);
  });

  it("blocks when leaflet is missing", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [buildContentPost({ metadata: { creativeBriefFingerprint: fp } })],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_missing");
  });

  it("blocks generic image as leaflet even with imageUrl", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "image",
            imageSource: "openai",
            provider: "openai",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_missing");
  });

  it("blocks leaflet without fingerprint as stale", () => {
    const campaign = buildCampaign();
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: currentFingerprint(campaign) },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_stale");
  });

  it("blocks leaflet with mismatched fingerprint", () => {
    const campaign = buildCampaign();
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: staleFingerprint(),
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: currentFingerprint(campaign) },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_stale");
  });

  it("blocks when caption pack is missing", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [buildCampaignAsset({ metadata: { creativeBriefFingerprint: fp } })],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("caption_pack_missing");
  });

  it("blocks caption pack without fingerprint as stale", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [buildCampaignAsset({ assetType: "caption_pack", metadata: {} })],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("caption_pack_stale");
  });

  it("blocks included supporting asset without fingerprint", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({ metadata: {} }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("output_stale");
  });

  it("blocks included output with mismatched fingerprint", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({ metadata: { creativeBriefFingerprint: staleFingerprint() } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("output_stale");
  });

  it("blocks failed output", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({ status: "failed", metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("output_failed");
  });

  it("blocks generating output", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({ status: "generating", metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("output_failed");
  });

  it("blocks when launch approval is pending", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
        buildCampaignAsset({ metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("pending")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("reports both leaflet_missing and output_stale for campaign #30-shaped state", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [buildContentPost({ metadata: { creativeBriefFingerprint: fp } })],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_adaptation",
          metadata: {},
        }),
        buildCampaignAsset({ metadata: {} }),
        buildCampaignAsset({ metadata: {} }),
        buildCampaignAsset({ metadata: {} }),
        buildCampaignAsset({ metadata: {} }),
        buildCampaignAsset({ metadata: {} }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_missing");
    expect(result.reasons).toContain("output_stale");
    expect(result.reasons).toContain("caption_pack_stale");
  });

  it("treats previously current output as stale after brief is edited", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const editedCampaign = buildCampaign({ productOrService: "payroll automation suite" });
    const newFp = currentFingerprint(editedCampaign);

    const result = resolveCampaignPublicationReadiness({
      campaign: editedCampaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetType: "leaflet",
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({
          assetType: "caption_pack",
          metadata: { creativeBriefFingerprint: fp },
        }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.currentCreativeBriefFingerprint).toBe(newFp);
    expect(result.reasons).toContain("leaflet_stale");
    expect(result.reasons).toContain("caption_pack_stale");
  });

  it("allows one-off content without a campaign", () => {
    const result = resolveCampaignPublicationReadiness({
      selectedOutput: {
        record: buildContentPost({ campaignId: null, metadata: {} }),
        type: "content_post",
      },
    });

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks selected stale output for individual publish paths", () => {
    const campaign = buildCampaign();
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      selectedOutput: {
        record: buildContentPost({
          metadata: { creativeBriefFingerprint: staleFingerprint() },
        }),
        type: "content_post",
      },
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["selected_output_stale"]);
  });

  it("reports selected_output_missing for missing selected output", () => {
    const campaign = buildCampaign();
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      selectedOutput: {
        record: null,
        type: "content_post",
      },
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["selected_output_missing"]);
  });

  it("finds durable leaflet from generatedImages record", () => {
    const record = findDurableLeafletRecord(
      [],
      [],
      [
        buildGeneratedImage({
          metadata: {
            assetType: "leaflet",
            url: "https://example.com/leaflet.png",
          },
        }),
      ]
    );
    expect(record).not.toBeNull();
  });

  it("finds caption_pack and caption_adaptation records", () => {
    const asset = buildCampaignAsset({
      assetType: "caption_adaptation",
      metadata: {},
    });
    expect(findCaptionPackRecord([asset])).toBe(asset);

    const pack = buildCampaignAsset({
      assetType: "caption_pack",
      metadata: {},
    });
    expect(findCaptionPackRecord([pack])).toBe(pack);
  });

  it("rejects invalid leaflet URLs", () => {
    expect(isUsableLeafletUrl("")).toBe(false);
    expect(isUsableLeafletUrl("   ")).toBe(false);
    expect(isUsableLeafletUrl("[object Object]")).toBe(false);
    expect(isUsableLeafletUrl("javascript:alert(1)")).toBe(false);
    expect(isUsableLeafletUrl("relative-path.png")).toBe(false);
    expect(isUsableLeafletUrl("https://example.com/leaflet.png")).toBe(true);
    expect(isUsableLeafletUrl("/generated/leaflet.png")).toBe(true);
  });

  it("builds a readable error message from reasons", () => {
    const message = buildPublicationReadinessErrorMessage({
      ready: false,
      currentCreativeBriefFingerprint: "abc",
      reasons: ["leaflet_missing", "output_stale"],
      requiredOutputs: {
        leaflet: { present: false, current: false, recordId: null },
        captionPack: { present: true, current: false, recordId: 1 },
      },
    });

    expect(message).toContain("Marketing Leaflet is missing");
    expect(message).toContain("stale");
  });
});


describe("publication-readiness requireLaunchApproval", () => {
  it("single-item publish requires launch approval when requireLaunchApproval is true", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const post = buildContentPost({ metadata: { creativeBriefFingerprint: fp } });

    const withoutApproval = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      approvals: [],
      selectedOutput: { record: post, type: "content_post" },
      requireLaunchApproval: true,
    });
    expect(withoutApproval.ready).toBe(false);
    expect(withoutApproval.reasons).toContain("approval_pending");

    const withApproval = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      approvals: [buildApproval("approved")],
      selectedOutput: { record: post, type: "content_post" },
      requireLaunchApproval: true,
    });
    expect(withApproval.ready).toBe(true);
  });

  it("queue-item approval does not require launch approval", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);
    const post = buildContentPost({ metadata: { creativeBriefFingerprint: fp } });

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      approvals: [],
      selectedOutput: { record: post, type: "content_post" },
      requireLaunchApproval: false,
    });
    expect(result.ready).toBe(true);
  });
});

describe("publication-readiness iteration and partial-generation", () => {
  it("does not mix stale iteration A output with new iteration B output", () => {
    const campaignA = buildCampaign();
    const fpA = currentFingerprint(campaignA);
    const campaignB = buildCampaign({ productOrService: "updated service" });
    const fpB = currentFingerprint(campaignB);

    const staleLeaflet = buildContentPost({
      id: 101,
      metadata: {
        assetType: "leaflet",
        assetKind: "master_campaign_post",
        imageUrl: "https://example.com/leaflet-a.png",
        creativeBriefFingerprint: fpA,
      },
    });
    const currentCaptionPack = buildCampaignAsset({
      id: 201,
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: fpB },
    });

    const result = resolveCampaignPublicationReadiness({
      campaign: campaignB,
      business: buildBusiness(),
      contentPosts: [staleLeaflet],
      campaignAssets: [currentCaptionPack],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_stale");
    expect(result.reasons).not.toContain("leaflet_missing");
  });

  it("is ready only when every included output matches the current fingerprint", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);

    const leaflet = buildContentPost({
      metadata: {
        assetType: "leaflet",
        assetKind: "master_campaign_post",
        imageUrl: "https://example.com/leaflet.png",
        creativeBriefFingerprint: fp,
      },
    });
    const captionPack = buildCampaignAsset({
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: fp },
    });
    const supportingAsset = buildCampaignAsset({
      id: 202,
      assetType: "ad_copy",
      metadata: { creativeBriefFingerprint: fp },
    });

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [leaflet],
      campaignAssets: [captionPack, supportingAsset],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(true);
  });
});

describe("publication-readiness campaign #30 regression", () => {
  it("reports leaflet_missing and output_stale when no leaflet and stale supporting assets exist", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);

    const staleSupportingAssets = [
      buildCampaignAsset({ id: 202, assetType: "ad_copy", metadata: { creativeBriefFingerprint: "legacy" } }),
      buildCampaignAsset({ id: 203, assetType: "hook", metadata: {} }),
      buildCampaignAsset({ id: 204, assetType: "cta", metadata: { creativeBriefFingerprint: "legacy" } }),
      buildCampaignAsset({ id: 205, assetType: "hashtag_set", metadata: {} }),
      buildCampaignAsset({ id: 206, assetType: "carousel", metadata: { creativeBriefFingerprint: "legacy" } }),
    ];

    const captionPack = buildCampaignAsset({
      id: 201,
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: fp },
    });

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [],
      campaignAssets: [captionPack, ...staleSupportingAssets],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_missing");
    expect(result.reasons).toContain("output_stale");
    expect(result.requiredOutputs.leaflet.present).toBe(false);
    expect(result.requiredOutputs.captionPack.current).toBe(true);
  });

  it("reports approval_pending when launch approval is missing for campaign #30", () => {
    const campaign = buildCampaign();
    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [],
      campaignAssets: [],
      approvals: [],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
    expect(result.reasons).toContain("leaflet_missing");
  });
});

describe("canonical fingerprint key", () => {
  it("recognizes a premium leaflet with metadata.creativeBriefFingerprint as current", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({ assetType: "caption_pack", metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(true);
    expect(result.requiredOutputs.leaflet.present).toBe(true);
    expect(result.requiredOutputs.leaflet.current).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("treats a leaflet with a stale creativeBriefFingerprint as stale after the brief changes", () => {
    const campaign = buildCampaign();
    const stale = staleFingerprint();

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: stale,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({ assetType: "caption_pack", metadata: { creativeBriefFingerprint: stale } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_stale");
    expect(result.requiredOutputs.leaflet.current).toBe(false);
  });

  it("does not accept legacy creativeFingerprint alias as current", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          metadata: {
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({ assetType: "caption_pack", metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("leaflet_stale");
  });

  it("passes a complete newly generated premium pack when every output carries creativeBriefFingerprint", () => {
    const campaign = buildCampaign();
    const fp = currentFingerprint(campaign);

    const result = resolveCampaignPublicationReadiness({
      campaign,
      business: buildBusiness(),
      contentPosts: [
        buildContentPost({
          id: 101,
          metadata: {
            assetKind: "master_campaign_post",
            imageUrl: "https://example.com/leaflet.png",
            creativeBriefFingerprint: fp,
          },
        }),
      ],
      campaignAssets: [
        buildCampaignAsset({ id: 201, assetType: "caption_pack", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 202, assetType: "ad_copy", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 203, assetType: "hook", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 204, assetType: "cta_variant", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 205, assetType: "hashtag_set", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 206, assetType: "carousel_ad", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 207, assetType: "whatsapp_promo", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 208, assetType: "email_copy", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 209, assetType: "launch_pack", metadata: { creativeBriefFingerprint: fp } }),
        buildCampaignAsset({ id: 210, assetType: "caption_adaptation", metadata: { creativeBriefFingerprint: fp } }),
      ],
      approvals: [buildApproval("approved")],
    });

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.requiredOutputs.leaflet.current).toBe(true);
    expect(result.requiredOutputs.captionPack.current).toBe(true);
  });

  it("rejects a content post that only writes creativeFingerprint without the Brief suffix", () => {
    const campaign = buildCampaign();

    expect(getRecordFingerprint(buildContentPost({ metadata: { creativeFingerprint: "any-value" } }))).toBeNull();
    expect(getRecordFingerprint(buildContentPost({ metadata: { creativeBriefFingerprint: currentFingerprint(campaign) } }))).toBe(currentFingerprint(campaign));
  });
});
