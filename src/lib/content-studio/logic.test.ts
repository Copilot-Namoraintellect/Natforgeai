import { describe, it, expect } from "vitest";
import {
  asNumber,
  getLatestReadyImageAsset,
  getCampaignImageAssetUrl,
  getImageUrl,
  findLeafletCandidate,
  getCampaignPlatformStatuses,
  hasConnectedPublishPlatform,
  isPlatformConnected,
  isPlatformConfigurable,
  getPlatformPublishStatus,
  buildIntegrationsReturnUrl,
} from "./logic";

describe("content-studio logic", () => {
  describe("asNumber", () => {
    it("parses numbers and numeric strings", () => {
      expect(asNumber(7)).toBe(7);
      expect(asNumber("42")).toBe(42);
      expect(asNumber("abc")).toBeNull();
      expect(asNumber(null)).toBeNull();
    });
  });

  describe("getLatestReadyImageAsset", () => {
    it("returns the newest ready image asset by createdAt", () => {
      const assets = [
        {
          id: 1,
          assetType: "image",
          status: "ready",
          url: "https://example.com/old.png",
          createdAt: "2026-06-01T10:00:00Z",
          metadata: {},
        },
        {
          id: 2,
          assetType: "image",
          status: "ready",
          url: "https://example.com/new.png",
          createdAt: "2026-06-03T10:00:00Z",
          metadata: {},
        },
        {
          id: 3,
          assetType: "image",
          status: "generating",
          url: "https://example.com/incomplete.png",
          createdAt: "2026-06-04T10:00:00Z",
          metadata: {},
        },
      ];
      const latest = getLatestReadyImageAsset(assets);
      expect(latest?.id).toBe(2);
      expect(getCampaignImageAssetUrl(assets)).toBe("https://example.com/new.png");
    });

    it("filters by contentPostId when provided", () => {
      const assets = [
        {
          id: 1,
          assetType: "image",
          status: "ready",
          url: "https://example.com/post-a.png",
          contentPostId: 10,
          createdAt: "2026-06-03T10:00:00Z",
          metadata: {},
        },
        {
          id: 2,
          assetType: "image",
          status: "ready",
          url: "https://example.com/post-b.png",
          contentPostId: 20,
          createdAt: "2026-06-04T10:00:00Z",
          metadata: {},
        },
      ];
      expect(getLatestReadyImageAsset(assets, { contentPostId: 10 })?.id).toBe(1);
      expect(getCampaignImageAssetUrl(assets, { contentPostId: 10 })).toBe(
        "https://example.com/post-a.png"
      );
    });

    it("falls back to metadata contentPostId when asset field is missing", () => {
      const assets = [
        {
          id: 1,
          assetType: "image",
          status: "ready",
          url: "https://example.com/fallback.png",
          createdAt: "2026-06-03T10:00:00Z",
          metadata: { contentPostId: 30 },
        },
      ];
      expect(getLatestReadyImageAsset(assets, { contentPostId: 30 })?.id).toBe(1);
    });

    it("returns undefined when no ready image exists", () => {
      expect(getLatestReadyImageAsset([])).toBeUndefined();
      expect(
        getLatestReadyImageAsset([
          { id: 1, assetType: "caption_pack", status: "ready", createdAt: "2026-06-01T10:00:00Z", metadata: {} },
        ])
      ).toBeUndefined();
    });
  });

  describe("getImageUrl", () => {
    it("prefers imageUrl from metadata, then url, then campaign assets", () => {
      const item = { metadata: { imageUrl: "https://example.com/item.png" } };
      expect(getImageUrl(item)).toBe("https://example.com/item.png");
      expect(getImageUrl({ url: "https://example.com/direct.png" })).toBe(
        "https://example.com/direct.png"
      );
      expect(
        getImageUrl({ metadata: {} }, [
          {
            id: 1,
            assetType: "image",
            status: "ready",
            url: "https://example.com/asset.png",
            createdAt: "2026-06-01T10:00:00Z",
            metadata: {},
          },
        ])
      ).toBe("https://example.com/asset.png");
    });
  });

  describe("findLeafletCandidate", () => {
    it("prefers items with leaflet metadata", () => {
      const items = [
        { id: 1, metadata: { imageProvider: "openai-leaflet" } },
        { id: 2, metadata: { assetType: "leaflet" } },
      ];
      expect((findLeafletCandidate(items) as any)?.id).toBe(2);
    });

    it("falls back to OpenAI provider or imageUrl-bearing records", () => {
      expect((findLeafletCandidate([{ metadata: { imageProvider: "openai-leaflet" } }]) as any)?.metadata?.imageProvider).toBe(
        "openai-leaflet"
      );
      expect(findLeafletCandidate([{ type: "social_post", aiGenerated: true }])).toBeTruthy();
    });

    it("ignores caption pack assets", () => {
      expect(findLeafletCandidate([{ metadata: { assetType: "caption_pack", imageUrl: "x.png" } }])).toBeUndefined();
    });
  });
});


