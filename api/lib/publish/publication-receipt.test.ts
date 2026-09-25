import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";

import { derivePublicationOperationId } from "../integrations/adapters/platform-adapter";
import {
  buildPublishPackage,
  type PublishPackage,
  type PublishPackageBuildInput,
} from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import {
  PUBLICATION_RECEIPT_METADATA_KEY,
  PUBLICATION_RECEIPT_SCHEMA_VERSION,
  buildLegacyReceiptFromQueueSuccess,
  buildPublicationReceipt,
  extractPublicationReceiptFromMetadata,
  normalizePublicationReceipt,
  publicationReceiptToMetadata,
} from "./publication-receipt";

const HASH_A = "a".repeat(64);
const HASH_A2 = "a".repeat(63) + "b";
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

const MEDIA_URL = "https://cdn.example.com/img.png";
const PUBLISHED_AT = "2026-07-01T12:00:00.000Z";

function captionLineage() {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: STRATEGY,
      approvedCopy: APPROVED_COPY,
    }),
    strategy: STRATEGY,
    approvedCopy: APPROVED_COPY,
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
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: [MEDIA_URL], mediaType: "image" },
    ...overrides,
  } as PublishPackageBuildInput;
}

function buildGovernedPackage(): PublishPackage {
  return buildPublishPackage(governedInput());
}

function normalizedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    operationId: derivePublicationOperationId({ platform: "instagram", queueItemId: 42 }),
    platform: "instagram",
    status: "published" as const,
    externalPostId: "179424343423232",
    externalUrl: "https://www.instagram.com/p/ABC123/",
    ...overrides,
  };
}

describe("buildPublicationReceipt", () => {
  it("builds a governed receipt that records every authority coordinate", () => {
    const pkg = buildGovernedPackage();
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
      publishPackage: pkg,
    });

    expect(receipt.schemaVersion).toBe(PUBLICATION_RECEIPT_SCHEMA_VERSION);
    expect(receipt.operationId).toBe("publication:instagram:42");
    expect(receipt.queueItemId).toBe(42);
    expect(receipt.platform).toBe("instagram");
    expect(receipt.status).toBe("published");
    expect(receipt.externalPostId).toBe("179424343423232");
    expect(receipt.externalUrl).toBe("https://www.instagram.com/p/ABC123/");
    expect(receipt.publishedAtIso).toBe(PUBLISHED_AT);
    expect(receipt.classification).toBe("governed");
    expect(receipt.publishPackageId).toBe(pkg.packageId);
    expect(receipt.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("correlates the governed package id and fingerprint exactly", () => {
    const pkg = buildGovernedPackage();
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
      publishPackage: pkg,
    });
    expect(receipt.publishPackageId).toBe(pkg.packageId);
    expect(receipt.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    // A second package with divergent identity must not alias the receipt.
    const divergent = buildPublishPackage(
      governedInput({ destination: { platform: "instagram", integrationId: 8 } })
    );
    expect(receipt.publishPackageId).not.toBe(divergent.packageId);
  });

  it("normalizes an uppercase platform into the operation identity", () => {
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt({
        operationId: derivePublicationOperationId({ platform: "instagram", queueItemId: 42 }),
        platform: "Instagram",
      }),
      queueItemId: 42,
      platform: "Instagram",
      publishedAtIso: PUBLISHED_AT,
    });
    expect(receipt.platform).toBe("instagram");
    expect(receipt.operationId).toBe("publication:instagram:42");
  });

  it("accepts a legacy receipt without fabricating package correlation", () => {
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
    });
    expect(receipt.classification).toBe("legacy");
    expect(receipt.publishPackageId).toBeNull();
    expect(receipt.packageFingerprintSha256).toBeNull();
  });

  it("records package correlation honestly for a legacy-classified package", () => {
    const legacyPkg = buildPublishPackage(
      governedInput({ strategyAuthority: null, captionArtifact: null })
    );
    expect(legacyPkg.classification).toBe("legacy");
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
      publishPackage: legacyPkg,
    });
    expect(receipt.classification).toBe("legacy");
    expect(receipt.publishPackageId).toBe(legacyPkg.packageId);
    expect(receipt.packageFingerprintSha256).toBe(legacyPkg.packageFingerprintSha256);
  });

  it("rejects a normalized receipt whose operationId does not match the queue identity", () => {
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt({
          operationId: "publication:instagram:99",
        }),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: PUBLISHED_AT,
      })
    ).toThrow(TRPCError);
  });

  it("rejects a normalized receipt that is not a success", () => {
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt({ status: "failed" as never }),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: PUBLISHED_AT,
      })
    ).toThrow(TRPCError);
  });

  it("rejects a tampered publish package instead of recording its identity", () => {
    const pkg = buildGovernedPackage();
    const tampered = { ...pkg, packageFingerprintSha256: HASH_A2 };
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt(),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: PUBLISHED_AT,
        publishPackage: tampered as PublishPackage,
      })
    ).toThrow(TRPCError);
  });

  it("rejects a package whose destination platform diverges from the operation", () => {
    const pkg = buildPublishPackage(governedInput({ destination: { platform: "facebook", integrationId: 7 } }));
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt(),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: PUBLISHED_AT,
        publishPackage: pkg,
      })
    ).toThrow(TRPCError);
  });

  it("rejects secrets in the provider external URL", () => {
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt({
          operationId: derivePublicationOperationId({ platform: "facebook", queueItemId: 42 }),
          platform: "facebook",
          externalUrl: "https://graph.facebook.com/v19/me?access_token=EAAGsecret",
        }),
        queueItemId: 42,
        platform: "facebook",
        publishedAtIso: PUBLISHED_AT,
      })
    ).toThrow(/sensitive material/);
  });

  it("rejects secrets in the provider external post id", () => {
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt({
          externalPostId: "post_123_session_cookie_abc",
        }),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: PUBLISHED_AT,
      })
    ).toThrow(/sensitive material/);
  });

  it("rejects an unparseable publication timestamp", () => {
    expect(() =>
      buildPublicationReceipt({
        normalized: normalizedReceipt(),
        queueItemId: 42,
        platform: "instagram",
        publishedAtIso: "not-a-timestamp",
      })
    ).toThrow(TRPCError);
  });
});

