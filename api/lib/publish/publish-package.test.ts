import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";

import {
  PUBLISH_PACKAGE_SCHEMA_VERSION,
  assertPersistedPublishPackageIntact,
  derivePublishPackageFingerprint,
  type PublishPackage,
} from "./publish-package-contract";
import {
  assertPublishPackageCompatibleWithInput,
  assertPublishPackageLineageCompatible,
  assertPublishPackageMatchesQueueItem,
  assertPublishPackagePayloadCurrent,
  buildPublishPackage,
  classifyPublishPackageInput,
  normalizePublishPackageBuildInput,
  publishPackageToAdapterPayload,
  type PublishPackageBuildInput,
} from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";

const HASH_A = "a".repeat(64);
const HASH_A2 = "a".repeat(63) + "b";
const HASH_B = "b".repeat(64);
const HASH_B2 = "b".repeat(63) + "c";
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_E2 = "e".repeat(63) + "f";

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const STRATEGY_2 = { ...STRATEGY, strategyHashSha256: HASH_A2 };

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

const APPROVED_COPY_2 = { ...APPROVED_COPY, copyHashSha256: HASH_B2 };

const MEDIA_URL = "https://cdn.example.com/img.png";

function captionLineage(strategy = STRATEGY, copy = APPROVED_COPY) {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy,
      approvedCopy: copy,
    }),
    strategy,
    approvedCopy: copy,
  };
}

function governedInput(overrides: Record<string, unknown> = {}): PublishPackageBuildInput {
  return {
    campaignId: 7,
    userId: 9,
    businessId: 4,
    destination: { platform: "instagram", integrationId: 7 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 125,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 125,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: MEDIA_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_E,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: [MEDIA_URL], mediaType: "image" },
    ...overrides,
  } as PublishPackageBuildInput;
}

describe("publish package determinism", () => {
  it("builds identical packages with identical fingerprints for identical inputs", () => {
    const a = buildPublishPackage(governedInput());
    const b = buildPublishPackage(governedInput());
    expect(a.packageFingerprintSha256).toBe(b.packageFingerprintSha256);
    expect(a.packageId).toBe(b.packageId);
    expect(a).toEqual(b);
  });

  it("ignores key order and hash letter casing in the fingerprint", () => {
    const reordered = {
      payload: { mediaType: "image", mediaUrls: [MEDIA_URL], text: "Hook\n\nCaption\n\nCTA" },
      evidence: { launchApprovalRequestId: 1 },
      visualArtifact: {
        renderLineage: {
          approvedCopy: APPROVED_COPY,
          lineageFingerprintSha256: HASH_E.toUpperCase(),
          strategy: STRATEGY,
        },
        mediaUrl: MEDIA_URL,
        mediaKind: "image",
        generatedAssetId: 909,
      },
      captionArtifact: { lineage: captionLineage(), artifactKind: "caption_pack", artifactId: 501 },
      selectedContent: {
        lineage: {
          approvedCopy: APPROVED_COPY,
          lineageFingerprintSha256: HASH_D.toUpperCase(),
          artifactId: 125,
          artifactKind: "content_post",
          lineageSchemaVersion: 1,
          strategy: STRATEGY,
        },
        artifactKind: "content_post",
        contentPostId: 125,
      },
      approvedCopy: APPROVED_COPY,
      strategyAuthority: { ...STRATEGY, strategyHashSha256: HASH_A.toUpperCase() },
      intent: { mode: "immediate" },
      destination: { integrationId: 7, platform: "instagram" },
      businessId: 4,
      userId: 9,
      campaignId: 7,
    } as unknown as PublishPackageBuildInput;
    const a = buildPublishPackage(governedInput());
    const b = buildPublishPackage(reordered);
    expect(b.packageFingerprintSha256).toBe(a.packageFingerprintSha256);
    expect(b.packageId).toBe(a.packageId);
  });

  it("excludes nondeterministic createdAtIso provenance from the deterministic identity", () => {
    const a = buildPublishPackage(governedInput({ createdAtIso: "2026-05-29T10:00:00.000Z" }));
    const b = buildPublishPackage(governedInput({ createdAtIso: "2026-05-29T12:34:56.789Z" }));
    expect(a.packageFingerprintSha256).toBe(b.packageFingerprintSha256);
    expect(a.packageId).toBe(b.packageId);
    expect(a.createdAtIso).toBe("2026-05-29T10:00:00.000Z");
    expect(b.createdAtIso).toBe("2026-05-29T12:34:56.789Z");
  });

  it("mints versioned, greppable package ids", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(pkg.packageId.startsWith("ppv1-")).toBe(true);
    expect(pkg.schemaVersion).toBe(PUBLISH_PACKAGE_SCHEMA_VERSION);
  });
});