describe("publishing platform detection", () => {
  it("detects a connected Facebook integration", () => {
    expect(isPlatformConnected("facebook", [])).toBe(false);
    expect(isPlatformConnected("facebook", [{ platform: "facebook", status: "connected", ready: true }])).toBe(true);
    expect(isPlatformConnected("facebook", [{ platform: "facebook", status: "connected", ready: false }])).toBe(false);
  });

  it("treats non-connectable platforms as always connected", () => {
    expect(isPlatformConnected("email", [])).toBe(true);
    expect(isPlatformConnected("blog", [])).toBe(true);
  });

  it("checks platform configurability from config status", () => {
    expect(isPlatformConfigurable("facebook", undefined)).toBe(true);
    expect(isPlatformConfigurable("facebook", { metaConfigured: false })).toBe(false);
    expect(isPlatformConfigurable("facebook", { metaConfigured: true })).toBe(true);
    expect(isPlatformConfigurable("linkedin", { linkedinConfigured: true })).toBe(true);
  });

  it("classifies platform publish statuses", () => {
    const connected = [{ platform: "facebook", status: "connected", ready: true }];
    expect(getPlatformPublishStatus("facebook", connected, { metaConfigured: true })).toBe("connected");
    expect(getPlatformPublishStatus("facebook", connected, { metaConfigured: false })).toBe("manual");
    expect(getPlatformPublishStatus("facebook", [], { metaConfigured: true })).toBe("not_connected");
    expect(getPlatformPublishStatus("instagram", [], undefined)).toBe("not_connected");
    expect(getPlatformPublishStatus("tiktok", [], undefined)).toBe("manual");
    expect(getPlatformPublishStatus("google ads", [], undefined)).toBe("not_supported");
  });

  it("groups campaign platform statuses and detects connected platforms", () => {
    const statuses = getCampaignPlatformStatuses(
      "facebook, instagram, tiktok",
      [{ platform: "facebook", status: "connected", ready: true }],
      { metaConfigured: true }
    );
    expect(statuses).toEqual([
      { platform: "facebook", status: "connected" },
      { platform: "instagram", status: "not_connected" },
      { platform: "tiktok", status: "manual" },
    ]);
    expect(hasConnectedPublishPlatform(statuses)).toBe(true);
  });

  it("returns no connected platforms when none are connected", () => {
    const statuses = getCampaignPlatformStatuses(
      "facebook, instagram",
      [],
      { metaConfigured: true }
    );
    expect(hasConnectedPublishPlatform(statuses)).toBe(false);
  });

  it("builds integrations URL with returnTo campaign context", () => {
    expect(buildIntegrationsReturnUrl(28)).toBe(
      "/integrations?returnTo=%2Fcontent%3FcampaignId%3D28"
    );
    expect(buildIntegrationsReturnUrl(null)).toBe("/integrations");
    expect(buildIntegrationsReturnUrl("")).toBe("/integrations");
  });
});
