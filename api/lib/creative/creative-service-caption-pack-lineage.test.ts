import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({
    primary: "#000000",
    secondary: "#ffffff",
    accent: "#ff0000",
    source: "mock",
  })),
  safeText: vi.fn((value: unknown) => (value == null ? "" : String(value).trim())),
}));

vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>(
    "./campaign-message-architect"
  );
  return {
    ...actual,
    loadApprovedMessagePack: vi.fn(),
  };
});

import { getDb } from "../../queries/connection";
import { generateText } from "ai";
import { generateCaptionPack } from "./service";
import { loadApprovedMessagePack, specificityScore } from "./campaign-message-architect";
import type { CampaignMessagePack } from "./campaign-message-architect";
import { computeCreativeBriefFingerprint } from "./brief-grounding";
import { createMessagePackCandidate } from "./message-approval/candidate";
import { evaluateMessageCandidate } from "./message-approval/evaluator";
import { createApprovedMessagePack } from "./message-approval/approve";
import { adaptApprovedToCampaignMessagePack } from "./message-approval/compatibility-adapter";
import {
  campaign30BusinessDna,
  campaign30Policy,
  campaign30ReplayCases,
  campaign30Strategy,
} from "./message-approval/fixtures/campaign30";
import type {
  CanaryApprovalProof,
  MessageApprovalContextLock,
} from "./message-approval/contracts";
import {
  CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY,
  deriveCreativeArtifactLineageFingerprint,
} from "./artifact-lineage";

function buildContextLock(): MessageApprovalContextLock {
  return {
    contextLockId: "ctx-caption-lineage-1",
    mode: "canary",
    campaignId: 30,
    businessDna: campaign30BusinessDna,
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    evidenceHashSha256: campaign30BusinessDna.evidenceHashSha256,
    campaignStrategy: campaign30Strategy,
    campaignStrategySnapshotId: campaign30Strategy.snapshotId,
    strategyHashSha256: campaign30Strategy.strategyHashSha256,
    policy: campaign30Policy,
    policyId: campaign30Policy.policyId,
    policyVersion: campaign30Policy.policyVersion,
    policyHashSha256: campaign30Policy.policyHashSha256,
    diagnostics: {
      contextSource: "legacy_loaded_context",
      contextReadyForComparison: true,
      missingContextFields: [],
    },
  };
}

/** Real envelope-bearing approved pack (approved CTA is "Learn More"). */
function buildApprovedCanaryPack(): {
  pack: CampaignMessagePack;
  proof: CanaryApprovalProof;
} {
  const replay = campaign30ReplayCases.find((item) => item.caseId === "C");
  if (!replay) throw new Error("Missing approved replay fixture");

  const lock = buildContextLock();
  const candidate = createMessagePackCandidate({
    candidateId: "cand-caption-lineage-1",
    campaignId: 30,
    createdAtIso: "2026-07-01T08:01:00.000Z",
    source: "ai_initial",
    copy: {
      copySchemaVersion: campaign30Policy.copySchemaVersion,
      headline: replay.copy.headline,
      subheadline: replay.copy.subheadline,
      benefitBulletsOrdered: replay.copy.benefitBullets,
      cta: replay.copy.cta,
      footer: { ...replay.copy.footerContact },
      proofPointsOrdered: ["Built for operations managers who need faster settlements"],
      platformCaptionsOrdered: [
        {
          platform: "instagram",
          caption: "Reduce payout delays for operations managers.",
          cta: replay.copy.cta,
          hashtagsOrdered: ["#operations", "#payouts"],
        },
      ],
    },
    businessDnaSnapshotId: lock.businessDnaSnapshotId,
    evidenceHashSha256: lock.evidenceHashSha256,
    campaignStrategySnapshotId: lock.campaignStrategySnapshotId,
    strategyHashSha256: lock.strategyHashSha256,
    qualityPolicyId: lock.policyId,
    qualityPolicyVersion: lock.policyVersion,
    policyHashSha256: lock.policyHashSha256,
    provenance: {
      adaptedFromLegacy: true,
      originSource: "latest_message_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: false,
        legacyValidationPassed: true,
        legacyValidationScore: 95,
        legacyValidationRejections: [],
      },
    },
  });

  const assessment = evaluateMessageCandidate({
    assessmentId: "assess-caption-lineage-1",
    evaluatedAtIso: "2026-07-01T08:02:00.000Z",
    candidate,
    businessDna: campaign30BusinessDna,
    campaignStrategy: campaign30Strategy,
    policy: campaign30Policy,
  });
  if (assessment.decision !== "approved") {
    throw new Error(
      `Fixture candidate must be approved, got ${assessment.decision}: ${JSON.stringify(assessment.hardIssues)}`
    );
  }

  const approved = createApprovedMessagePack({
    approvedRevisionId: "rev-caption-lineage-1",
    approvedAtIso: "2026-07-01T08:03:00.000Z",
    candidate,
    assessment,
    policy: campaign30Policy,
  });

  const { pack, proof } = adaptApprovedToCampaignMessagePack({
    approved,
    assessment,
    contextLock: lock,
    candidateSource: "ai_initial",
    specificityScore,
  });

  return { pack, proof };
}

