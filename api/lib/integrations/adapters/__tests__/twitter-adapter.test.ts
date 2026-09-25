import { describe, expect, it, vi } from "vitest";
import { createTwitterAdapter } from "../twitter-adapter";
import {
  expectNoNetworkCall,
  fakePublishFailure,
  fakePublishSuccess,
  installNoNetworkGuard,
  makeAuthoritativeInput,
  AUTHORITATIVE_TEXT,
} from "./test-utils";

const DESTINATION = { accessToken: "decrypted-user-token" };

installNoNetworkGuard();

describe("X/Twitter adapter (governed platform adapter boundary)", () => {
  it("transports authoritative copy byte-for-byte into the tweet body", () => {
    const adapter = createTwitterAdapter();
    const input = makeAuthoritativeInput("publication:twitter:7");

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content).toBe(input.content);
    expect(request.content.text).toBe(AUTHORITATIVE_TEXT);
  });

  it("cannot silently replace the CTA — the tweet carries it exactly", () => {
    const adapter = createTwitterAdapter();
    const input = makeAuthoritativeInput("publication:twitter:7", {
      text: "Hook line\n\nCaption body.\n\nCTA::☎ CALL 555-0199 — say ZEBRA::",
    });

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content.text).toContain("CTA::☎ CALL 555-0199 — say ZEBRA::");
    expect(request.content.text).toBe(input.content.text);
  });

  it("builds the provider request deterministically", () => {
    const adapter = createTwitterAdapter();

    const first = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:twitter:7"),
      DESTINATION
    );
    const second = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:twitter:7"),
      { ...DESTINATION }
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("publishes through the existing provider seam with token and verbatim payload", async () => {
    const publish = vi
      .fn()
      .mockResolvedValue(fakePublishSuccess({ postId: "171717", url: "https://twitter.com/i/web/status/171717" }));
    const adapter = createTwitterAdapter({ publish });
    const input = makeAuthoritativeInput("publication:twitter:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("decrypted-user-token", input.content);
    expect(receipt).toMatchObject({
      platform: "twitter",
      operationId: "publication:twitter:7",
      status: "published",
      externalPostId: "171717",
      externalUrl: "https://twitter.com/i/web/status/171717",
    });
    expectNoNetworkCall();
  });

  it("preserves one operation identity across retries — no semantic regeneration", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce(fakePublishFailure("connect ETIMEDOUT"))
      .mockResolvedValueOnce(fakePublishSuccess());
    const adapter = createTwitterAdapter({ publish });
    const input = makeAuthoritativeInput("publication:twitter:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      operationId: "publication:twitter:7",
      category: "network",
      retryable: true,
    });

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(receipt.operationId).toBe("publication:twitter:7");
    expect(publish).toHaveBeenLastCalledWith(
      "decrypted-user-token",
      expect.objectContaining({ text: AUTHORITATIVE_TEXT })
    );
    expectNoNetworkCall();
  });

  it("normalizes provider failures into stable, categorized errors", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishFailure("Too Many Requests"));
    const adapter = createTwitterAdapter({ publish });
    const input = makeAuthoritativeInput("publication:twitter:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      platform: "twitter",
      category: "rate_limited",
      retryable: true,
      operationId: "publication:twitter:7",
    });
    expectNoNetworkCall();
  });

  it("validates input and destination structurally", () => {
    const adapter = createTwitterAdapter();

    expect(adapter.validateInput(makeAuthoritativeInput()).ok).toBe(true);

    expect(adapter.validateDestination(DESTINATION).ok).toBe(true);
    expect(adapter.validateDestination({ accessToken: "" }).issues[0]?.code).toBe(
      "destination_token_empty"
    );
  });
});