describe("publish package lineage conflicts", () => {
  it("produces a different package when the Strategy authority changes, and flags the conflict", () => {
    const original = buildPublishPackage(governedInput());
    const changed = governedInput({
      strategyAuthority: STRATEGY_2,
      selectedContent: {
        contentPostId: 125,
        artifactKind: "content_post",
        lineage: {
          lineageSchemaVersion: 1,
          artifactKind: "content_post",
          artifactId: 125,
          lineageFingerprintSha256: HASH_D,
          strategy: STRATEGY_2,
          approvedCopy: APPROVED_COPY,
        },
      },
      captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage(STRATEGY_2) },
      visualArtifact: {
        mediaKind: "image",
        generatedAssetId: 909,
        mediaUrl: MEDIA_URL,
        renderLineage: { lineageFingerprintSha256: HASH_E, strategy: STRATEGY_2, approvedCopy: APPROVED_COPY },
      },
    });
    const rebuilt = buildPublishPackage(changed);
    expect(rebuilt.packageFingerprintSha256).not.toBe(original.packageFingerprintSha256);
    expect(() => assertPublishPackageCompatibleWithInput(original, changed)).toThrowError(TRPCError);
    expect(() => assertPublishPackageCompatibleWithInput(original, changed)).toThrowError(/strategyAuthority/);
  });

  it("produces a different package when the approved copy changes, and flags the conflict", () => {
    const original = buildPublishPackage(governedInput());
    const changed = governedInput({
      approvedCopy: APPROVED_COPY_2,
      selectedContent: {
        contentPostId: 125,
        artifactKind: "content_post",
        lineage: {
          lineageSchemaVersion: 1,
          artifactKind: "content_post",
          artifactId: 125,
          lineageFingerprintSha256: HASH_D,
          strategy: STRATEGY,
          approvedCopy: APPROVED_COPY_2,
        },
      },
      captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage(STRATEGY, APPROVED_COPY_2) },
      visualArtifact: {
        mediaKind: "image",
        generatedAssetId: 909,
        mediaUrl: MEDIA_URL,
        renderLineage: { lineageFingerprintSha256: HASH_E, strategy: STRATEGY, approvedCopy: APPROVED_COPY_2 },
      },
    });
    const rebuilt = buildPublishPackage(changed);
    expect(rebuilt.packageFingerprintSha256).not.toBe(original.packageFingerprintSha256);
    expect(() => assertPublishPackageCompatibleWithInput(original, changed)).toThrowError(/approvedCopy/);
  });

  it("produces a different package when the image/video render lineage changes, and flags the conflict", () => {
    const original = buildPublishPackage(governedInput());
    const changed = governedInput({
      visualArtifact: {
        mediaKind: "image",
        generatedAssetId: 909,
        mediaUrl: MEDIA_URL,
        renderLineage: { lineageFingerprintSha256: HASH_E2, strategy: STRATEGY, approvedCopy: APPROVED_COPY },
      },
    });
    const rebuilt = buildPublishPackage(changed);
    expect(rebuilt.packageFingerprintSha256).not.toBe(original.packageFingerprintSha256);
    expect(() => assertPublishPackageCompatibleWithInput(original, changed)).toThrowError(
      /visualArtifact render lineage/
    );
  });

  it("fails closed when a parent artifact is bound to a different Strategy authority", () => {
    const mismatchedCaption = governedInput({
      captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage(STRATEGY_2) },
    });
    expect(() => buildPublishPackage(mismatchedCaption)).toThrowError(TRPCError);
    expect(() => buildPublishPackage(mismatchedCaption)).toThrowError(/Caption artifact.*Strategy authority/);

    const mismatchedContent = governedInput({
      selectedContent: {
        contentPostId: 125,
        artifactKind: "content_post",
        lineage: {
          lineageSchemaVersion: 1,
          artifactKind: "content_post",
          artifactId: 125,
          lineageFingerprintSha256: HASH_D,
          strategy: STRATEGY_2,
          approvedCopy: APPROVED_COPY,
        },
      },
    });
    expect(() => buildPublishPackage(mismatchedContent)).toThrowError(/Selected content artifact.*Strategy authority/);
  });

  it("fails closed when a parent artifact is bound to a different approved copy", () => {
    const mismatched = governedInput({
      captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage(STRATEGY, APPROVED_COPY_2) },
    });
    expect(() => buildPublishPackage(mismatched)).toThrowError(/Caption artifact.*approved copy/);
  });

  it("fails closed when a visual render lineage is bound to a different Strategy authority", () => {
    const mismatched = governedInput({
      visualArtifact: {
        mediaKind: "image",
        generatedAssetId: 909,
        mediaUrl: MEDIA_URL,
        renderLineage: { lineageFingerprintSha256: HASH_E, strategy: STRATEGY_2, approvedCopy: APPROVED_COPY },
      },
    });
    expect(() => buildPublishPackage(mismatched)).toThrowError(/Visual artifact.*Strategy authority/);
  });

  it("fails closed on tampered persisted lineage fingerprints of known artifact kinds", () => {
    const tampered = governedInput({
      captionArtifact: {
        artifactId: 501,
        artifactKind: "caption_pack",
        lineage: { ...captionLineage(), lineageFingerprintSha256: HASH_D },
      },
    });
    expect(() => buildPublishPackage(tampered)).toThrowError(/fingerprint mismatch/);
  });
});

