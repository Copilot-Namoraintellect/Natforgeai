import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";

import {
  buildPublishPackage,
  type PublishPackage,
  type PublishPackageBuildInput,
} from "./publish-package-builder";
import {
  assertPrePublishReady,
  validatePrePublishReadiness,
  PRE_PUBLISH_DOMAIN_ORDER,
  type PrePublishIntegrationProjection,
  type PrePublishValidationInput,
} from "./pre-publish-validation";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import { buildGroundedCreativeBrief } from "../creative/brief-grounding";

// ─── Distinctive governed copy ───

const HOOK = "HOOK::pre-publish authority::";
const CAPTION = "CAPTION::semantic body::";
const CTA = "CTA::CALL 555-0199 — say ZEBRA::";
const TEXT = `${HOOK}\n\n${CAPTION}\n\n${CTA}`;
const RELATIVE_IMAGE_URL = "/generated/images/27/authority.png";
const PUBLIC_APP_URL = "https://natforgeai.com";

// ─── Publication-authority fixtures ───

const campaign = {
  id: 27,
  userId: 14,
  businessId: 24,
  status: "active",
  productOrService: "Payout platform",
  targetBuyer: "Restaurants and delivery platforms",
  mainPainPoint: "manual payout reconciliation",
  primaryOutcome: "awareness",
  coreMessage: "Faster payouts for frontline teams",
};

const business = { id: 24, userId: 14, name: "Zuto Hub", industry: "fintech payouts" };

const launchApproval = {
  id: 7,
  userId: 14,
  campaignId: 27,
  approvalType: "campaign_launch",
  status: "approved",
};

function currentFingerprint() {
  return buildGroundedCreativeBrief({ campaign, business }).fingerprint;
}

const approvedCampaign = {
  ...campaign,
  workflowContext: {
    launchApprovalLineage: {
      creativeBriefFingerprint: currentFingerprint(),
      approvalRequestId: launchApproval.id,
      status: "approved" as const,
    },
  },
};

function contentPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 117,
    campaignId: 27,
    hook: HOOK,
    caption: CAPTION,
    cta: CTA,
    metadata: {
      imageUrl: RELATIVE_IMAGE_URL,
      creativeBriefFingerprint: currentFingerprint(),
    },
    ...overrides,
  };
}

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 14,
    campaignId: 27,
    contentPostId: 117,
    platform: "facebook",
    integrationId: 9,
    status: "approved",
    safetyStatus: "low",
    ...overrides,
  };
}

function facebookIntegration(overrides: Record<string, unknown> = {}): PrePublishIntegrationProjection {
  return {
    id: 9,
    userId: 14,
    businessId: 24,
    platform: "facebook",
    status: "connected",
    accountName: "Test Page",
    accessTokenEncrypted: "user-token-encrypted",
    pageAccessTokenEncrypted: "page-token-encrypted",
    ...overrides,
  };
}

function instagramIntegration(overrides: Record<string, unknown> = {}): PrePublishIntegrationProjection {
  return {
    id: 9,
    userId: 14,
    businessId: 24,
    platform: "instagram",
    status: "connected",
    accountName: "IG Account",
    accessTokenEncrypted: "user-token-encrypted",
    pageAccessTokenEncrypted: "page-token-encrypted",
    instagramBusinessAccountId: "ig_biz_123",
    ...overrides,
  };
}

// ─── Governed package fixture ───

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

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

function governedPackageInput(platform: string, integrationId: number | null = 9) {
  return {
    campaignId: 27,
    userId: 14,
    businessId: 24,
    destination: { platform, integrationId },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 117,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 117,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: RELATIVE_IMAGE_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_E,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: 7 },
    payload: { text: TEXT, mediaUrls: [RELATIVE_IMAGE_URL], mediaType: "image" },
  } as PublishPackageBuildInput;
}

function buildGovernedPackage(platform: string, integrationId: number | null = 9): PublishPackage {
  return buildPublishPackage(governedPackageInput(platform, integrationId));
}

function buildLegacyPackage(): PublishPackage {
  return buildPublishPackage({
    ...governedPackageInput("facebook"),
    strategyAuthority: null,
  } as PublishPackageBuildInput);
}

// ─── Valid input baseline (governed facebook) ───

