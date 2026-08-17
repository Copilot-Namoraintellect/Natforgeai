import { describe, it, expect } from "vitest";
import {
  asNumber,
  getLatestReadyImageAsset,
  getCampaignImageAssetUrl,
  getImageUrl,
  findLeafletCandidate,
  findDurableLeafletRecord,
  resolveLeafletPreviewState,
  type LeafletPreviewState,
  getCampaignPlatformStatuses,
  hasConnectedPublishPlatform,
  isPlatformConnected,
  isPlatformConfigurable,
  getPlatformPublishStatus,
  buildIntegrationsReturnUrl,
  getPublishResultToast,
  getLeafletActions,
  getPublishDialogButtonLabel,
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

  describe("findLeafletCandidate / findDurableLeafletRecord", () => {
    it("prefers the newest explicit leaflet record with a usable URL", () => {
      const items = [
        { id: 1, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "https://example.com/leaflet.png" } },
        { id: 2, createdAt: "2026-08-02T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "https://example.com/leaflet2.png" } },
      ];
      expect((findLeafletCandidate(items) as any)?.id).toBe(2);
      expect((findDurableLeafletRecord(items) as any)?.id).toBe(2);
    });

    it("accepts a legacy master_campaign_post record with a usable URL", () => {
      const record = {
        id: 1,
        createdAt: "2026-08-01T00:00:00Z",
        metadata: { assetKind: "master_campaign_post", imageUrl: "https://example.com/leaflet.png" },
      };
      expect(findLeafletCandidate([record])).toBe(record);
      expect(findDurableLeafletRecord([record])).toBe(record);
    });

    it("accepts a record-level assetType leaflet with a usable URL", () => {
      const record = {
        id: 1,
        createdAt: "2026-08-01T00:00:00Z",
        assetType: "leaflet",
        url: "https://example.com/leaflet.png",
        metadata: {},
      };
      expect(findLeafletCandidate([record])).toBe(record);
      expect(findDurableLeafletRecord([record])).toBe(record);
    });

    it("ignores records without a non-empty preview URL", () => {
      const items = [
        { id: 1, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet" } },
        { id: 2, createdAt: "2026-08-02T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "" } },
      ];
      expect(findLeafletCandidate(items)).toBeUndefined();
      expect(findDurableLeafletRecord(items)).toBeUndefined();
    });

    it("does not treat a plain generated social post as a leaflet", () => {
      expect(findLeafletCandidate([{ type: "social_post", aiGenerated: true, createdAt: "2026-08-01T00:00:00Z" }])).toBeUndefined();
      expect(findDurableLeafletRecord([{ type: "social_post", aiGenerated: true, createdAt: "2026-08-01T00:00:00Z" }])).toBeUndefined();
    });

    it("does not treat an aiGenerated social post with an imageUrl as a leaflet", () => {
      expect(
        findLeafletCandidate([
          {
            type: "social_post",
            aiGenerated: true,
            createdAt: "2026-08-01T00:00:00Z",
            metadata: { imageUrl: "https://example.com/post.png" },
          },
        ])
      ).toBeUndefined();
      expect(
        findDurableLeafletRecord([
          {
            type: "social_post",
            aiGenerated: true,
            createdAt: "2026-08-01T00:00:00Z",
            metadata: { imageUrl: "https://example.com/post.png" },
          },
        ])
      ).toBeUndefined();
    });

    it("does not treat an OpenAI source image as a leaflet", () => {
      expect(
        findLeafletCandidate([
          {
            id: 1,
            createdAt: "2026-08-01T00:00:00Z",
            metadata: { imageSource: "openai", imageUrl: "https://example.com/openai.png" },
          },
        ])
      ).toBeUndefined();
      expect(
        findDurableLeafletRecord([
          {
            id: 1,
            createdAt: "2026-08-01T00:00:00Z",
            metadata: { imageSource: "openai", imageUrl: "https://example.com/openai.png" },
          },
        ])
      ).toBeUndefined();
    });

    it("does not treat a generic image with a provider as a leaflet", () => {
      expect(
        findLeafletCandidate([
          {
            id: 1,
            createdAt: "2026-08-01T00:00:00Z",
            provider: "internal",
            assetType: "image",
            url: "https://example.com/generic.png",
            metadata: {},
          },
        ])
      ).toBeUndefined();
      expect(
        findDurableLeafletRecord([
          {
            id: 1,
            createdAt: "2026-08-01T00:00:00Z",
            provider: "internal",
            assetType: "image",
            url: "https://example.com/generic.png",
            metadata: {},
          },
        ])
      ).toBeUndefined();
    });

    it("does not treat supporting text assets with imageUrl metadata as leaflets", () => {
      const assets = [
        { id: 1, assetType: "caption_pack", createdAt: "2026-08-01T00:00:00Z", metadata: { imageUrl: "x.png" } },
        { id: 2, assetType: "message_pack", createdAt: "2026-08-01T00:00:00Z", metadata: { imageUrl: "y.png" } },
      ];
      expect(findLeafletCandidate(assets)).toBeUndefined();
      expect(findDurableLeafletRecord(assets)).toBeUndefined();
    });

    it("rejects malformed or unusable preview URLs", () => {
      const candidates = [
        { id: 1, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: null } },
        { id: 2, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "" } },
        { id: 3, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "   " } },
        { id: 4, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "[object Object]" } },
        { id: 5, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", imageUrl: "javascript:alert(1)" } },
        { id: 6, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "leaflet", url: { path: "/oops.png" } } },
      ];
      for (const c of candidates) {
        expect(findLeafletCandidate([c])).toBeUndefined();
        expect(findDurableLeafletRecord([c])).toBeUndefined();
      }
    });

    it("ignores caption pack assets", () => {
      expect(findLeafletCandidate([{ id: 1, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "caption_pack", imageUrl: "x.png" } }])).toBeUndefined();
      expect(findDurableLeafletRecord([{ id: 1, createdAt: "2026-08-01T00:00:00Z", metadata: { assetType: "caption_pack", imageUrl: "x.png" } }])).toBeUndefined();
    });
  });

  describe("resolveLeafletPreviewState", () => {
    it("returns ready when a durable leaflet record with a usable URL exists", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: { url: "https://example.com/leaflet.png", status: "ready" },
      });
      expect(state.status).toBe("ready");
      expect((state as Extract<LeafletPreviewState, { status: "ready" }>).imageUrl).toBe("https://example.com/leaflet.png");
    });

    it("returns not_generated when generated metadata exists but no durable preview URL exists", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: { url: "", status: "ready" },
      });
      expect(state.status).toBe("not_generated");
    });

    it("returns not_generated after a completed creative run without a leaflet record", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: null,
        job: { status: "completed" },
      });
      expect(state.status).toBe("not_generated");
    });

    it("returns not_generated for an audience-ready campaign without a leaflet record", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: null,
        job: null,
      });
      expect(state.status).toBe("not_generated");
    });

    it("returns generating while a leaflet-specific job is queued or processing", () => {
      expect(resolveLeafletPreviewState({ durableRecord: null, job: { status: "queued" } }).status).toBe("generating");
      expect(resolveLeafletPreviewState({ durableRecord: null, job: { status: "processing" } }).status).toBe("generating");
      expect(resolveLeafletPreviewState({ durableRecord: null, job: { status: "preparing" } }).status).toBe("generating");
    });

    it("returns failed when the leaflet job failed", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: null,
        job: { status: "failed", error: "Provider rejected the prompt" },
      });
      expect(state.status).toBe("failed");
      expect((state as Extract<LeafletPreviewState, { status: "failed" }>).error).toBe("Provider rejected the prompt");
    });

    it("returns cancelled when the leaflet job was cancelled", () => {
      expect(resolveLeafletPreviewState({ durableRecord: null, job: { status: "cancelled" } }).status).toBe("cancelled");
    });

    it("returns timed_out when polling exceeded its bounded limit", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: null,
        job: { status: "processing" },
        timedOut: { attempts: 24, elapsedMs: 60000 },
      });
      expect(state.status).toBe("timed_out");
      expect((state as Extract<LeafletPreviewState, { status: "timed_out" }>).attempts).toBe(24);
    });

    it("returns ready over generating when a durable record appears while a job is still active", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: { url: "https://example.com/leaflet.png" },
        job: { status: "processing" },
      });
      expect(state.status).toBe("ready");
    });

    it("returns failed when a durable record is present but marked failed", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: { url: "", status: "failed", error: "Image render failed" },
      });
      expect(state.status).toBe("failed");
    });

    it("prefers an explicit error over a generic message when failed", () => {
      const state = resolveLeafletPreviewState({
        durableRecord: null,
        job: { status: "failed" },
        error: "Manual generation error",
      });
      expect(state.status).toBe("failed");
      expect((state as Extract<LeafletPreviewState, { status: "failed" }>).error).toBe("Manual generation error");
    });

    it("rejects malformed or placeholder preview URLs", () => {
      const urls = ["", "   ", "[object Object]", "javascript:alert(1)", null as any, { path: "/nope.png" } as any];
      for (const url of urls) {
        expect(
          resolveLeafletPreviewState({ durableRecord: { url, status: "ready" } }).status
        ).toBe("not_generated");
      }
    });

    it("does not treat a premium/audience_ready campaign without an explicit leaflet as ready", () => {
      expect(
        resolveLeafletPreviewState({
          durableRecord: null,
          job: null,
        }).status
      ).toBe("not_generated");
    });

    it("does not treat saved assets without a leaflet record as ready", () => {
      expect(
        resolveLeafletPreviewState({
          durableRecord: null,
          job: { status: "completed" },
        }).status
      ).toBe("not_generated");
    });

    it("does not treat a completed creative run without a leaflet as ready", () => {
      expect(
        resolveLeafletPreviewState({
          durableRecord: null,
          job: { status: "completed" },
        }).status
      ).toBe("not_generated");
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
    expect(toast.message).toBe("1 platform(s) published. 1 failed.");
  });

  it("shows warning when some platforms are pending approval", () => {
    const toast = getPublishResultToast({ publishedCount: 1, pendingApprovalCount: 1 });
    expect(toast.type).toBe("warning");
    expect(toast.message).toBe("1 platform(s) published. 1 platform(s) pending approval.");
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

describe("getPublishDialogButtonLabel", () => {
  it("returns Confirm Publish when ready and connected platforms exist", () => {
    const label = getPublishDialogButtonLabel({
      isPending: false,
      unavailableReason: "ready",
      isRepublish: false,
    });
    expect(label).toBe("Confirm Publish");
    expect(label).not.toBe("Confirm Manual Posting");
  });

  it("returns Publish again when ready and republishing", () => {
    const label = getPublishDialogButtonLabel({
      isPending: false,
      unavailableReason: "ready",
      isRepublish: true,
    });
    expect(label).toBe("Publish again");
    expect(label).not.toBe("Post manually again");
  });

  it("never returns Confirm Manual Posting for a ready campaign", () => {
    const reasons: Array<"ready" | "no_publishable_content" | "strategy_approval_required" | "launch_approval_required"> = [
      "ready",
      "no_publishable_content",
      "strategy_approval_required",
      "launch_approval_required",
    ];
    for (const unavailableReason of reasons) {
      const label = getPublishDialogButtonLabel({
        isPending: false,
        unavailableReason,
        isRepublish: false,
      });
      expect(label).not.toBe("Confirm Manual Posting");
    }
  });

  it("returns Confirm Manual Posting only for no_connected_platforms", () => {
    const label = getPublishDialogButtonLabel({
      isPending: false,
      unavailableReason: "no_connected_platforms",
      isRepublish: false,
    });
    expect(label).toBe("Confirm Manual Posting");
  });
});