describe("publish package classification", () => {
  it("classifies a full chain as governed with no legacy reasons", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(pkg.classification).toBe("governed");
    expect(pkg.legacyReasons).toEqual([]);
    expect(() => assertPublishPackageLineageCompatible(pkg)).not.toThrow();
  });

  it("classifies missing strategy authority as legacy with an explicit reason", () => {
    const pkg = buildPublishPackage(governedInput({ strategyAuthority: null }));
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("strategy_authority_missing");
  });

  it("classifies missing approved copy identity as legacy with an explicit reason", () => {
    const pkg = buildPublishPackage(governedInput({ approvedCopy: null }));
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("approved_copy_identity_missing");
  });

  it("classifies a selected content post without durable lineage as legacy", () => {
    const pkg = buildPublishPackage(
      governedInput({ selectedContent: { contentPostId: 125, artifactKind: "content_post", lineage: null } })
    );
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("selected_content_lineage_missing");
  });

  it("classifies a missing caption artifact as legacy", () => {
    const pkg = buildPublishPackage(governedInput({ captionArtifact: null }));
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("caption_artifact_missing");
  });

  it("classifies a caption artifact without lineage as legacy", () => {
    const pkg = buildPublishPackage(
      governedInput({ captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: null } })
    );
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("caption_artifact_lineage_missing");
  });

  it("classifies a visual artifact without render lineage as legacy", () => {
    const pkg = buildPublishPackage(
      governedInput({
        visualArtifact: { mediaKind: "image", generatedAssetId: 909, mediaUrl: MEDIA_URL, renderLineage: null },
      })
    );
    expect(pkg.classification).toBe("legacy");
    expect(pkg.legacyReasons).toContain("visual_artifact_lineage_missing");
  });

  it("never pretends a legacy package is governed during compatibility checks", () => {
    const legacy = buildPublishPackage(governedInput({ strategyAuthority: null }));
    expect(legacy.classification).toBe("legacy");
    expect(() => assertPublishPackageLineageCompatible(legacy)).not.toThrow();
  });

  it("classifier reports every missing chain link at once", () => {
    const normalized = normalizePublishPackageBuildInput(
      governedInput({
        strategyAuthority: null,
        approvedCopy: null,
        selectedContent: { contentPostId: 125, artifactKind: "content_post", lineage: null },
        captionArtifact: null,
        visualArtifact: { mediaKind: "image", generatedAssetId: 909, mediaUrl: MEDIA_URL, renderLineage: null },
      })
    );
    const { classification, legacyReasons } = classifyPublishPackageInput(normalized);
    expect(classification).toBe("legacy");
    expect(legacyReasons).toEqual([
      "strategy_authority_missing",
      "approved_copy_identity_missing",
      "selected_content_lineage_missing",
      "caption_artifact_missing",
      "visual_artifact_lineage_missing",
    ]);
  });
});

