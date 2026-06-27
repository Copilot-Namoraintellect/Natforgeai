import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { publishToInstagram, isInstagramPublishingReady } from "../platforms";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

describe("Instagram publishing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a media container and publishes it with a public image URL", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "container_123" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "media_456" }),
      } as Response);

    const imageUrl = "https://natforgeai.com/generated/images/27/premium.png";
    const result = await publishToInstagram("page-token", "ig_biz_123", {
      text: "Great offer!",
      mediaUrls: [imageUrl],
      mediaType: "image",
    });

    expect(result.success).toBe(true);
    expect(result.postId).toBe("media_456");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const containerCall = mockFetch.mock.calls[0][0] as string;
    expect(containerCall).toContain("/ig_biz_123/media");
    expect(containerCall).toContain("access_token=page-token");
    expect(containerCall).toContain(
      `image_url=${encodeURIComponent(imageUrl)}`
    );
    expect(containerCall).toContain("caption=Great+offer%21");

    const publishCall = mockFetch.mock.calls[1][0] as string;
    expect(publishCall).toContain("/ig_biz_123/media_publish");
    expect(publishCall).toContain("creation_id=container_123");
  });

  it("returns an error when no image URL is provided", async () => {
    const result = await publishToInstagram("page-token", "ig_biz_123", {
      text: "Text only",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("valid public image URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an error for invalid/local image URLs", async () => {
    const result = await publishToInstagram("page-token", "ig_biz_123", {
      text: "Great offer!",
      mediaUrls: ["blob:https://natforgeai.com/abc"],
      mediaType: "image",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("valid public image URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an error when container creation fails", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: "Invalid image format" } }),
    } as Response);

    const result = await publishToInstagram("page-token", "ig_biz_123", {
      text: "Great offer!",
      mediaUrls: ["https://example.com/image.png"],
      mediaType: "image",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid image format");
  });

  describe("isInstagramPublishingReady", () => {
    it("returns true when connected with IG business account, page token and publishing permission", () => {
      const ready = isInstagramPublishingReady({
        status: "connected",
        permissions: ["instagram_basic", "instagram_content_publishing"],
        instagramBusinessAccountId: "ig_123",
        pageAccessTokenEncrypted: "encrypted",
      });
      expect(ready).toBe(true);
    });

    it("supports the legacy instagram_content_publish alias", () => {
      const ready = isInstagramPublishingReady({
        status: "connected",
        permissions: ["instagram_basic", "instagram_content_publish"],
        instagramBusinessAccountId: "ig_123",
        pageAccessTokenEncrypted: "encrypted",
      });
      expect(ready).toBe(true);
    });

    it("returns false when publishing permission is missing", () => {
      const ready = isInstagramPublishingReady({
        status: "connected",
        permissions: ["instagram_basic"],
        instagramBusinessAccountId: "ig_123",
        pageAccessTokenEncrypted: "encrypted",
      });
      expect(ready).toBe(false);
    });

    it("returns false when no linked Instagram account is stored", () => {
      const ready = isInstagramPublishingReady({
        status: "connected",
        permissions: ["instagram_content_publishing"],
        instagramBusinessAccountId: null,
        pageAccessTokenEncrypted: "encrypted",
      });
      expect(ready).toBe(false);
    });
  });
});
