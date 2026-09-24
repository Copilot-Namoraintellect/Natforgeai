import { describe, expect, it, vi } from "vitest";
import { createFacebookAdapter } from "../facebook-adapter";
import {
  expectNoNetworkCall,
  fakePublishFailure,
  fakePublishSuccess,
  installNoNetworkGuard,
  makeAuthoritativeInput,
  AUTHORITATIVE_TEXT,
} from "./test-utils";

const DESTINATION = { accessToken: "decrypted-page-token", pageId: "123456789" };

installNoNetworkGuard();

describe("Facebook adapter (governed platform adapter boundary)", () => {
  it("transports authoritative copy byte-for-byte — hook, caption, and CTA unchanged", () => {
    const adapter = createFacebookAdapter();
    const input = makeAuthoritativeInput("publication:facebook:7");

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content).toBe(input.content);
    expect(request.content.text).toBe(AUTHORITATIVE_TEXT);
    expect(request.pageId).toBe("123456789");
  });

  it("cannot silently replace the CTA — the payload carries it exactly", () => {
    const adapter = createFacebookAdapter();
    const input = makeAuthoritativeInput(
      "publication:facebook:7",
      // a CTA value no generator would invent
      { text: "Hook line\n\nCaption body.\n\nCTA::☎ CALL 555-0199 — say ZEBRA::" }
    );

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content.text).toContain("CTA::☎ CALL 555-0199 — say ZEBRA::");
    expect(request.content.text).toBe(input.content.text);
  });

  it("builds the provider request deterministically", () => {
    const adapter = createFacebookAdapter();
    const input = makeAuthoritativeInput("publication:facebook:7");

    const first = adapter.buildProviderRequest(input, DESTINATION);
    const second = adapter.buildProviderRequest(makeAuthoritativeInput("publication:facebook:7"), {
      ...DESTINATION,
    });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("publishes through the existing provider seam with the decrypted token, page id, and verbatim payload", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishSuccess());
    const adapter = createFacebookAdapter({ publish });
    const input = makeAuthoritativeInput("publication:facebook:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("decrypted-page-token", "123456789", input.content);
    expect(receipt).toEqual({
      platform: "facebook",
      operationId: "publication:facebook:7",
      status: "published",
      externalPostId: "ext_post_123",
      externalUrl: "https://provider.example/p/ext_post_123",
    });
    expectNoNetworkCall();
  });

  it("preserves one operation identity across retries — no semantic regeneration", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce(fakePublishFailure("fetch failed"))
      .mockResolvedValueOnce(fakePublishSuccess());
    const adapter = createFacebookAdapter({ publish });
    const input = makeAuthoritativeInput("publication:facebook:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      operationId: "publication:facebook:7",
      category: "network",
      retryable: true,
    });

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(receipt.operationId).toBe("publication:facebook:7");
    // the retried submission carries the identical content object
    expect(publish).toHaveBeenLastCalledWith(
      "decrypted-page-token",
      "123456789",
      expect.objectContaining({ text: AUTHORITATIVE_TEXT })
    );
    expectNoNetworkCall();
  });

  it("normalizes provider failures into stable, categorized errors", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishFailure("Invalid token"));
    const adapter = createFacebookAdapter({ publish });
    const input = makeAuthoritativeInput("publication:facebook:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toEqual({
      platform: "facebook",
      category: "auth",
      code: "provider_auth",
      message: "Invalid token",
      retryable: false,
      operationId: "publication:facebook:7",
    });
    expectNoNetworkCall();
  });

  it("normalizes thrown provider exceptions through normalizeError", () => {
    const adapter = createFacebookAdapter();

    const normalized = adapter.normalizeError(new TypeError("fetch failed"), {
      operationId: "publication:facebook:9",
    });

    expect(normalized).toMatchObject({
      platform: "facebook",
      category: "network",
      retryable: true,
      operationId: "publication:facebook:9",
    });
  });

  it("validates input and destination structurally without touching copy", () => {
    const adapter = createFacebookAdapter();

    expect(adapter.validateInput(makeAuthoritativeInput()).ok).toBe(true);
    expect(
      adapter.validateInput({
        operationId: "op",
        content: { text: "   " },
      }).ok
    ).toBe(false);

    expect(adapter.validateDestination(DESTINATION).ok).toBe(true);
    expect(adapter.validateDestination({ accessToken: "", pageId: "1" }).issues[0]?.code).toBe(
      "destination_token_empty"
    );
    expect(adapter.validateDestination({ accessToken: "t", pageId: "" }).issues[0]?.code).toBe(
      "destination_page_empty"
    );
  });

  it("exposes normalizeReceipt for raw provider results", () => {
    const adapter = createFacebookAdapter();

    expect(
      adapter.normalizeReceipt(
        { success: true, postId: "123_456", url: "https://facebook.com/123_456" },
        { operationId: "publication:facebook:3" }
      )
    ).toEqual({
      platform: "facebook",
      operationId: "publication:facebook:3",
      status: "published",
      externalPostId: "123_456",
      externalUrl: "https://facebook.com/123_456",
    });
  });
});
