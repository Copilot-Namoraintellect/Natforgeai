import { afterEach, beforeEach, expect, vi } from "vitest";
import type { PublishPayload, PublishResult } from "../../platforms";
import type { AuthoritativePublicationInput } from "../platform-adapter";

/**
 * Adapter unit tests must never perform a live provider call. Installing
 * this guard makes any accidental network reach (e.g. forgetting to inject
 * a test double and falling through to the real provider function) fail the
 * test loudly instead of hitting the provider.
 */
export function installNoNetworkGuard() {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error(
          "No live provider calls: adapter unit tests must use injected test doubles."
        );
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

export function expectNoNetworkCall() {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
}

/**
 * Authoritative copy with distinctive markers so tests can prove every byte
 * (hook, caption, and CTA) survives transport unchanged.
 */
export const AUTHORITATIVE_TEXT =
  "HOOK::Launch day is here::\n\n" +
  "CAPTION::We are live with the spring campaign.::\n\n" +
  "CTA::Book your demo at https://booking.example/only-here::";

export function makeAuthoritativeContent(
  overrides: Partial<PublishPayload> = {}
): PublishPayload {
  return {
    text: AUTHORITATIVE_TEXT,
    mediaUrls: ["https://cdn.example.com/assets/spring-launch.png"],
    mediaType: "image",
    ...overrides,
  };
}

export function makeAuthoritativeInput(
  operationId = "publication:facebook:7",
  overrides: Partial<PublishPayload> = {}
): AuthoritativePublicationInput {
  return {
    operationId,
    content: makeAuthoritativeContent(overrides),
  };
}

export function fakePublishSuccess(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    success: true,
    postId: "ext_post_123",
    url: "https://provider.example/p/ext_post_123",
    ...overrides,
  };
}

export function fakePublishFailure(error: string): PublishResult {
  return { success: false, error };
}
