import { describe, it, expect } from "vitest";

import {
  buildPublishPackage,
  publishPackageToAdapterPayload,
  type PublishPackageBuildInput,
} from "./publish-package-builder";
import { publishPackageToAuthoritativeInput } from "./publish-package-adapter-input";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const GOVERNED_TEXT =
  "HOOK::seam marker::\n\n" +
  "CAPTION::semantic body must survive unchanged::\n\n" +
  "CTA::☎ CALL 555-0199 — say ZEBRA::";
const MEDIA_URL = "https://cdn.example.com/assets/seam.png";

function packageInput(overrides: Record<string, unknown> = {}): PublishPackageBuildInput {
  return {
    campaignId: 7,
    userId: 9,
    businessId: 4,
    destination: { platform: "instagram", integrationId: 7 },
    intent: { mode: "immediate" },
    selectedContent: { contentPostId: 125, artifactKind: "content_post" },
    payload: { text: GOVERNED_TEXT, mediaUrls: [MEDIA_URL], mediaType: "image" },
    ...overrides,
  } as PublishPackageBuildInput;
}

describe("publishPackageToAuthoritativeInput (WBS13 package → adapter seam)", () => {
  it("carries the frozen package payload verbatim — text, media URLs, media type", () => {
    const pkg = buildPublishPackage(packageInput());
    const input = publishPackageToAuthoritativeInput(pkg, 42);

    expect(input.content).toEqual(publishPackageToAdapterPayload(pkg));
    expect(input.content.text).toBe(GOVERNED_TEXT);
    expect(input.content.mediaUrls).toEqual([MEDIA_URL]);
    expect(input.content.mediaType).toBe("image");
  });

  it("derives the operation identity from the queue item via the accepted adapter utility", () => {
    const pkg = buildPublishPackage(packageInput());

    const input = publishPackageToAuthoritativeInput(pkg, 42);

    expect(input.operationId).toBe("publication:instagram:42");
  });

  it("keeps one stable operation identity across retries of the same queue item", () => {
    const pkg = buildPublishPackage(packageInput());

    const first = publishPackageToAuthoritativeInput(pkg, 42);
    const retry = publishPackageToAuthoritativeInput(pkg, 42);

    expect(retry.operationId).toBe(first.operationId);
  });

  it("scopes the operation identity to the package destination platform", () => {
    const pkg = buildPublishPackage(packageInput());

    const facebook = publishPackageToAuthoritativeInput(
      buildPublishPackage(packageInput({ destination: { platform: "facebook", integrationId: 7 } })),
      42
    );
    const instagram = publishPackageToAuthoritativeInput(pkg, 42);

    expect(facebook.operationId).toBe("publication:facebook:42");
    expect(instagram.operationId).toBe("publication:instagram:42");
  });

  it("returns a fresh mutable content copy and never mutates the frozen package", () => {
    const pkg = buildPublishPackage(packageInput());
    const fingerprintBefore = pkg.packageFingerprintSha256;

    const input = publishPackageToAuthoritativeInput(pkg, 42);
    input.content.mediaUrls?.push("https://cdn.example.com/transport-normalized.png");

    expect(pkg.payload.mediaUrls).toEqual([MEDIA_URL]);
    expect(pkg.packageFingerprintSha256).toBe(fingerprintBefore);
  });

  it("omits media fields when the package carries none", () => {
    const pkg = buildPublishPackage(
      packageInput({ payload: { text: GOVERNED_TEXT } })
    );

    const input = publishPackageToAuthoritativeInput(pkg, 42);

    expect(input.content.text).toBe(GOVERNED_TEXT);
    expect(input.content.mediaUrls).toBeUndefined();
    expect(input.content.mediaType).toBeUndefined();
  });
});
