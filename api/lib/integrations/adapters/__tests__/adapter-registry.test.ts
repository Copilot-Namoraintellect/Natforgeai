import { describe, expect, it } from "vitest";
import { createPlatformAdapterRegistry } from "../adapter-registry";
import { installNoNetworkGuard } from "./test-utils";

installNoNetworkGuard();

describe("platform adapter registry (single governed adapter boundary)", () => {
  it("resolves every supported platform to its governed adapter", () => {
    const registry = createPlatformAdapterRegistry();

    expect(registry.list()).toEqual(["facebook", "instagram", "linkedin", "twitter"]);
    expect(registry.resolve("facebook").platform).toBe("facebook");
    expect(registry.resolve("instagram").platform).toBe("instagram");
    expect(registry.resolve("linkedin").platform).toBe("linkedin");
    expect(registry.resolve("twitter").platform).toBe("twitter");
  });

  it("fails closed with a normalized, non-retryable error for unsupported platforms", () => {
    const registry = createPlatformAdapterRegistry();

    for (const platform of ["tiktok", "whatsapp", "email", "pinterest"]) {
      let caught: unknown;
      try {
        registry.resolve(platform);
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(
        expect.objectContaining({
          platform,
          category: "unsupported",
          code: "provider_unsupported",
          retryable: false,
          message: `Platform ${platform} not supported`,
        })
      );
    }
  });

  it("supports injecting test doubles per platform without touching others", () => {
    const publish = async (_request: any, _destination: any, operation: any) => ({
      platform: "facebook" as const,
      operationId: operation.operationId as string,
      status: "published" as const,
      externalPostId: "fake",
    });
    const registry = createPlatformAdapterRegistry({
      facebook: {
        platform: "facebook",
        validateInput: () => ({ ok: true, issues: [] }),
        validateDestination: () => ({ ok: true, issues: [] }),
        buildProviderRequest: (_input: any, destination: any) => ({
          pageId: destination.pageId,
          content: _input.content,
        }),
        publish,
        normalizeReceipt: (raw: any, operation: any) => ({
          platform: "facebook",
          operationId: operation.operationId,
          status: "published" as const,
          externalPostId: raw.postId,
        }),
        normalizeError: (error: any) => ({
          platform: "facebook",
          category: "provider" as const,
          code: "provider_error",
          message: String(error),
          retryable: true,
        }),
      },
    });

    expect(registry.resolve("facebook").platform).toBe("facebook");
    expect(registry.resolve("instagram").platform).toBe("instagram");
  });
});