const businessRow = {
  id: 20,
  name: "Rapid Print Studio",
  industry: "Printing",
  productOrService: "Business cards and flyers",
  location: "Centurion",
  websiteEvidence: {
    businessCategory: "local trades",
    productsServices: ["business cards", "flyer printing"],
    targetCustomers: ["local businesses"],
    updatedAt: "2026-07-01T07:00:00.000Z",
  },
};

const postRow = {
  id: 100,
  userId: 10,
  campaignId: 30,
  platform: "Instagram",
  title: "Same-day print services",
  hook: "Need business cards today?",
  caption: "We print business cards and flyers while you wait.",
  cta: "Old post CTA",
  metadata: {},
};

function buildCampaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    userId: 10,
    businessId: 20,
    name: "Print awareness",
    goal: "More print orders",
    productOrService: "Business cards and flyers",
    targetAudience: "Local businesses",
    targetBuyer: "Local businesses",
    mainPainPoint: "Slow turnaround elsewhere",
    offerDetails: "",
    excludedOffers: "",
    preferredCta: "Request a Quote",
    platforms: "Instagram, Facebook",
    primaryOutcome: "Leads",
    ...overrides,
  };
}

/** Approved WBS11 lineage bound to the same Strategy snapshot as the envelope. */
function buildStrategyApprovalLineage(campaignRow: Record<string, unknown>) {
  return {
    status: "approved",
    strategySnapshotId: campaign30Strategy.snapshotId,
    strategyVersion: 4,
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    strategyHashSha256: campaign30Strategy.strategyHashSha256,
    strategyRunId: 913,
    approvalRequestId: 57,
    creativeBriefFingerprint: computeCreativeBriefFingerprint(campaignRow as never),
  };
}

function createMockDb(options?: { campaignFields?: Record<string, unknown> }) {
  const campaignRow = buildCampaignRow(options?.campaignFields);
  const insertCalls: Array<{ table: string; values: any }> = [];

  const tableNameOf = (table: any) =>
    (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;

  return {
    insertCalls,
    campaignRow,
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = tableNameOf(table);
              if (tableName === "campaign_assets") return [];
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const tableName = tableNameOf(table);
            if (tableName === "content_posts") return [postRow];
            if (tableName === "campaigns") return [campaignRow];
            if (tableName === "businesses") return [businessRow];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        insertCalls.push({ table: tableNameOf(table), values });
        return [{ insertId: 701 }];
      }),
    })),
  };
}

/** Generated pack whose CTA semantics stay bound to the approved "Learn More". */
function buildGeneratedPackJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    linkedinCaption: "Same-day business cards for local businesses. Learn More",
    facebookCaption: "Flyers and business cards printed fast. 👉 Learn More!",
    instagramCaption: "Business cards done today. Learn more",
    whatsappCaption: "Need business cards? Learn more",
    emailSubject: "Business cards ready today",
    emailPreheader: "Fast printing for local businesses",
    emailBody: "We print business cards and flyers same-day. Learn More",
    hashtags: ["#businesscards", "#printing", "#localbusiness"],
    ctaVariations: ["Learn More", "LEARN MORE!", "Learn more."],
    outreachDm: "We help local businesses with business cards and flyers. Learn More",
    ...overrides,
  });
}

function mockSuccessfulGeneration(text: string = buildGeneratedPackJson()) {
  vi.mocked(generateText).mockResolvedValue({ text } as never);
}

