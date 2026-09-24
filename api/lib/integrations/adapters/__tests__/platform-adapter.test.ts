import { describe, expect, it } from "vitest";
import {
  assertTransportFidelity,
  classifyProviderErrorMessage,
  combineValidation,
  derivePublicationOperationId,
  normalizeAdapterError,
  normalizeProviderReceipt,
  validatePublishPayloadContent,
  validationIssue,
  validationOk,
} from "../platform-adapter";
import { makeAuthoritativeInput } from "./test-utils";

describe("platform-adapter contract (WBS13.3 governance machinery)", () => {
  describe("validatePublishPayloadContent", () => {
    it("accepts well-formed authoritative content", () => {
      const result = validatePublishPayloadContent(makeAuthoritativeInput().content);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("rejects empty text without mutating it", () => {
      const result = validatePublishPayloadContent({ text: "   " });
      expect(result.ok).toBe(false);
      expect(result.issues.map(i => i.code)).toContain("content_text_empty");
    });

    it("rejects malformed mediaUrls", () => {
      const result = validatePublishPayloadContent({ text: "x", mediaUrls: [""] });
      expect(result.ok).toBe(false);
      expect(result.issues.map(i => i.code)).toContain("content_media_invalid");
    });

    it("rejects unknown mediaType", () => {
      const result = validatePublishPayloadContent({
        text: "x",
        // @ts-expect-error deliberately wrong shape
        mediaType: "gif",
      });
      expect(result.ok).toBe(false);
      expect(result.issues.map(i => i.code)).toContain("content_media_type_invalid");
    });
  });

  describe("derivePublicationOperationId", () => {
    it("prefers the queue item id", () => {
      expect(
        derivePublicationOperationId({ queueItemId: 42, contentPostId: 9, platform: "facebook" })
      ).toBe("publication:facebook:42");
    });

    it("falls back to the content post id", () => {
      expect(
        derivePublicationOperationId({ contentPostId: 9, platform: "instagram" })
      ).toBe("publication:instagram:9");
    });

    it("is deterministic for the same reference", () => {
      const ref = { queueItemId: 42, platform: "twitter" };
      expect(derivePublicationOperationId(ref)).toBe(derivePublicationOperationId(ref));
    });

    it("fails closed when no stable id is available", () => {
      expect(() => derivePublicationOperationId({ platform: "facebook" })).toThrow(
        /stable queueItemId or contentPostId/
      );
    });
  });

  describe("assertTransportFidelity", () => {
    it("passes when transported text is byte-identical", () => {
      const input = makeAuthoritativeInput();
      expect(() => assertTransportFidelity(input, input.content.text)).not.toThrow();
    });

    it("fails closed on any semantic modification, including whitespace tampering", () => {
      const input = makeAuthoritativeInput();
      // trailing whitespace added in transport is a semantic modification —
      // the authoritative text must be transported byte-for-byte.
      expect(() => assertTransportFidelity(input, `${input.content.text} `)).toThrow(
        /semantic rewriting is prohibited/
      );
      expect(() =>
        assertTransportFidelity(input, input.content.text.replace("Book your demo", "Sign up"))
      ).toThrow(/semantic rewriting is prohibited/);
    });
  });

  describe("classifyProviderErrorMessage", () => {
    it.each([
      ["Invalid token", "auth", "provider_auth", false],
      ["401 Unauthorized", "auth", "provider_auth", false],
      ["Rate limit exceeded", "rate_limited", "provider_rate_limited", true],
      ["HTTP 429 too many requests", "rate_limited", "provider_rate_limited", true],
      ["fetch failed", "network", "provider_network", true],
      ["connect ETIMEDOUT", "network", "provider_network", true],
      ["Instagram publishing requires a valid public image URL.", "validation", "provider_validation", false],
      ["Platform tiktok not supported", "unsupported", "provider_unsupported", false],
      ["boom something else", "provider", "provider_error", true],
    ])("classifies %j as %s (retryable=%s)", (message, category, code, retryable) => {
      expect(classifyProviderErrorMessage(message as string)).toEqual({
        category,
        code,
        retryable,
      });
    });

    it("is deterministic: same message, same classification", () => {
      const a = classifyProviderErrorMessage("Invalid token");
      const b = classifyProviderErrorMessage("Invalid token");
      expect(a).toEqual(b);
    });
  });

  describe("normalizeAdapterError", () => {
    it("accepts Error instances, strings, and unknown values", () => {
      const fromError = normalizeAdapterError("facebook", new Error("Invalid token"), {
        operationId: "op-1",
      });
      expect(fromError).toMatchObject({
        platform: "facebook",
        category: "auth",
        retryable: false,
        operationId: "op-1",
      });

      const fromString = normalizeAdapterError("linkedin", "Rate limit exceeded");
      expect(fromString.category).toBe("rate_limited");

      const fromUnknown = normalizeAdapterError("twitter", { weird: true });
      expect(fromUnknown.category).toBe("provider");
      expect(fromUnknown.code).toBe("provider_error");
      expect(fromUnknown.operationId).toBeUndefined();
    });
  });

  describe("normalizeProviderReceipt", () => {
    it("maps provider fields and echoes the operation identity", () => {
      const receipt = normalizeProviderReceipt(
        "instagram",
        { success: true, postId: "1789", url: "https://instagram.com/p/1789" },
        { operationId: "publication:instagram:7" }
      );
      expect(receipt).toEqual({
        platform: "instagram",
        operationId: "publication:instagram:7",
        status: "published",
        externalPostId: "1789",
        externalUrl: "https://instagram.com/p/1789",
      });
    });
  });

  describe("combineValidation", () => {
    it("merges issues and flags ok only when all pass", () => {
      expect(
        combineValidation(validationOk(), validationIssue("a", "a"), validationIssue("b", "b"))
      ).toEqual({ ok: false, issues: [expect.objectContaining({ code: "a" }), expect.objectContaining({ code: "b" })] });
    });
  });
});
