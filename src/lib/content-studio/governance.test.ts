import { describe, it, expect } from "vitest";
import {
  buildCreativeGovernanceView,
  formatGovernanceParent,
  CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY,
} from "./governance";

const COPY_HASH = "a".repeat(64);
const LINEAGE_FINGERPRINT = "b".repeat(64);
const STRATEGY_HASH = "c".repeat(64);

function governedLineage(overrides: Record<string, unknown> = {}) {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    platform: null,
    parent: { artifactKind: "message_pack", artifactId: null },
    lineageFingerprintSha256: LINEAGE_FINGERPRINT,
    strategy: {
      strategySnapshotId: "snap-1",
      strategyVersion: 3,
      businessDnaSnapshotId: "dna-1",
      strategyHashSha256: STRATEGY_HASH,
      strategyRunId: 9,
      approvalRequestId: 4,
      creativeBriefFingerprint: "fp-1",
    },
    approvedCopy: {
      copyHashSha256: COPY_HASH,
      copySchemaVersion: "copy-schema-1",
      approvedRevisionId: "rev-42",
      assessmentHashSha256: COPY_HASH,
      contextLockId: "lock-1",
    },
    ...overrides,
  };
}

describe("buildCreativeGovernanceView", () => {
  it("maps a governed caption pack to an approved, parent-bound view without exposing hashes", () => {
    const view = buildCreativeGovernanceView({
      id: 7,
      assetType: "caption_pack",
      metadata: {
        assetType: "caption_pack",
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: governedLineage(),
      },
    });

    expect(view.governed).toBe(true);
    expect(view.artifactKind).toBe("caption_pack");
    expect(view.approvalState).toBe("approved");
    expect(view.boundToApprovedCopy).toBe(true);
    expect(view.parent).toEqual({ artifactKind: "message_pack", artifactId: null });
    expect(view.approvedRevisionId).toBe("rev-42");
    expect(view.strategySnapshotId).toBe("snap-1");
    expect(view.renderParentContentPostId).toBeNull();

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(COPY_HASH);
    expect(serialized).not.toContain(LINEAGE_FINGERPRINT);
    expect(serialized).not.toContain(STRATEGY_HASH);
  });

  it("keeps the platform-variant parent relationship for platform captions", () => {
    const view = buildCreativeGovernanceView({
      assetType: "caption_adaptation",
      metadata: {
        platform: "instagram",
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: governedLineage({
          artifactKind: "platform_caption",
          platform: "instagram",
          parent: { artifactKind: "message_pack", artifactId: 55 },
        }),
      },
    });

    expect(view.governed).toBe(true);
    expect(view.artifactKind).toBe("platform_caption");
    expect(view.platform).toBe("instagram");
    expect(view.parent).toEqual({ artifactKind: "message_pack", artifactId: 55 });
    expect(view.approvalState).toBe("approved");
  });

  it("maps a legacy asset without lineage to a usable legacy view", () => {
    const view = buildCreativeGovernanceView({
      id: 8,
      assetType: "caption_pack",
      metadata: { assetType: "caption_pack", generatedAt: "2026-01-01T00:00:00.000Z" },
    });

    expect(view.governed).toBe(false);
    expect(view.approvalState).toBe("legacy");
    expect(view.parent).toBeNull();
    expect(view.boundToApprovedCopy).toBe(false);
    expect(view.approvedRevisionId).toBeNull();
    expect(view.artifactKind).toBe("caption_pack");
  });

  it("reads approval state from a message pack V2 approval envelope", () => {
    const view = buildCreativeGovernanceView({
      assetType: "message_pack",
      metadata: {
        assetType: "message_pack",
        v2ApprovalEnvelope: {
          decision: "approved",
          approvedAtIso: "2026-05-29T12:00:00.000Z",
          approvedRevisionId: "rev-7",
          campaignStrategySnapshotId: "snap-1",
        },
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: governedLineage({
          artifactKind: "message_pack",
          parent: null,
        }),
      },
    });

    expect(view.governed).toBe(true);
    expect(view.approvalState).toBe("approved");
    expect(view.approvedAtIso).toBe("2026-05-29T12:00:00.000Z");
    expect(view.approvedRevisionId).toBe("rev-7");
    expect(view.strategySnapshotId).toBe("snap-1");
    expect(view.parent).toBeNull();
  });

  it("reports superseded state with precedence over approved", () => {
    const view = buildCreativeGovernanceView({
      assetType: "message_pack",
      metadata: {
        supersededBy: 12,
        v2ApprovalEnvelope: { decision: "approved", approvedAtIso: "2026-05-01T00:00:00.000Z" },
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: governedLineage({
          artifactKind: "message_pack",
          parent: null,
        }),
      },
    });

    expect(view.governed).toBe(true);
    expect(view.approvalState).toBe("superseded");
  });

  it("reports invalidated state from the invalidation markers", () => {
    const view = buildCreativeGovernanceView({
      assetType: "message_pack",
      metadata: {
        invalidatedAt: "2026-05-28T00:00:00.000Z",
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: governedLineage({
          artifactKind: "message_pack",
          parent: null,
        }),
      },
    });

    expect(view.approvalState).toBe("invalidated");
  });

  it("maps a governed rendered image to its parent content post", () => {
    const view = buildCreativeGovernanceView({
      id: 60,
      metadata: {
        assetType: "leaflet",
        renderLineage: {
          lineageSchemaVersion: 1,
          contentPostId: 42,
          lineageFingerprintSha256: LINEAGE_FINGERPRINT,
          strategy: { strategySnapshotId: "snap-2" },
          approvedCopy: { approvedRevisionId: "rev-3" },
        },
      },
    });

    expect(view.governed).toBe(true);
    expect(view.artifactKind).toBe("rendered_image");
    expect(view.renderParentContentPostId).toBe(42);
    expect(view.parent).toEqual({ artifactKind: "content_post", artifactId: 42 });
    expect(view.approvalState).toBe("approved");
    expect(view.approvedRevisionId).toBe("rev-3");
    expect(view.strategySnapshotId).toBe("snap-2");
  });

  it("reports a governed render without approved-copy coordinates as pending", () => {
    const view = buildCreativeGovernanceView({
      metadata: {
        renderLineage: {
          lineageSchemaVersion: 1,
          contentPostId: 42,
          lineageFingerprintSha256: LINEAGE_FINGERPRINT,
          strategy: { strategySnapshotId: "snap-2" },
          approvedCopy: null,
        },
      },
    });

    expect(view.governed).toBe(true);
    expect(view.approvalState).toBe("pending");
    expect(view.boundToApprovedCopy).toBe(false);
  });

  it("surfaces the reapproval-required state after a semantic edit voids approval", () => {
    const view = buildCreativeGovernanceView({
      id: 300,
      metadata: {
        approved: false,
        approvedAt: "2026-05-20T10:00:00.000Z",
        approvalVoidedAt: "2026-05-30T10:00:00.000Z",
        approvalVoidedReason: "semantic_copy_edit_requires_reapproval",
      },
    });

    expect(view.governed).toBe(false);
    expect(view.approvalState).toBe("reapproval_required");
    expect(view.approvedAtIso).toBe("2026-05-20T10:00:00.000Z");
  });

  it("maps a legacy approved content post without requiring governance metadata", () => {
    const view = buildCreativeGovernanceView({
      id: 301,
      metadata: {
        approved: true,
        approvedAt: "2026-05-20T10:00:00.000Z",
        generationRunId: "run-9",
      },
    });

    expect(view.governed).toBe(false);
    expect(view.approvalState).toBe("legacy_approved");
    expect(view.approvedAtIso).toBe("2026-05-20T10:00:00.000Z");
  });

  it("finds the envelope nested inside an approved message pack (leaflet details shape)", () => {
    const view = buildCreativeGovernanceView({
      metadata: {
        imageUrl: "https://cdn.example.com/leaflet.png",
        approvedMessagePack: {
          headline: "Big sale",
          v2ApprovalEnvelope: {
            decision: "approved",
            approvedAtIso: "2026-05-29T08:00:00.000Z",
            approvedRevisionId: "rev-11",
            campaignStrategySnapshotId: "snap-4",
          },
        },
      },
    });

    expect(view.governed).toBe(true);
    expect(view.approvalState).toBe("approved");
    expect(view.approvedRevisionId).toBe("rev-11");
    expect(view.strategySnapshotId).toBe("snap-4");
  });

  it("degrades malformed lineage metadata to a legacy view instead of throwing", () => {
    const view = buildCreativeGovernanceView({
      assetType: "caption_pack",
      metadata: {
        [CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]: "not-an-object",
      },
    });

    expect(view.governed).toBe(false);
    expect(view.approvalState).toBe("legacy");
  });

  it("treats a missing record as legacy", () => {
    expect(buildCreativeGovernanceView(null).approvalState).toBe("legacy");
    expect(buildCreativeGovernanceView(undefined).governed).toBe(false);
  });
});

describe("formatGovernanceParent", () => {
  it("formats the parent artifact kind with and without an id", () => {
    expect(formatGovernanceParent({ artifactKind: "message_pack", artifactId: 55 })).toBe(
      "message pack #55"
    );
    expect(formatGovernanceParent({ artifactKind: "content_post", artifactId: null })).toBe(
      "content post"
    );
    expect(formatGovernanceParent(null)).toBeNull();
  });
});