function validInput(overrides: Partial<PrePublishValidationInput> = {}): PrePublishValidationInput {
  return {
    queueItem: queueItem(),
    contentPost: contentPost(),
    publishPackage: buildGovernedPackage("facebook"),
    integration: facebookIntegration(),
    campaign: approvedCampaign,
    business,
    approvals: [launchApproval],
    publicAppUrl: PUBLIC_APP_URL,
    ...overrides,
  };
}

function firstCode(input: PrePublishValidationInput) {
  return validatePrePublishReadiness(input).firstFailure?.code;
}

interface PrePublishFailureExpectation {
  domain: string;
  code: string;
}

describe("pre-publish validation — valid governed case", () => {
  it("passes a fully ready governed package across every domain", () => {
    const result = validatePrePublishReadiness(validInput());
    expect(result.path).toBe("governed");
    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.firstFailure).toBeNull();
  });

  it("approves each adapter-supported platform when everything is ready", () => {
    for (const platform of ["facebook", "instagram", "linkedin", "twitter"] as const) {
      const integration =
        platform === "instagram" ? instagramIntegration() : { ...facebookIntegration(), platform };
      const result = validatePrePublishReadiness(
        validInput({
          queueItem: queueItem({ platform }),
          publishPackage: buildGovernedPackage(platform),
          integration,
        })
      );
      expect(result.ready).toBe(true);
    }
  });

  it("resolves a relative media URL against the public app base as transport-ready", () => {
    const result = validatePrePublishReadiness(validInput());
    expect(result.ready).toBe(true);
  });
});

describe("pre-publish validation — package integrity", () => {
  it("fails closed on a tampered package before any later domain runs", () => {
    const base = buildGovernedPackage("facebook");
    // Flip one fingerprint character with every identity coordinate intact, so
    // the queue binding still agrees and the intactness failure is isolated.
    const flipped = base.packageFingerprintSha256.endsWith("a") ? "b" : "a";
    const tampered = {
      ...base,
      packageFingerprintSha256: base.packageFingerprintSha256.slice(0, 63) + flipped,
    } as PublishPackage;

    const result = validatePrePublishReadiness(
      validInput({
        publishPackage: tampered,
        integration: facebookIntegration({ status: "disconnected" }),
      })
    );

    expect(result.ready).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.firstFailure?.domain).toBe("package");
    expect(result.firstFailure?.code).toBe("package_not_intact");
    expect(result.firstFailure?.message).toMatch(/fingerprint mismatch/);
  });

  it("fails closed when the tampered classification is not understood", () => {
    const pkg = buildGovernedPackage("facebook");
    const weird = { ...pkg, classification: "unknown" } as unknown as PublishPackage;
    const result = validatePrePublishReadiness(validInput({ publishPackage: weird }));
    expect(result.firstFailure?.code).toBe("package_classification_unrecognized");
  });

  it("never executes a legacy-classified package on the governed path", () => {
    const result = validatePrePublishReadiness(validInput({ publishPackage: buildLegacyPackage() }));
    expect(result.ready).toBe(false);
    expect(result.firstFailure?.code).toBe("package_not_governed");
    expect(result.firstFailure?.message).toMatch(/strategy_authority_missing/);
    expect(result.path).toBe("governed");
  });

  it("fails closed when the frozen payload is no longer current against the live row", () => {
    const result = validatePrePublishReadiness(
      validInput({ contentPost: contentPost({ caption: "Edited caption" }) })
    );
    expect(result.firstFailure?.domain).toBe("package");
    expect(result.firstFailure?.code).toBe("package_payload_not_current");
    expect(result.firstFailure?.message).toMatch(/copy diverges/);
  });
});

