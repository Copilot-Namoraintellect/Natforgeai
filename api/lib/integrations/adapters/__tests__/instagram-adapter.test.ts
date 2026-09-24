import { describe, expect, it, vi } from "vitest";
import { createInstagramAdapter } from "../instagram-adapter";
import {
  expectNoNetworkCall,
  fakePublishFailure,
  fakePublishSuccess,
  installNoNetworkGuard,
  makeAuthoritativeInput,
  AUTHORITATIVE_TEXT,
} from "./test-utils";

const DESTINATION = {
  accessToken: "decrypted-page-token",
  instagramBusinessAccountId: "17843409009000001",
};

installNoNetworkGuard();

describe("Instagram adapter (governed platform adapter boundary)", () => {
  it("transports authoritative copy byte-for-byte as the container caption", () => {
    const adapter = createInstagramAdapter();
    const input = makeAuthoritativeInput("publication:instagram:7");

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content).toBe(input.content);
    expect(request.content.text).toBe(AUTHORITATIVE_TEXT);
    // media URLs are left for the existing transport layer to resolve —
    // the adapter performs no URL rewriting of its own.
    expect(request.content.mediaUrls).toEqual([
      "https://cdn.example.com/assets/spring-launch.png",
    ]);
  });

  it("cannot silently replace the CTA — the caption carries it exactly", () => {
    const adapter = createInstagramAdapter();
    const input = makeAuthoritativeInput("publication:instagram:7", {
      text: "Hook line\n\nCaption body.\n\nCTA::☎ CALL 555-0199 — say ZEBRA::",
    });

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content.text).toContain("CTA::☎ CALL 555-0199 — say ZEBRA::");
    expect(request.content.text).toBe(input.content.text);
  });

  it("builds the provider request deterministically", () => {
    const adapter = createInstagramAdapter();

    const first = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:instagram:7"),
      DESTINATION
    );
    const second = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:instagram:7"),
      { ...DESTINATION }
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("publishes through the existing two-step provider seam with token, account id, and verbatim payload", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishSuccess({ postId: "1799" }));
    const adapter = createInstagramAdapter({ publish });
    const input = makeAuthoritativeInput("publication:instagram:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "decrypted-page-token",
      "17843409009000001",
      input.content
    );
    expect(receipt).toMatchObject({
      platform: "instagram",
      operationId: "publication:instagram:7",
      status: "published",
      externalPostId: "1799",
    });
    expectNoNetworkCall();
  });

  it("preserves one operation identity across retries — no semantic regeneration", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce(fakePublishFailure("Rate limit exceeded"))
      .mockResolvedValueOnce(fakePublishSuccess());
    const adapter = createInstagramAdapter({ publish });
    const input = makeAuthoritativeInput("publication:instagram:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      operationId: "publication:instagram:7",
      category: "rate_limited",
      retryable: true,
    });

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(receipt.operationId).toBe("publication:instagram:7");
    expect(publish).toHaveBeenLastCalledWith(
      "decrypted-page-token",
      "17843409009000001",
      expect.objectContaining({ text: AUTHORITATIVE_TEXT })
    );
    expectNoNetworkCall();
  });

  it("normalizes provider failures, including the public-URL validation failure", async () => {
    const publish = vi
      .fn()
      .mockResolvedValue(
        fakePublishFailure("Instagram publishing requires a valid public image URL.")
      );
    const adapter = createInstagramAdapter({ publish });
    const input = makeAuthoritativeInput("publication:instagram:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      platform: "instagram",
      category: "validation",
      code: "provider_validation",
      retryable: false,
      operationId: "publication:instagram:7",
    });
    expectNoNetworkCall();
  });

  it("validates input and destination structurally", () => {
    const adapter = createInstagramAdapter();

    expect(adapter.validateInput(makeAuthoritativeInput()).ok).toBe(true);

    expect(adapter.validateDestination(DESTINATION).ok).toBe(true);
    expect(
      adapter.validateDestination({ accessToken: "t", instagramBusinessAccountId: "" }).issues[0]
        ?.code
    ).toBe("destination_account_empty");
  });
});
