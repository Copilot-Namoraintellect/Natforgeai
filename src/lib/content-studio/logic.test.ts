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
  getPublishResultToast,
  getLeafletActions,
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

describe("publish dialog UX", () => {
  // These tests mirror the modal decisions in ContentStudio.tsx so the
  // publishing flow can be verified without a browser/DOM test environment.
  function getDialogState(
    platformsCsv: string,
    integrations: Parameters<typeof getCampaignPlatformStatuses>[1],
    config: Parameters<typeof getCampaignPlatformStatuses>[2]
  ) {
    const statuses = getCampaignPlatformStatuses(platformsCsv, integrations, config);
    return {
      hasConnected: hasConnectedPublishPlatform(statuses),
      statuses,
      integrationsUrl: buildIntegrationsReturnUrl(28),
    };
  }

  it("detects no connected platforms and shows setup + manual posting actions", () => {
    const { hasConnected, statuses, integrationsUrl } = getDialogState(
      "facebook, instagram, linkedin",
      [],
      { metaConfigured: true, linkedinConfigured: true }
    );
    expect(hasConnected).toBe(false);
    expect(statuses.every((s) => s.status === "not_connected")).toBe(true);
    expect(integrationsUrl).toBe("/integrations?returnTo=%2Fcontent%3FcampaignId%3D28");
  });

  it("keeps the connected-platform flow unchanged when platforms are connected", () => {
    const { hasConnected, statuses } = getDialogState(
      "facebook, instagram",
      [{ platform: "facebook", status: "connected", ready: true }],
      { metaConfigured: true }
    );
    expect(hasConnected).toBe(true);
    expect(statuses).toContainEqual({ platform: "facebook", status: "connected" });
    expect(statuses).toContainEqual({ platform: "instagram", status: "not_connected" });
  });

  it("treats manual-only platforms as not connected for auto-publish decision", () => {
    const { hasConnected, statuses } = getDialogState(
      "tiktok, email",
      [],
      undefined
    );
    expect(hasConnected).toBe(false);
    expect(statuses).toContainEqual({ platform: "tiktok", status: "manual" });
    expect(statuses).toContainEqual({ platform: "email", status: "manual" });
  });

  it("still offers manual posting when no platforms are selected for the campaign", () => {
    const { hasConnected, statuses } = getDialogState("", [], undefined);
    expect(hasConnected).toBe(false);
    expect(statuses).toEqual([]);
  });

  it("preserves campaign context in the integrations return URL for any campaign id", () => {
    expect(buildIntegrationsReturnUrl(1)).toBe(
      "/integrations?returnTo=%2Fcontent%3FcampaignId%3D1"
    );
    expect(buildIntegrationsReturnUrl(999)).toBe(
      "/integrations?returnTo=%2Fcontent%3FcampaignId%3D999"
    );
  });
});


describe("business-scoped integration matching", () => {
  const integration = (platform: string, businessId: number | null, ready = true) => ({
    platform,
    status: "connected" as const,
    ready,
    businessId,
  });

  it("ignores a connected integration that belongs to a different business", () => {
    const integrations = [integration("instagram", 99)];
    expect(isPlatformConnected("instagram", integrations, 24)).toBe(false);
    expect(
      getCampaignPlatformStatuses("instagram", integrations, { metaConfigured: true }, 24)
    ).toEqual([{ platform: "instagram", status: "not_connected" }]);
  });

  it("matches a connected integration that belongs to the same business", () => {
    const integrations = [integration("instagram", 24)];
    expect(isPlatformConnected("instagram", integrations, 24)).toBe(true);
    expect(
      getCampaignPlatformStatuses("instagram", integrations, { metaConfigured: true }, 24)
    ).toEqual([{ platform: "instagram", status: "connected" }]);
  });

  it("treats legacy integrations with no businessId as valid for any business", () => {
    const integrations = [integration("facebook", null)];
    expect(isPlatformConnected("facebook", integrations, 24)).toBe(true);
    expect(
      getCampaignPlatformStatuses("facebook", integrations, { metaConfigured: true }, 24)
    ).toEqual([{ platform: "facebook", status: "connected" }]);
  });

  it("falls back to no-business scoping when campaign businessId is not provided", () => {
    const integrations = [integration("instagram", 99)];
    expect(isPlatformConnected("instagram", integrations)).toBe(true);
    expect(
      getCampaignPlatformStatuses("instagram", integrations, { metaConfigured: true })
    ).toEqual([{ platform: "instagram", status: "connected" }]);
  });
});