describe("pre-publish validation — queue binding", () => {
  it("fails closed when the queue platform diverges from the package destination", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ platform: "instagram" }) })
    );
    expect(result.firstFailure?.domain).toBe("queue");
    expect(result.firstFailure?.code).toBe("queue_package_mismatch");
    expect(result.firstFailure?.message).toMatch(/destination platform/);
  });

  it("fails closed when the queue content post diverges from the package selection", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ contentPostId: 999 }) })
    );
    expect(result.firstFailure?.code).toBe("queue_package_mismatch");
    expect(result.firstFailure?.message).toMatch(/selected content/);
  });

  it("fails closed when the queue user diverges from the package owner", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ userId: 99 }) })
    );
    expect(result.firstFailure?.code).toBe("queue_package_mismatch");
    expect(result.firstFailure?.message).toMatch(/user/);
  });

  it("fails closed when the queue campaign diverges from the package", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ campaignId: 28 }) })
    );
    expect(result.firstFailure?.code).toBe("queue_package_mismatch");
    expect(result.firstFailure?.message).toMatch(/campaign/);
  });

  it("fails closed when the queue item is already terminal or not actionable", () => {
    for (const status of ["published", "failed", "safety_blocked", "draft", "pending_approval"]) {
      const result = validatePrePublishReadiness(
        validInput({
          queueItem: queueItem({ status }),
          integration: facebookIntegration({ status: "disconnected" }),
        })
      );
      expect(result.firstFailure?.domain).toBe("queue");
      expect(result.firstFailure?.code).toBe("queue_not_actionable");
      expect(result.issues).toHaveLength(1);
    }
  });

  it("fails closed when the queue item is missing entirely", () => {
    const result = validatePrePublishReadiness(validInput({ queueItem: null }));
    expect(result.firstFailure?.code).toBe("queue_item_missing");
  });
});

describe("pre-publish validation — approval / artifact authority", () => {
  it("fails closed when no usable launch approval exists", () => {
    const result = validatePrePublishReadiness(validInput({ approvals: [] }));
    expect(result.firstFailure?.domain).toBe("approval");
    expect(result.firstFailure?.code).toBe("launch_approval_missing");
    expect(result.firstFailure?.message).toMatch(/launch approval is pending/i);
  });

  it("fails closed when the durable launch lineage no longer matches the current brief", () => {
    const staleLineageCampaign = {
      ...campaign,
      workflowContext: {
        launchApprovalLineage: {
          creativeBriefFingerprint: "old-brief-fingerprint",
          approvalRequestId: launchApproval.id,
          status: "approved" as const,
        },
      },
    };
    const result = validatePrePublishReadiness(validInput({ campaign: staleLineageCampaign }));
    expect(result.firstFailure?.code).toBe("launch_approval_missing");
  });

  it("fails closed when the selected artifact is stale relative to the current brief", () => {
    const result = validatePrePublishReadiness(
      validInput({
        contentPost: contentPost({ metadata: { imageUrl: RELATIVE_IMAGE_URL, creativeBriefFingerprint: "stale-fp" } }),
      })
    );
    expect(result.firstFailure?.code).toBe("selected_artifact_stale");
  });

  it("fails closed when the selected artifact row is missing", () => {
    const result = validatePrePublishReadiness(validInput({ contentPost: null }));
    expect(result.firstFailure?.code).toBe("selected_artifact_missing");
  });

  it("fails closed on standalone content with no publication authority model", () => {
    const result = validatePrePublishReadiness(
      validInput({
        queueItem: queueItem({ contentPostId: 117 }),
        contentPost: contentPost({ campaignId: null }),
      })
    );
    expect(result.firstFailure?.code).toBe("publication_authority_missing");
  });
});

describe("pre-publish validation — integration", () => {
  it("fails closed when no integration could be resolved", () => {
    const result = validatePrePublishReadiness(validInput({ integration: null }));
    expect(result.firstFailure?.domain).toBe("integration");
    expect(result.firstFailure?.code).toBe("integration_missing");
  });

  it("fails closed when the resolved integration belongs to another user", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ userId: 99 }) })
    );
    expect(result.firstFailure?.code).toBe("integration_wrong_user");
  });

  it("fails closed when the resolved integration belongs to another business than the package", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ businessId: 25 }) })
    );
    expect(result.firstFailure?.code).toBe("integration_wrong_business");
  });

  it("fails closed when the resolved integration platform diverges from the queue platform", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ platform: "twitter" }) })
    );
    expect(result.firstFailure?.code).toBe("integration_platform_mismatch");
  });

  it("fails closed when the resolved integration diverges from the package destination pin", () => {
    const result = validatePrePublishReadiness(
      validInput({
        queueItem: queueItem({ integrationId: null }),
        integration: facebookIntegration({ id: 99 }),
      })
    );
    expect(result.firstFailure?.code).toBe("integration_destination_pin_mismatch");
    expect(result.firstFailure?.message).toMatch(/bound to integration 9/);
  });

  it("fails closed when the integration is not connected", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ status: "expired" }) })
    );
    expect(result.firstFailure?.code).toBe("integration_not_connected");
  });

  it("fails closed for platforms with no governed adapter", () => {
    const result = validatePrePublishReadiness(
      validInput({
        queueItem: queueItem({ platform: "whatsapp" }),
        publishPackage: buildGovernedPackage("whatsapp"),
        integration: facebookIntegration({ platform: "whatsapp" }),
      })
    );
    expect(result.firstFailure?.code).toBe("integration_platform_unsupported");
  });

  it("collects every independent integration defect in deterministic step order", () => {
    const result = validatePrePublishReadiness(
      validInput({
        integration: facebookIntegration({ userId: 99, status: "disconnected" }),
      })
    );
    expect(result.issues.map((i) => i.code)).toEqual([
      "integration_wrong_user",
      "integration_not_connected",
    ]);
  });
});