describe("receipt metadata round-trip", () => {
  it("preserves external post id, status, and package correlation through audit metadata", () => {
    const pkg = buildGovernedPackage();
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
      publishPackage: pkg,
    });
    const metadata = publicationReceiptToMetadata(receipt);
    expect(metadata).toHaveProperty(PUBLICATION_RECEIPT_METADATA_KEY);
    const restored = extractPublicationReceiptFromMetadata(metadata);
    expect(restored).toEqual(receipt);
    expect(restored?.externalPostId).toBe("179424343423232");
    expect(restored?.status).toBe("published");
    expect(restored?.publishPackageId).toBe(pkg.packageId);
  });

  it("round-trips a legacy receipt without fabricated package fields", () => {
    const receipt = buildPublicationReceipt({
      normalized: normalizedReceipt(),
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
    });
    const restored = extractPublicationReceiptFromMetadata(
      publicationReceiptToMetadata(receipt)
    );
    expect(restored).toEqual(receipt);
    expect(restored?.publishPackageId).toBeNull();
    expect(restored?.packageFingerprintSha256).toBeNull();
  });

  it("returns null when metadata carries no canonical receipt", () => {
    expect(extractPublicationReceiptFromMetadata(null)).toBeNull();
    expect(extractPublicationReceiptFromMetadata({})).toBeNull();
    expect(extractPublicationReceiptFromMetadata({ externalPostIdPresent: true })).toBeNull();
  });

  it("throws on a present-but-malformed receipt in stored metadata", () => {
    expect(() =>
      extractPublicationReceiptFromMetadata({
        [PUBLICATION_RECEIPT_METADATA_KEY]: { operationId: "tampered" },
      })
    ).toThrow(TRPCError);
  });
});

