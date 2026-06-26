import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  publishToFacebook,
  isFacebookPublishingReady,
  selectFacebookPage,
  getFacebookPages,
} from "../platforms";

describe("Facebook publishing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("publishToFacebook", () => {
    it("posts a text-only message to a page feed", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "123_456" }),
      } as Response);

      const result = await publishToFacebook("page-token", "123456789", {
        text: "Smoke test message",
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBe("123_456");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/123456789/feed");
      expect(calledUrl).toContain("access_token=page-token");
      expect(calledUrl).toContain("message=Smoke+test+message");
    });

    it("posts a photo when media URL is provided", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "123_789" }),
      } as Response);

      const result = await publishToFacebook("page-token", "123456789", {
        text: "Photo post",
        mediaUrls: ["https://example.com/image.png"],
        mediaType: "image",
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBe("123_789");
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/123456789/photos");
      expect(calledUrl).toContain("url=https%3A%2F%2Fexample.com%2Fimage.png");
    });

    it("returns an error when Graph API responds with an error", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: { message: "Invalid token" } }),
      } as Response);

      const result = await publishToFacebook("bad-token", "123456789", {
        text: "Will fail",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid token");
    });
  });

  describe("isFacebookPublishingReady", () => {
    it("returns true for connected integration with pages_manage_posts", () => {
      const ready = isFacebookPublishingReady({
        status: "connected",
        permissions: ["pages_show_list", "pages_manage_posts"],
        pageId: "123",
        pageAccessTokenEncrypted: "encrypted",
      });
      expect(ready).toBe(true);
    });

    it("returns false when status is not connected", () => {
      const ready = isFacebookPublishingReady({
        status: "expired",
        permissions: ["pages_manage_posts"],
      });
      expect(ready).toBe(false);
    });

    it("returns false when pages_manage_posts is missing", () => {
      const ready = isFacebookPublishingReady({
        status: "connected",
        permissions: ["pages_show_list", "email"],
      });
      expect(ready).toBe(false);
    });

    it("does not require pages_messaging for publishing readiness", () => {
      const ready = isFacebookPublishingReady({
        status: "connected",
        permissions: ["pages_show_list", "pages_manage_posts"],
      });
      expect(ready).toBe(true);
    });
  });

  describe("selectFacebookPage", () => {
    it("returns the preferred page when provided", () => {
      const pages = [
        { id: "1", name: "Page One", access_token: "token1" },
        { id: "2", name: "Page Two", access_token: "token2" },
      ];
      const selected = selectFacebookPage(pages, "2");
      expect(selected?.name).toBe("Page Two");
    });

    it("falls back to the first page when no preference is provided", () => {
      const pages = [
        { id: "1", name: "Page One", access_token: "token1" },
        { id: "2", name: "Page Two", access_token: "token2" },
      ];
      const selected = selectFacebookPage(pages);
      expect(selected?.name).toBe("Page One");
    });

    it("falls back to the first page when the preferred page is not found", () => {
      const pages = [{ id: "1", name: "Page One", access_token: "token1" }];
      const selected = selectFacebookPage(pages, "99");
      expect(selected?.name).toBe("Page One");
    });
  });

  describe("getFacebookPages", () => {
    it("returns pages from the Graph API response", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "1", name: "Page One", access_token: "token1", category: "Business" },
          ],
        }),
      } as Response);

      const pages = await getFacebookPages("user-token");
      expect(pages).toHaveLength(1);
      expect(pages[0].id).toBe("1");
      expect(pages[0].access_token).toBe("token1");
    });
  });
});