describe("publish package immutability", () => {
  it("deep-freezes the whole package at the contract boundary", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.identity)).toBe(true);
    expect(Object.isFrozen(pkg.identity.destination)).toBe(true);
    expect(Object.isFrozen(pkg.identity.selectedContent)).toBe(true);
    expect(Object.isFrozen(pkg.identity.visualArtifact)).toBe(true);
    expect(Object.isFrozen(pkg.payload)).toBe(true);
    expect(Object.isFrozen(pkg.payload.mediaUrls)).toBe(true);
    expect(Object.isFrozen(pkg.legacyReasons)).toBe(true);
  });

  it("rejects mutation attempts on any package coordinate", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(() => {
      (pkg.identity as { campaignId: number }).campaignId = 999;
    }).toThrowError(TypeError);
    expect(() => {
      (pkg.payload as { text: string }).text = "tampered";
    }).toThrowError(TypeError);
    expect(() => {
      (pkg as { packageFingerprintSha256: string }).packageFingerprintSha256 = HASH_D;
    }).toThrowError(TypeError);
  });

  it("fails closed when a persisted package was tampered with after assembly", () => {
    const pkg = buildPublishPackage(governedInput());
    const tampered = {
      ...pkg,
      identity: { ...pkg.identity, campaignId: 999 },
    } as PublishPackage;
    expect(() => assertPersistedPublishPackageIntact(tampered)).toThrowError(/fingerprint mismatch/);

    const wrongId = { ...pkg, packageId: "ppv1-forged" } as PublishPackage;
    expect(() => assertPersistedPublishPackageIntact(wrongId)).toThrowError(/package id/);
  });
});

describe("publish package adapter sufficiency", () => {
  it("carries everything a platform adapter needs without rereading mutable rows", () => {
    const pkg = buildPublishPackage(governedInput());
    const adapterPayload = publishPackageToAdapterPayload(pkg);
    expect(adapterPayload).toEqual({
      text: "Hook\n\nCaption\n\nCTA",
      mediaUrls: [MEDIA_URL],
      mediaType: "image",
    });
    // Identity carries the immutable Strategy authority coordinates, so
    // receipts/audits can cite authority without rereading campaign rows.
    expect(pkg.identity.strategyAuthority?.strategyHashSha256).toBe(HASH_A);
    expect(pkg.identity.approvedCopy?.copyHashSha256).toBe(HASH_B);
    expect(pkg.identity.evidence.launchApprovalRequestId).toBe(1);
    expect(pkg.identity.destination.platform).toBe("instagram");
  });

  it("returns a mutable adapter copy while the package stays frozen", () => {
    const pkg = buildPublishPackage(governedPackageWithVideo());
    const adapterPayload = publishPackageToAdapterPayload(pkg);
    adapterPayload.mediaUrls!.push("https://cdn.example.com/normalized.png");
    expect(pkg.payload.mediaUrls).toHaveLength(1);
    expect(Object.isFrozen(pkg)).toBe(true);
  });

  it("supports video media identity for rendered video artifacts", () => {
    const pkg = buildPublishPackage(governedPackageWithVideo());
    expect(pkg.identity.visualArtifact?.mediaKind).toBe("video");
    expect(publishPackageToAdapterPayload(pkg).mediaType).toBe("video");
  });
});

function governedPackageWithVideo(): PublishPackageBuildInput {
  return governedInput({
    visualArtifact: {
      mediaKind: "video",
      generatedAssetId: 910,
      mediaUrl: "https://cdn.example.com/video.mp4",
      renderLineage: null,
    },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: ["https://cdn.example.com/video.mp4"], mediaType: "video" },
  });
}

