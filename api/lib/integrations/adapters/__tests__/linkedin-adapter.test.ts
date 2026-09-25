import { describe, expect, it, vi } from "vitest";
import { createLinkedInAdapter } from "../linkedin-adapter";
import {
  expectNoNetworkCall,
  fakePublishFailure,
  fakePublishSuccess,
  installNoNetworkGuard,
  makeAuthoritativeInput,
  AUTHORITATIVE_TEXT,
} from "./test-utils";

const DESTINATION = { accessToken: "decrypted-user-token", organizationId: "urn-org-123" };

installNoNetworkGuard();

describe("LinkedIn adapter (governed platform adapter boundary)", () => {
  it("transports authoritative copy byte-for-byte into the share commentary", () => {
    const adapter = createLinkedInAdapter();
    const input = makeAuthoritativeInput("publication:linkedin:7");

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content).toBe(input.content);
    expect(request.content.text).toBe(AUTHORITATIVE_TEXT);
  });

  it("cannot silently replace the CTA — the commentary carries it exactly", () => {
    const adapter = createLinkedInAdapter();
    const input = makeAuthoritativeInput("publication:linkedin:7", {
      text: "Hook line\n\nCaption body.\n\nCTA::☎ CALL 555-0199 — say ZEBRA::",
    });

    const request = adapter.buildProviderRequest(input, DESTINATION);

    expect(request.content.text).toContain("CTA::☎ CALL 555-0199 — say ZEBRA::");
    expect(request.content.text).toBe(input.content.text);
  });

  it("builds the provider request deterministically", () => {
    const adapter = createLinkedInAdapter();

    const first = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:linkedin:7"),
      DESTINATION
    );
    const second = adapter.buildProviderRequest(
      makeAuthoritativeInput("publication:linkedin:7"),
      { ...DESTINATION }
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("publishes through the existing provider seam with token, organization id, and verbatim payload", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishSuccess({ postId: "urn:li:share:9" }));
    const adapter = createLinkedInAdapter({ publish });
    const input = makeAuthoritativeInput("publication:linkedin:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("decrypted-user-token", "urn-org-123", input.content);
    expect(receipt).toMatchObject({
      platform: "linkedin",
      operationId: "publication:linkedin:7",
      status: "published",
      externalPostId: "urn:li:share:9",
    });
    expectNoNetworkCall();
  });

  it("preserves one operation identity across retries — no semantic regeneration", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce(fakePublishFailure("fetch failed"))
      .mockResolvedValueOnce(fakePublishSuccess());
    const adapter = createLinkedInAdapter({ publish });
    const input = makeAuthoritativeInput("publication:linkedin:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      operationId: "publication:linkedin:7",
    });

    const receipt = await adapter.publish(request, DESTINATION, input);

    expect(receipt.operationId).toBe("publication:linkedin:7");
    expect(publish).toHaveBeenLastCalledWith(
      "decrypted-user-token",
      "urn-org-123",
      expect.objectContaining({ text: AUTHORITATIVE_TEXT })
    );
    expectNoNetworkCall();
  });

  it("normalizes provider failures into stable, categorized errors", async () => {
    const publish = vi.fn().mockResolvedValue(fakePublishFailure("401 Unauthorized"));
    const adapter = createLinkedInAdapter({ publish });
    const input = makeAuthoritativeInput("publication:linkedin:7");
    const request = adapter.buildProviderRequest(input, DESTINATION);

    await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
      platform: "linkedin",
      category: "auth",
      retryable: false,
      operationId: "publication:linkedin:7",
    });
    expectNoNetworkCall();
  });

  it("validates input and destination structurally", () => {
    const adapter = createLinkedInAdapter();

    expect(adapter.validateInput(makeAuthoritativeInput()).ok).toBe(true);

    expect(adapter.validateDestination(DESTINATION).ok).toBe(true);
    expect(
      adapter.validateDestination({ accessToken: "t", organizationId: "" }).issues[0]?.code
    ).toBe("destination_org_empty");
  });
});
