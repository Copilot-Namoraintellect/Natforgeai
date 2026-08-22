import { describe, it, expect } from "vitest";
import {
  campaignNeedsRecoveryDecision,
  campaignHasGeneratedContent,
  asNumber,
  asString,
  getImageUrl,
  getApprovedMessagePackForDetails,
  selectBestApprovedMessagePack,
  getActiveGenerationRunId,
  isSupersededMessagePack,
  getStrategyActionDecision,
} from "../../lib/content-studio/logic";
import { REGENERATE_FROM_PROFILE_CONFIRMATION } from "../ContentStudio";

describe("campaignNeedsRecoveryDecision", () => {
  const campaign = { id: 28, workflowState: "creatives_generating" };

  it("returns false when posts exist even if older creative runs failed", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      2,
      [{ id: 123, type: "social_post" }],
      [
        { id: 91, status: "completed" },
        { id: 90, status: "failed" },
      ],
      []
    );
    expect(result).toBe(false);
  });

  it("returns false when posts exist and the latest creative run succeeded", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      2,
      [
        { id: 123, type: "social_post" },
        { id: 122, type: "video_concept" },
      ],
      [{ id: 91, status: "completed" }],
      []
    );
    expect(result).toBe(false);
  });

  it("returns true when no posts exist and the latest creative run failed", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      0,
      [],
      [{ id: 91, status: "failed" }],
      []
    );
    expect(result).toBe(true);
  });

  it("returns true when in creatives_generating and post count is zero", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      0,
      [],
      [],
      []
    );
    expect(result).toBe(true);
  });

  it("returns true when latest strategy run failed in strategy_generated state", () => {
    const result = campaignNeedsRecoveryDecision(
      { id: 28, workflowState: "strategy_generated" },
      0,
      [],
      [],
      [{ id: 87, status: "failed" }]
    );
    expect(result).toBe(true);
  });

  it("returns false for an older strategy failure once creative content exists", () => {
    const result = campaignNeedsRecoveryDecision(
      { id: 28, workflowState: "creatives_ready" },
      2,
      [{ id: 123, type: "social_post" }],
      [{ id: 91, status: "completed" }],
      [
        { id: 88, status: "failed" },
        { id: 87, status: "completed" },
      ]
    );
    expect(result).toBe(false);
  });
});

describe("campaignHasGeneratedContent", () => {
  it("returns true when posts exist", () => {
    expect(
      campaignHasGeneratedContent({ postCount: 2, contents: [], assets: [] })
    ).toBe(true);
  });

  it("returns true when contents exist", () => {
    expect(
      campaignHasGeneratedContent({
        postCount: 0,
        contents: [{ id: 1, type: "social_post" }],
        assets: [],
      })
    ).toBe(true);
  });

  it("returns true when assets exist", () => {
    expect(
      campaignHasGeneratedContent({
        postCount: 0,
        contents: [],
        assets: [{ id: 1, assetType: "caption_pack" }],
      })
    ).toBe(true);
  });

  it("returns false when nothing exists", () => {
    expect(
      campaignHasGeneratedContent({ postCount: 0, contents: [], assets: [] })
    ).toBe(false);
  });

  it("returns false for undefined/null inputs", () => {
    expect(
      campaignHasGeneratedContent({
        postCount: undefined,
        contents: undefined,
        assets: undefined,
      })
    ).toBe(false);
  });
});

describe("asNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(asNumber(1)).toBe(1);
    expect(asNumber(0)).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(asNumber("42")).toBe(42);
  });

  it("returns null for non-numeric strings", () => {
    expect(asNumber("abc")).toBeNull();
  });

  it("returns null for objects and arrays", () => {
    expect(asNumber({})).toBeNull();
    expect(asNumber([])).toBeNull();
  });

  it("returns null for NaN and Infinity", () => {
    expect(asNumber(NaN)).toBeNull();
    expect(asNumber(Infinity)).toBeNull();
  });
});