function captionPackInserts(db: ReturnType<typeof createMockDb>) {
  return db.insertCalls.filter((call) => call.values?.assetType === "caption_pack");
}

function lastGenerationPrompt(): string {
  const calls = vi.mocked(generateText).mock.calls;
  return (calls[calls.length - 1][0] as { prompt: string }).prompt;
}

describe("caption_pack durable lineage (WBS12.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists full lineage with parent message_pack for an envelope-governed caption pack", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration();

    const result = await generateCaptionPack({ userId: 10, contentPostId: 100 });

    expect(result).not.toBeNull();
    expect(captionPackInserts(db)).toHaveLength(1);

    const metadata = captionPackInserts(db)[0].values.metadata;
    const envelope = approvedPack.v2ApprovalEnvelope!;
    const lineage = metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY];

    expect(lineage).toBeDefined();
    expect(lineage.artifactKind).toBe("caption_pack");
    expect(lineage.platform).toBeNull();
    expect(lineage.parent).toEqual({ artifactKind: "message_pack", artifactId: null });

    // Full Strategy lineage from the approved WBS11 authority chain (B5).
    expect(lineage.strategy).toEqual({
      strategySnapshotId: campaign30Strategy.snapshotId,
      strategyVersion: 4,
      businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
      strategyHashSha256: campaign30Strategy.strategyHashSha256,
      strategyRunId: 913,
      approvalRequestId: 57,
      creativeBriefFingerprint: computeCreativeBriefFingerprint(buildCampaignRow() as never),
    });

    // Approved-copy coordinates exactly match the parent message_pack envelope.
    expect(lineage.approvedCopy).toEqual({
      copyHashSha256: envelope.copyHashSha256,
      copySchemaVersion: envelope.copySchemaVersion,
      approvedRevisionId: envelope.approvedRevisionId,
      assessmentHashSha256: envelope.assessmentHashSha256,
      contextLockId: envelope.contextLockId,
    });

    expect(lineage.lineageFingerprintSha256).toBe(
      deriveCreativeArtifactLineageFingerprint({
        artifactKind: "caption_pack",
        platform: null,
        parent: { artifactKind: "message_pack" },
        strategy: lineage.strategy,
        approvedCopy: lineage.approvedCopy,
      })
    );

    // Generation was bound to the approved CTA, not the mutable campaign CTA.
    expect(lastGenerationPrompt()).toContain("Preferred CTA: Learn More");
  });

  it("produces an identical lineage fingerprint on deterministic replay", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const firstDb = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(firstDb as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration();
    await generateCaptionPack({ userId: 10, contentPostId: 100 });
    const firstLineage =
      captionPackInserts(firstDb)[0].values.metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY];

    const secondDb = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(secondDb as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration();
    await generateCaptionPack({ userId: 10, contentPostId: 100 });
    const secondLineage =
      captionPackInserts(secondDb)[0].values.metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY];

    expect(secondLineage).toEqual(firstLineage);
    expect(secondLineage.lineageFingerprintSha256).toBe(
      firstLineage.lineageFingerprintSha256
    );
  });

  it("fails closed before any provider spend when approved copy no longer matches its envelope", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const tamperedPack: CampaignMessagePack = {
      ...approvedPack,
      headline: "Silently rewritten headline keeps the envelope",
    };
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(tamperedPack as never);

    await expect(
      generateCaptionPack({ userId: 10, contentPostId: 100 })
    ).rejects.toThrowError(/copyHashSha256/);

    expect(generateText).not.toHaveBeenCalled();
    expect(db.insertCalls).toHaveLength(0);
  });

  it("fails closed when the campaign Strategy authority does not bind to the approved copy", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const mismatchedLineage = {
      ...buildStrategyApprovalLineage(buildCampaignRow()),
      strategySnapshotId: "strategy-UNRELATED",
    };
    const db = createMockDb({
      campaignFields: {
        workflowContext: { strategyApprovalLineage: mismatchedLineage },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);

    await expect(
      generateCaptionPack({ userId: 10, contentPostId: 100 })
    ).rejects.toThrowError(/strategy binding/i);

    expect(generateText).not.toHaveBeenCalled();
    expect(db.insertCalls).toHaveLength(0);
  });

  it("fails closed when an envelope-bearing pack has no approved Strategy authority", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);

    await expect(
      generateCaptionPack({ userId: 10, contentPostId: 100 })
    ).rejects.toThrowError(/approved lineage/i);

    expect(generateText).not.toHaveBeenCalled();
    expect(db.insertCalls).toHaveLength(0);
  });

  it("fails closed before persistence when the generated pack rewrites the approved CTA", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration(
      buildGeneratedPackJson({ linkedinCaption: "Book a free demo with our consultants today." })
    );

    await expect(
      generateCaptionPack({ userId: 10, contentPostId: 100 })
    ).rejects.toThrowError(/rewrites the approved CTA/i);

    expect(captionPackInserts(db)).toHaveLength(0);
  });

  it("fails closed before persistence when a CTA variation rewrites the approved CTA", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration(
      buildGeneratedPackJson({ ctaVariations: ["Learn More", "Unlock your potential today"] })
    );

    await expect(
      generateCaptionPack({ userId: 10, contentPostId: 100 })
    ).rejects.toThrowError(/rewrites the approved CTA/i);

    expect(captionPackInserts(db)).toHaveLength(0);
  });

  it("allows a formatting-only caption variation under copy authority", async () => {
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration(
      buildGeneratedPackJson({
        instagramCaption: "Business cards done today. 👉 LEARN MORE! Tap the link in bio.",
        ctaVariations: ["LEARN MORE!"],
      })
    );

    const result = await generateCaptionPack({ userId: 10, contentPostId: 100 });

    expect(result).not.toBeNull();
    expect(captionPackInserts(db)).toHaveLength(1);
    const lineage =
      captionPackInserts(db)[0].values.metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY];
    expect(lineage.artifactKind).toBe("caption_pack");
  });

  it("keeps envelope-less legacy caption packs free of lineage metadata", async () => {
    const legacyPack: CampaignMessagePack = {
      headline: "Legacy headline",
      subheadline: "Legacy subheadline",
      benefitBullets: ["Legacy benefit"],
      cta: "Learn More",
      footerContact: {},
      proofPoints: [],
      platformCaptions: [],
      validation: { passed: true, score: 95, rejections: [], warnings: [] },
    };
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(legacyPack as never);
    mockSuccessfulGeneration();

    const result = await generateCaptionPack({ userId: 10, contentPostId: 100 });

    expect(result).not.toBeNull();
    expect(captionPackInserts(db)).toHaveLength(1);
    const metadata = captionPackInserts(db)[0].values.metadata;
    expect(metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]).toBeUndefined();
    // Legacy metadata shape is otherwise unchanged.
    expect(metadata.assetType).toBe("caption_pack");
    expect(metadata.creativeBriefFingerprint).toBe(
      computeCreativeBriefFingerprint(buildCampaignRow() as never)
    );
    expect(metadata.linkedinCaption).toBeDefined();
    // Legacy prompt keeps using the mutable campaign CTA.
    expect(lastGenerationPrompt()).toContain("Preferred CTA: Request a Quote");
  });

  it("keeps campaigns without an approved message pack on the legacy path", async () => {
    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(null as never);
    mockSuccessfulGeneration();

    const result = await generateCaptionPack({ userId: 10, contentPostId: 100 });

    expect(result).not.toBeNull();
    expect(captionPackInserts(db)).toHaveLength(1);
    const metadata = captionPackInserts(db)[0].values.metadata;
    expect(metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]).toBeUndefined();
  });

  it("never persists the lineage-bearing approved pack hash as raw copy in metadata", async () => {
    // Only digests/coordinates are persisted — never raw approved copy text.
    const { pack: approvedPack } = buildApprovedCanaryPack();
    const db = createMockDb({
      campaignFields: {
        workflowContext: {
          strategyApprovalLineage: buildStrategyApprovalLineage(buildCampaignRow()),
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(loadApprovedMessagePack).mockResolvedValue(approvedPack as never);
    mockSuccessfulGeneration();

    await generateCaptionPack({ userId: 10, contentPostId: 100 });

    const metadata = captionPackInserts(db)[0].values.metadata;
    const lineage = metadata[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY];
    expect(JSON.stringify(lineage)).not.toContain(approvedPack.headline);
    expect(lineage.approvedCopy.copyHashSha256).toBe(
      approvedPack.v2ApprovalEnvelope!.copyHashSha256
    );
  });
});