describe("pre-publish validation — credential readiness", () => {
  it("fails closed when the account access token material is absent", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ accessTokenEncrypted: null }) })
    );
    expect(result.firstFailure?.domain).toBe("credential");
    expect(result.firstFailure?.code).toBe("credential_access_token_missing");
  });

  it("fails closed when the instagram page token is absent", () => {
    const result = validatePrePublishReadiness(
      validInput({
        queueItem: queueItem({ platform: "instagram" }),
        publishPackage: buildGovernedPackage("instagram"),
        integration: instagramIntegration({ pageAccessTokenEncrypted: null }),
      })
    );
    expect(result.firstFailure?.code).toBe("credential_page_token_missing");
  });

  it("fails closed when the instagram business account id is absent", () => {
    const result = validatePrePublishReadiness(
      validInput({
        queueItem: queueItem({ platform: "instagram" }),
        publishPackage: buildGovernedPackage("instagram"),
        integration: instagramIntegration({ instagramBusinessAccountId: null }),
      })
    );
    expect(result.firstFailure?.code).toBe("credential_business_account_missing");
  });

  it("treats whitespace-only encrypted material as absent without decrypting anything", () => {
    const result = validatePrePublishReadiness(
      validInput({ integration: facebookIntegration({ accessTokenEncrypted: "   " }) })
    );
    expect(result.firstFailure?.code).toBe("credential_access_token_missing");
  });
});

describe("pre-publish validation — media transport readiness", () => {
  it("fails closed on a non-public media URL before any provider call", () => {
    const blobPkg = buildGovernedPackage("facebook");
    // Keep the frozen payload and the live row consistent (both carry the
    // blob URL) so the media domain — not package currentness — owns the
    // transport failure.
    const withBlobMedia = {
      ...blobPkg,
      payload: { ...blobPkg.payload, mediaUrls: ["blob:https://app.example/abc"] },
    } as PublishPackage;
    const result = validatePrePublishReadiness(
      validInput({
        publishPackage: withBlobMedia,
        contentPost: contentPost({
          metadata: { imageUrl: "blob:https://app.example/abc", creativeBriefFingerprint: currentFingerprint() },
        }),
      })
    );
    expect(result.firstFailure?.domain).toBe("media");
    expect(result.firstFailure?.code).toBe("media_url_invalid");
  });

  it("fails closed on a local file path as media", () => {
    const pkg = buildGovernedPackage("facebook");
    const withLocalMedia = {
      ...pkg,
      payload: { ...pkg.payload, mediaUrls: ["C:\\temp\\img.png"] },
    } as PublishPackage;
    const result = validatePrePublishReadiness(
      validInput({
        publishPackage: withLocalMedia,
        contentPost: contentPost({
          metadata: { imageUrl: "C:\\temp\\img.png", creativeBriefFingerprint: currentFingerprint() },
        }),
      })
    );
    expect(result.firstFailure?.code).toBe("media_url_invalid");
  });

  it("fails closed when the payload declares media but carries no URL", () => {
    const pkg = buildGovernedPackage("facebook");
    // The payload is excluded from the deterministic identity fingerprint, so
    // this projection still passes intactness — the media domain owns it.
    const declaresButEmpty = {
      ...pkg,
      payload: { ...pkg.payload, mediaUrls: [], mediaType: "image" as const },
    } as PublishPackage;
    const result = validatePrePublishReadiness(
      validInput({
        publishPackage: declaresButEmpty,
        contentPost: contentPost({ metadata: { imageUrl: null, creativeBriefFingerprint: currentFingerprint() } }),
      })
    );
    expect(result.firstFailure?.code).toBe("media_url_missing");
  });

  it("fails closed when there is no text to publish", () => {
    const result = validatePrePublishReadiness(
      validInput({
        publishPackage: null,
        contentPost: contentPost({
          hook: "",
          caption: "",
          cta: "",
          metadata: { imageUrl: null, creativeBriefFingerprint: currentFingerprint() },
        }),
      })
    );
    expect(result.firstFailure?.code).toBe("payload_text_missing");
  });
});