describe("asString", () => {
  it("returns non-empty strings", () => {
    expect(asString("hello")).toBe("hello");
  });

  it("returns null for empty or whitespace strings", () => {
    expect(asString("")).toBeNull();
    expect(asString("   ")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(asString(123)).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
  });
});

describe("getImageUrl", () => {
  it("resolves metadata imageUrl", () => {
    expect(getImageUrl({ metadata: { imageUrl: "https://example.com/img.png" } })).toBe(
      "https://example.com/img.png"
    );
  });

  it("resolves metadata url fallback", () => {
    expect(getImageUrl({ metadata: { url: "https://example.com/fallback.png" } })).toBe(
      "https://example.com/fallback.png"
    );
  });

  it("resolves record-level imageUrl", () => {
    expect(getImageUrl({ imageUrl: "https://example.com/direct.png" })).toBe(
      "https://example.com/direct.png"
    );
  });

  it("prefers metadata over record", () => {
    expect(
      getImageUrl({
        metadata: { imageUrl: "https://example.com/meta.png" },
        imageUrl: "https://example.com/record.png",
      })
    ).toBe("https://example.com/meta.png");
  });

  it("falls back to campaign image assets", () => {
    const assets = [
      { assetType: "image", status: "ready", url: "https://example.com/asset.png" },
    ];
    expect(getImageUrl({}, assets)).toBe("https://example.com/asset.png");
  });

  it("returns undefined when no image source exists", () => {
    expect(getImageUrl({})).toBeUndefined();
  });

  it("ignores non-ready assets", () => {
    const assets = [
      { assetType: "image", status: "pending", url: "https://example.com/pending.png" },
    ];
    expect(getImageUrl({}, assets)).toBeUndefined();
  });
});

const specificPack = {
  headline: "Instant payouts for restaurants, delivery platforms and frontline teams",
  subheadline: "Stop waiting for weekly settlement and reconciliation.",
  benefitBullets: [
    "Payouts for restaurants, delivery platforms and frontline teams",
    "Automated tips, commissions and supplier payouts",
    "Approved delivery orders settled without manual reconciliation",
  ],
  cta: "Book a Zuto Hub Demo",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  messagePackSource: "manual_restore",
  isGeneric: false,
  specificityScore: 104,
};

const genericPack = {
  headline: "Seamless Financial Solutions for Modern Businesses",
  subheadline: "Transform your business with our modern solutions.",
  benefitBullets: ["Quality service", "Professional team", "Great results"],
  cta: "Schedule a Consultation",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 60, rejections: [], warnings: [] },
  messagePackSource: "ai_refined_pack",
  isGeneric: true,
  specificityScore: 10,
};

describe("approved message pack selection", () => {
  it("ignores superseded message_pack assets", () => {
    const assets = [
      {
        id: 454,
        assetType: "message_pack",
        status: "ready",
        createdAt: "2026-07-01T00:00:00Z",
        metadata: { approvedMessagePack: genericPack, supersededBy: 457, isGeneric: true },
      },
      {
        id: 457,
        assetType: "message_pack",
        status: "ready",
        createdAt: "2026-07-02T00:00:00Z",
        metadata: { approvedMessagePack: specificPack, isGeneric: false },
      },
    ];
    const best = selectBestApprovedMessagePack(assets);
    expect(best?.headline).toBe(specificPack.headline);
    expect(best?.messagePackSource).toBe("manual_restore");
  });

  it("isSupersededMessagePack detects supersededBy at metadata or pack level", () => {
    expect(isSupersededMessagePack({ metadata: { supersededBy: 1 } })).toBe(true);
    expect(isSupersededMessagePack({ metadata: { approvedMessagePack: { supersededBy: 1 } } })).toBe(true);
    expect(isSupersededMessagePack({ metadata: { approvedMessagePack: {} } })).toBe(false);
  });

  it("getApprovedMessagePackForDetails prefers the latest ready image asset metadata", () => {
    const assets = [
      {
        id: 1,
        contentPostId: 100,
        provider: "openai",
        status: "completed",
        createdAt: "2026-07-01T00:00:00Z",
        url: "https://cdn.example.com/failed.png",
        metadata: {
          assetType: "leaflet",
          assetTier: "premium",
          source: "premium",
          imageStatus: "failed",
          approvedMessagePack: genericPack,
        },
      },
      {
        id: 2,
        contentPostId: 100,
        provider: "internal",
        status: "completed",
        createdAt: "2026-07-03T00:00:00Z",
        url: "https://cdn.example.com/ready.png",
        metadata: {
          assetType: "leaflet",
          assetTier: "premium",
          source: "premium",
          imageStatus: "ready",
          approvedMessagePack: specificPack,
          generationRunId: "premium-run-2",
        },
      },
      {
        id: 454,
        assetType: "message_pack",
        status: "ready",
        createdAt: "2026-07-01T00:00:00Z",
        metadata: { approvedMessagePack: genericPack, supersededBy: 457 },
      },
      {
        id: 457,
        assetType: "message_pack",
        status: "ready",
        createdAt: "2026-07-02T00:00:00Z",
        metadata: { approvedMessagePack: specificPack },
      },
    ];

    const pack = getApprovedMessagePackForDetails(assets, { contentPostId: 100 });
    expect(pack?.headline).toBe(specificPack.headline);
    expect(pack?.cta).toBe(specificPack.cta);
    expect(getActiveGenerationRunId(assets, { contentPostId: 100 })).toBe("premium-run-2");
  });

  it("getApprovedMessagePackForDetails falls back to ranked message_pack when image metadata lacks approvedMessagePack", () => {
    const assets = [
      {
        id: 2,
        contentPostId: 100,
        provider: "internal",
        status: "completed",
        createdAt: "2026-07-03T00:00:00Z",
        url: "https://cdn.example.com/ready.png",
        metadata: { assetType: "leaflet", assetTier: "premium", source: "premium", imageStatus: "ready" },
      },
      {
        id: 457,
        assetType: "message_pack",
        status: "ready",
        createdAt: "2026-07-02T00:00:00Z",
        metadata: { approvedMessagePack: specificPack },
      },
    ];

    const pack = getApprovedMessagePackForDetails(assets, { contentPostId: 100 });
    expect(pack?.headline).toBe(specificPack.headline);
  });
});