describe("normalizePublicationReceipt", () => {
  const validLegacy = {
    schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    operationId: "publication:instagram:42",
    queueItemId: 42,
    platform: "instagram",
    status: "published",
    externalPostId: "179424343423232",
    externalUrl: "https://www.instagram.com/p/ABC123/",
    publishedAtIso: PUBLISHED_AT,
    classification: "legacy",
    publishPackageId: null,
    packageFingerprintSha256: null,
    receivedAtIso: null,
  };

  it("accepts the exact canonical shape", () => {
    expect(normalizePublicationReceipt(validLegacy)).toEqual(validLegacy);
  });

  it("rejects an unsupported schema version", () => {
    expect(() => normalizePublicationReceipt({ ...validLegacy, schemaVersion: 2 })).toThrow(
      TRPCError
    );
  });

  it("rejects a non-success status", () => {
    expect(() =>
      normalizePublicationReceipt({ ...validLegacy, status: "retrying" as never })
    ).toThrow(TRPCError);
  });

  it("rejects an operationId inconsistent with queue item and platform", () => {
    expect(() =>
      normalizePublicationReceipt({ ...validLegacy, operationId: "publication:instagram:43" })
    ).toThrow(TRPCError);
  });

  it("rejects governed receipts missing package correlation", () => {
    expect(() =>
      normalizePublicationReceipt({
        ...validLegacy,
        classification: "governed" as const,
      })
    ).toThrow(TRPCError);
  });

  it("accepts legacy receipts that record real legacy-classified package correlation", () => {
    // Fabrication is a build-path property (no package ⇒ null fields, always);
    // normalization only validates shape, so real legacy-package correlation
    // round-trips like any other receipt.
    expect(
      normalizePublicationReceipt({
        ...validLegacy,
        publishPackageId: "ppv1-abc",
        packageFingerprintSha256: HASH_D,
      })
    ).toMatchObject({
      classification: "legacy",
      publishPackageId: "ppv1-abc",
      packageFingerprintSha256: HASH_D,
    });
  });

  it("rejects a non-hex package fingerprint", () => {
    expect(() =>
      normalizePublicationReceipt({
        ...validLegacy,
        classification: "governed" as const,
        publishPackageId: "ppv1-abc",
        packageFingerprintSha256: "not-hex",
      })
    ).toThrow(TRPCError);
  });
});

describe("buildLegacyReceiptFromQueueSuccess", () => {
  it("hydrates an honest legacy receipt from a durable published row", () => {
    const receipt = buildLegacyReceiptFromQueueSuccess({
      queueItemId: 42,
      platform: "instagram",
      status: "published",
      externalPostId: "179424343423232",
      publishedAt: new Date(PUBLISHED_AT),
    });
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("published");
    expect(receipt?.externalPostId).toBe("179424343423232");
    expect(receipt?.externalUrl).toBeNull();
    expect(receipt?.classification).toBe("legacy");
    expect(receipt?.publishPackageId).toBeNull();
    expect(receipt?.packageFingerprintSha256).toBeNull();
    expect(receipt?.publishedAtIso).toBe(PUBLISHED_AT);
  });

  it("accepts ISO string timestamps from raw row projections", () => {
    const receipt = buildLegacyReceiptFromQueueSuccess({
      queueItemId: 42,
      platform: "instagram",
      status: "published",
      externalPostId: null,
      publishedAt: PUBLISHED_AT,
    });
    expect(receipt?.publishedAtIso).toBe(PUBLISHED_AT);
  });

  it("returns null unless the row is durably published", () => {
    expect(
      buildLegacyReceiptFromQueueSuccess({
        queueItemId: 42,
        platform: "instagram",
        status: "retrying",
        externalPostId: "179424343423232",
        publishedAt: new Date(PUBLISHED_AT),
      })
    ).toBeNull();
    expect(
      buildLegacyReceiptFromQueueSuccess({
        queueItemId: 42,
        platform: "instagram",
        status: "published",
        externalPostId: "179424343423232",
        publishedAt: null,
      })
    ).toBeNull();
  });
});
