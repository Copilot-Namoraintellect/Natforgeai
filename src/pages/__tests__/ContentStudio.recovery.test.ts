import { describe, it, expect } from "vitest";
import {
  campaignNeedsRecoveryDecision,
  campaignHasGeneratedContent,
  asNumber,
  asString,
  getImageUrl,
} from "../../lib/content-studio/logic";

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