describe("publish result toast messages", () => {
  it("shows manual posting message when no connected platforms were eligible", () => {
    const toast = getPublishResultToast({ manualPosting: true, manualCount: 3 });
    expect(toast.type).toBe("success");
    expect(toast.message).toBe("Marked for manual posting. 3 item(s) ready.");
  });

  it("shows published success when all platforms published", () => {
    const toast = getPublishResultToast({ publishedCount: 2, failedCount: 0, skippedCount: 0 });
    expect(toast.type).toBe("success");
    expect(toast.message).toBe("Campaign pack published. 2 platform(s) published.");
  });

  it("shows partial success when some platforms failed or skipped", () => {
    const toast = getPublishResultToast({ publishedCount: 1, failedCount: 1, skippedCount: 0 });
    expect(toast.type).toBe("success");
    expect(toast.message).toBe("1 platform(s) published. 1 failed, 0 skipped.");
  });

  it("shows warning when every platform was skipped", () => {
    const toast = getPublishResultToast({ publishedCount: 0, failedCount: 0, skippedCount: 2 });
    expect(toast.type).toBe("warning");
    expect(toast.message).toBe("Publishing skipped: 2 platform(s) not ready.");
  });

  it("shows error with the first result error when nothing published", () => {
    const toast = getPublishResultToast({
      publishedCount: 0,
      failedCount: 1,
      skippedCount: 0,
      results: [{ status: "failed", error: "Token expired" }],
    });
    expect(toast.type).toBe("error");
    expect(toast.message).toBe("Token expired");
  });

  it("shows a generic error when no results are returned", () => {
    const toast = getPublishResultToast({ publishedCount: 0, failedCount: 0, skippedCount: 0 });
    expect(toast.type).toBe("error");
    expect(toast.message).toBe("Publishing failed. Check platform connections and try again.");
  });
});

describe("getLeafletActions", () => {
  it("shows a primary generate action when no leaflet exists", () => {
    const actions = getLeafletActions({});
    expect(actions.primary.action).toBe("generate");
    expect(actions.secondary).toBeUndefined();
    expect(actions.failure).toEqual([]);
  });

  it("shows a primary improve action and download secondary when a leaflet is ready", () => {
    const actions = getLeafletActions({ imageUrl: "https://example.com/leaflet.png" });
    expect(actions.primary.action).toBe("improve");
    expect(actions.secondary?.action).toBe("download");
    expect(actions.advanced).toContain("basicDraft");
    expect(actions.advanced).toContain("internalTemplate");
    expect(actions.advanced).toContain("viewHistory");
  });

  it("includes regenerate with AI only when OpenAI is configured", () => {
    const withoutAi = getLeafletActions({ imageUrl: "https://example.com/leaflet.png" });
    expect(withoutAi.advanced).not.toContain("regenerateAi");

    const withAi = getLeafletActions({
      imageUrl: "https://example.com/leaflet.png",
      openAiConfigured: true,
    });
    expect(withAi.advanced).toContain("regenerateAi");
  });

  it("includes apply layout changes only when a refinement instruction is present", () => {
    const noInstruction = getLeafletActions({ imageUrl: "https://example.com/leaflet.png" });
    expect(noInstruction.advanced).not.toContain("applyLayoutChanges");

    const withInstruction = getLeafletActions({
      imageUrl: "https://example.com/leaflet.png",
      hasRefinementInstruction: true,
    });
    expect(withInstruction.advanced).toContain("applyLayoutChanges");
  });

  it("disables the primary action when a logo is required but missing", () => {
    const actions = getLeafletActions({ hasLogo: false, allowNoLogo: false });
    expect(actions.primary.disabled).toBe(true);

    const allowed = getLeafletActions({ hasLogo: false, allowNoLogo: true });
    expect(allowed.primary.disabled).toBe(false);
  });

  it("shows failure actions when generation failed", () => {
    const actions = getLeafletActions({ isFailed: true });
    expect(actions.failure).toEqual(["tryAgain", "safeTemplate", "contactSupport"]);
    expect(actions.advanced).toEqual([]);
  });
});