describe("getStrategyActionDecision after Regenerate from Profile", () => {
  it("offers strategy regeneration when the approved strategy is stale or missing", () => {
    const decision = getStrategyActionDecision({ isStale: true, canGenerateContent: false });
    expect(decision).toEqual({ label: "Regenerate Strategy for Approval", action: "regenerate" });
  });

  it("offers strategy regeneration when the backend reports the strategy must be regenerated", () => {
    const decision = getStrategyActionDecision({ canRegenerateStrategy: true, canGenerateContent: false });
    expect(decision).toEqual({ label: "Regenerate Strategy for Approval", action: "regenerate" });
  });

  it("does not offer content generation until the strategy is approved", () => {
    const decision = getStrategyActionDecision({
      isStale: true,
      canGenerateContent: false,
      canRegenerateStrategy: true,
    });
    expect(decision.action).not.toBe("generate");
    expect(decision.label).toBe("Regenerate Strategy for Approval");
  });

  it("allows generation from approved strategy only when the strategy is current and approved", () => {
    const decision = getStrategyActionDecision({
      isStale: false,
      canGenerateContent: true,
      canRegenerateStrategy: false,
    });
    expect(decision).toEqual({ label: "Generate from Approved Strategy", action: "generate" });
  });
});

describe("Regenerate from Profile confirmation wording", () => {
  it("says the strategy is regenerated from the business profile", () => {
    expect(REGENERATE_FROM_PROFILE_CONFIRMATION.toLowerCase()).toContain(
      "regenerate the campaign strategy from the current business profile"
    );
  });

  it("mentions Approval Centre / approval review", () => {
    expect(REGENERATE_FROM_PROFILE_CONFIRMATION.toLowerCase()).toMatch(
      /approval centre|approval review|review.*approval|approval.*review/
    );
  });

  it("states that creative generation occurs only after approval", () => {
    expect(REGENERATE_FROM_PROFILE_CONFIRMATION.toLowerCase()).toMatch(
      /creative content will only be generated after the strategy is approved/
    );
  });

  it("does not promise immediate regeneration of leaflets, captions, platform adaptations or other creative content", () => {
    const lower = REGENERATE_FROM_PROFILE_CONFIRMATION.toLowerCase();
    expect(lower).not.toContain("leaflet");
    expect(lower).not.toContain("captions");
    expect(lower).not.toContain("platform adaptations");
    expect(lower).not.toContain("posts");
    expect(lower).not.toContain("images");
    expect(lower).not.toContain("regenerate content");
    expect(lower).not.toContain("creative assets");
  });
});