describe("pre-publish validation — safety governance", () => {
  it("blocks high-risk content permanently", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ safetyStatus: "high" }) })
    );
    expect(result.firstFailure?.domain).toBe("safety");
    expect(result.firstFailure?.code).toBe("safety_high_blocked");
  });

  it("requires an explicit approval decision for medium-risk content on a retrying row", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ safetyStatus: "medium", status: "retrying" }) })
    );
    expect(result.firstFailure?.code).toBe("safety_medium_requires_approval");
  });

  it("honours the explicit approval decision for medium-risk content", () => {
    const result = validatePrePublishReadiness(
      validInput({ queueItem: queueItem({ safetyStatus: "medium", status: "approved" }) })
    );
    expect(result.ready).toBe(true);
  });
});

describe("pre-publish validation — deterministic fail-closed order", () => {
  it("always reports the earliest failing domain as the first failure", () => {
    const base = buildGovernedPackage("facebook");
    // Flip one fingerprint character with identity coordinates intact so the
    // failure is owned by the package domain, not the queue binding.
    const flipped = base.packageFingerprintSha256.endsWith("a") ? "b" : "a";
    const tampered = {
      ...base,
      packageFingerprintSha256: base.packageFingerprintSha256.slice(0, 63) + flipped,
    } as PublishPackage;
    // Blob media stays consistent between the frozen payload and the live row
    // so the failure is owned by the media domain, not package currentness.
    const BLOB_URL = "blob:https://app.example/abc";
    const brokenMedia = {
      ...base,
      payload: { ...base.payload, mediaUrls: [BLOB_URL] },
    } as PublishPackage;
    const blobContentPost = contentPost({
      metadata: { imageUrl: BLOB_URL, creativeBriefFingerprint: currentFingerprint() },
    });

    // Each step fixes every earlier domain and breaks the next one, so the
    // reported first failure must walk the canonical order exactly.
    const ladder: Array<[Partial<PrePublishValidationInput>, PrePublishFailureExpectation]> = [
      [
        {
          queueItem: queueItem({ status: "published" }),
          approvals: [],
          publishPackage: tampered,
          integration: null,
        },
        { domain: "queue", code: "queue_not_actionable" },
      ],
      [
        { approvals: [], publishPackage: tampered, integration: null },
        { domain: "approval", code: "launch_approval_missing" },
      ],
      [
        { publishPackage: tampered, integration: null },
        { domain: "package", code: "package_not_intact" },
      ],
      [
        { queueItem: queueItem({ safetyStatus: "high" }), integration: null },
        { domain: "safety", code: "safety_high_blocked" },
      ],
      [{ integration: null }, { domain: "integration", code: "integration_missing" }],
      [
        { integration: facebookIntegration({ accessTokenEncrypted: null }) },
        { domain: "credential", code: "credential_access_token_missing" },
      ],
      [
        { publishPackage: brokenMedia, contentPost: blobContentPost },
        { domain: "media", code: "media_url_invalid" },
      ],
    ];

    for (const [override, expected] of ladder) {
      const result = validatePrePublishReadiness(validInput(override));
      expect(result.ready).toBe(false);
      expect(result.firstFailure?.domain).toBe(expected.domain);
      expect(result.firstFailure?.code).toBe(expected.code);
      // Fail-closed: later domains are never evaluated once one fails.
      for (const found of result.issues) {
        expect(found.domain).toBe(expected.domain);
      }
    }
  });

  // Fix each domain in canonical order; the next broken domain must surface.
  it("surfaces domains in PRE_PUBLISH_DOMAIN_ORDER regardless of defect count", () => {
    const brokenMedia = {
      ...buildGovernedPackage("facebook"),
      payload: {
        ...buildGovernedPackage("facebook").payload,
        mediaUrls: ["blob:https://app.example/abc"],
      },
    } as PublishPackage;

    const allBroken = validInput({
      queueItem: queueItem({ status: "published" }),
      approvals: [],
      publishPackage: brokenMedia,
      integration: null,
    });
    expect(validatePrePublishReadiness(allBroken).firstFailure?.domain).toBe("queue");

    const queueFixed = validInput({
      approvals: [],
      publishPackage: brokenMedia,
      integration: null,
    });
    expect(validatePrePublishReadiness(queueFixed).firstFailure?.domain).toBe("approval");

    const approvalFixed = validInput({ publishPackage: brokenMedia, integration: null });
    expect(validatePrePublishReadiness(approvalFixed).firstFailure?.domain).toBe("package");

    const packageFixed = validInput({ integration: null });
    expect(validatePrePublishReadiness(packageFixed).firstFailure?.domain).toBe("integration");

    const integrationFixed = validInput({
      integration: facebookIntegration({ accessTokenEncrypted: null }),
    });
    expect(validatePrePublishReadiness(integrationFixed).firstFailure?.domain).toBe("credential");

    const credentialFixed = validInput();
    expect(validatePrePublishReadiness(credentialFixed).ready).toBe(true);
  });

  it("declares the canonical domain order for convergence callers", () => {
    expect(PRE_PUBLISH_DOMAIN_ORDER).toEqual([
      "queue",
      "approval",
      "package",
      "safety",
      "integration",
      "credential",
      "media",
    ]);
  });
});