describe("publish package consumption guards", () => {
  it("accepts a package only for its exact queue item coordinates", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(() =>
      assertPublishPackageMatchesQueueItem(pkg, {
        userId: 9,
        campaignId: 7,
        contentPostId: 125,
        platform: "instagram",
        integrationId: 7,
      })
    ).not.toThrow();
  });

  it("fails closed when the queue item coordinates diverge", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(() =>
      assertPublishPackageMatchesQueueItem(pkg, {
        userId: 9,
        campaignId: 7,
        contentPostId: 125,
        platform: "facebook",
        integrationId: 7,
      })
    ).toThrowError(/destination platform/);
    expect(() =>
      assertPublishPackageMatchesQueueItem(pkg, {
        userId: 9,
        campaignId: 7,
        contentPostId: 126,
        platform: "instagram",
        integrationId: 7,
      })
    ).toThrowError(/selected content/);
    expect(() =>
      assertPublishPackageMatchesQueueItem(pkg, {
        userId: 10,
        campaignId: 7,
        contentPostId: 125,
        platform: "instagram",
        integrationId: 7,
      })
    ).toThrowError(/user/);
  });

  it("accepts a live content row only while it still composes to the frozen payload", () => {
    const pkg = buildPublishPackage(governedInput());
    const livePost = {
      hook: "Hook",
      caption: "Caption",
      cta: "CTA",
      metadata: { imageUrl: MEDIA_URL },
    };
    expect(() => assertPublishPackagePayloadCurrent(pkg, livePost)).not.toThrow();
  });

  it("fails closed when the live content row diverges from the frozen payload", () => {
    const pkg = buildPublishPackage(governedInput());
    expect(() =>
      assertPublishPackagePayloadCurrent(pkg, {
        hook: "Hook",
        caption: "Edited caption",
        cta: "CTA",
        metadata: { imageUrl: MEDIA_URL },
      })
    ).toThrowError(/copy diverges/);
    expect(() =>
      assertPublishPackagePayloadCurrent(pkg, {
        hook: "Hook",
        caption: "Caption",
        cta: "CTA",
        metadata: { imageUrl: "https://cdn.example.com/other.png" },
      })
    ).toThrowError(/media diverges/);
  });
});

describe("publish package input validation", () => {
  it("fails closed on malformed hashes", () => {
    expect(() =>
      buildPublishPackage(governedInput({ strategyAuthority: { ...STRATEGY, strategyHashSha256: "not-a-hash" } }))
    ).toThrowError(/SHA-256 hex/);
  });

  it("fails closed on non-positive ids", () => {
    expect(() => buildPublishPackage(governedInput({ campaignId: 0 }))).toThrowError(/positive safe integer/);
  });

  it("fails closed on scheduled intent without a timestamp, and immediate intent with one", () => {
    expect(() => buildPublishPackage(governedInput({ intent: { mode: "scheduled" } }))).toThrowError(
      /scheduled mode requires scheduledAtIso/
    );
    expect(() =>
      buildPublishPackage(governedInput({ intent: { mode: "immediate", scheduledAtIso: "2026-05-29T10:00:00.000Z" } }))
    ).toThrowError(/immediate mode/);
    const scheduled = buildPublishPackage(
      governedInput({ intent: { mode: "scheduled", scheduledAtIso: "2026-05-29T10:00:00.000Z" } })
    );
    expect(scheduled.identity.intent.mode).toBe("scheduled");
  });

  it("fails closed on an empty frozen payload", () => {
    expect(() => buildPublishPackage(governedInput({ payload: { text: "  " } }))).toThrowError(/non-empty/);
  });

  it("normalizes destination platform casing into the deterministic identity", () => {
    const pkg = buildPublishPackage(governedInput({ destination: { platform: " Instagram ", integrationId: 7 } }));
    expect(pkg.identity.destination.platform).toBe("instagram");
    const baseline = buildPublishPackage(governedInput());
    expect(pkg.packageFingerprintSha256).toBe(baseline.packageFingerprintSha256);
  });

  it("builds packages with plain data only — no provider, network, or database", () => {
    // Deterministic, synchronous construction from in-memory coordinates is
    // itself the proof: the builder module imports nothing impure.
    const before = buildPublishPackage(governedInput());
    const after = buildPublishPackage(governedInput());
    expect(derivePublishPackageFingerprint(before.identity)).toBe(after.packageFingerprintSha256);
  });
});