describe("pre-publish validation — governed vs legacy classification", () => {
  it("runs the legacy path without a package and skips the package domain", () => {
    const result = validatePrePublishReadiness(
      validInput({ publishPackage: null })
    );
    expect(result.path).toBe("legacy");
    expect(result.ready).toBe(true);
  });

  it("validates integration, credentials, approval and media on the legacy path too", () => {
    expect(firstCode(validInput({ publishPackage: null, integration: null }))).toBe(
      "integration_missing"
    );
    expect(
      firstCode(
        validInput({ publishPackage: null, integration: facebookIntegration({ status: "disconnected" }) })
      )
    ).toBe("integration_not_connected");
  });

  it("selects the governed path whenever a package is supplied", () => {
    const result = validatePrePublishReadiness(validInput());
    expect(result.path).toBe("governed");
  });
});

describe("pre-publish validation — purity and no side effects", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
    return value;
  }

  it("produces identical results for identical frozen inputs and never mutates them", () => {
    const input = deepFreeze(validInput()) as PrePublishValidationInput;
    const first = validatePrePublishReadiness(input);
    const second = validatePrePublishReadiness(input);

    expect(first.ready).toBe(true);
    expect(second).toEqual(first);
    // Governed package stays fingerprint-identical after validation: nothing
    // was decrypted, rewritten, or re-derived into it.
    expect(JSON.stringify(input.publishPackage)).toBe(
      JSON.stringify(buildGovernedPackage("facebook"))
    );
  });

  it("runs synchronously with no injected seams — no provider, network, or database", () => {
    const input = validInput();
    const result = validatePrePublishReadiness(input);
    // Synchronous completion is itself the proof of zero async side effects.
    expect(result.ready).toBe(true);
  });
});

describe("pre-publish validation — assertPrePublishReady guard", () => {
  it("throws a TRPCError PRECONDITION_FAILED carrying the stable taxonomy", () => {
    const result = validatePrePublishReadiness(validInput({ approvals: [] }));
    try {
      assertPrePublishReady(result);
      expect.unreachable("assertPrePublishReady should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      const trpcErr = err as TRPCError;
      expect(trpcErr.code).toBe("PRECONDITION_FAILED");
      expect(trpcErr.message).toMatch(/launch approval is pending/i);
      const cause = trpcErr.cause as unknown as Record<string, unknown>;
      expect(cause.code).toBe("launch_approval_missing");
      expect(cause.domain).toBe("approval");
      expect(cause.failureStage).toBe("precondition");
      expect(cause.path).toBe("governed");
    }
  });

  it("passes silently when the result is ready", () => {
    expect(() => assertPrePublishReady(validatePrePublishReadiness(validInput()))).not.toThrow();
  });
});
