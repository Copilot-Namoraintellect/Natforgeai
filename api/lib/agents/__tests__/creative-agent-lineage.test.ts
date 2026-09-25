import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreativeStrategySnapshotInput } from "../../creative/strategy-snapshot-input";
import type { CampaignMessagePack } from "../../creative/campaign-message-architect";
import { computeCampaignMessagePackCopyHash } from "../../creative/approved-copy-authority";
import { deriveCreativeArtifactLineageFingerprint } from "../../creative/artifact-lineage";

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../creative/campaign-message-architect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../creative/campaign-message-architect")>();
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    validateCampaignCopy: vi.fn(() => ({ passed: true, score: 100, rejections: [], warnings: [] })),
  };
});

vi.mock("../../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 1000, required: 8 })),
  deductCredits: vi.fn(async () => ({ newBalance: 992 })),
}));

vi.mock("../../billing/cost-tracker", () => ({
  getEstimatedAgentCost: vi.fn(() => 8),
}));

vi.mock("../../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

interface MockDb {
  select: () => { from: (table: unknown) => { where: () => unknown } };
  insert: (table: unknown) => { values: (values: unknown) => Promise<unknown> };
  update: () => { set: () => { where: () => Promise<unknown[]> } };
  delete: () => { where: () => Promise<unknown[]> };
  insertedRows: Array<{ table: string; values: Record<string, unknown> }>;
}

function createMockDb(): MockDb {
  const insertedRows: Array<{ table: string; values: Record<string, unknown> }> = [];

  const whereResult = (table: unknown) => {
    const tableName = getTableName(table);
    let limitResult: unknown[] = [];

    if (tableName === "campaigns") {
      limitResult = [
        {
          id: 28,
          userId: 18,
          businessId: 24,
          name: "Zutohub Marketing Campaign",
          goal: "awareness",
          workflowState: "creatives_generating",
          workflowContext: {
            coreMessage: "Empower your workforce",
            valueProposition: "Simplify payouts",
          },
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
          platforms: "Instagram, Facebook",
          targetAudience: "Small businesses",
          ctaStrategy: "Awareness: Learn More\nConsideration: Get Pricing\nConversion: Book a Demo",
          contentCalendar: null,
          offers: null,
          primaryOutcome: "Leads",
          targetBuyer: "Small business owner",
          mainPainPoint: "Manual payouts",
          productOrService: "Payout platform",
          offerDetails: "",
          preferredCta: "Awareness: Learn More\nConsideration: Get Pricing\nConversion: Book a Demo",
          excludedOffers: "",
          referenceStyle: "",
          contentStyle: "professional",
        },
      ];
    } else if (tableName === "businesses") {
      limitResult = [
        {
          id: 24,
          userId: 18,
          name: "Zutohub",
          industry: "Fintech",
          location: "Randburg",
          websiteEvidence: {
            businessCategory: "Financial services",
            productsServices: ["Payouts"],
            targetCustomers: ["Small businesses"],
          },
        },
      ];
    }

    return {
      limit: vi.fn(async () => limitResult),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => []),
      })),
      then: (resolve: (value: unknown[]) => void) => resolve([]),
    };
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })) as unknown as MockDb["select"],
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        insertedRows.push({ table: getTableName(table) ?? "unknown", values });
        return [{ insertId: 123 }];
      }),
    })) as unknown as MockDb["insert"],
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })) as unknown as MockDb["update"],
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })) as unknown as MockDb["delete"],
    insertedRows,
  };
}

const testStrategyInput: CreativeStrategySnapshotInput = {
  authority: {
    strategySnapshotId: "strategy-snapshot-501",
    strategyVersion: 1,
    businessDnaSnapshotId: "bdna-snapshot-1",
    strategyHashSha256: "a".repeat(64),
    strategyRunId: 501,
    approvalRequestId: 77,
    creativeBriefFingerprint: "wbs12b3-brief-fingerprint",
  },
  snapshot: {
    coreMessage: "Immutable core message",
    valueProposition: "Immutable value proposition",
    personas: [],
  },
  creativeContext: {
    coreMessage: "Immutable core message",
    valueProposition: "Immutable value proposition",
    positioning: "Immutable positioning",
    campaignTheme: "Immutable theme",
    personas: [],
  },
};

const testGenerationOperation = { source: "job" as const, id: 9999 };

/**
 * Approved message pack whose copy genuinely hashes to its V2 envelope, with
 * a platform-specific approved CTA for Instagram that differs from the
 * pack-level CTA — proving bindings are per-platform.
 */
function buildGovernedApprovedPack(): CampaignMessagePack {
  const pack: CampaignMessagePack = {
    headline: "Payout platform for small businesses in Randburg",
    subheadline: "Move staff earnings faster and cut manual payout admin.",
    benefitBullets: [
      "Automated tip and commission payouts.",
      "Less admin time for owners.",
      "Staff get paid faster and more reliably.",
    ],
    cta: "Learn More",
    footerContact: { location: "Randburg" },
    proofPoints: [],
    platformCaptions: [
      {
        platform: "Instagram",
        caption: "Stop losing staff to slow manual payouts. Zutohub moves earnings faster.",
        cta: "Book a Demo",
        hashtags: ["#fintech", "#smallbiz"],
      },
      {
        platform: "Facebook",
        caption: "Randburg small businesses: cut payout admin and keep staff happy.",
        cta: "Learn More",
        hashtags: ["#fintech", "#smallbiz"],
      },
    ],
    validation: { passed: true, score: 100, rejections: [], warnings: [] },
  };

  pack.v2ApprovalEnvelope = {
    schemaVersion: "v2.1",
    approvalMode: "canary",
    contextLockId: "ctx-agent-lineage-1",
    approvedRevisionId: "rev-agent-lineage-1",
    candidateId: "cand-agent-lineage-1",
    assessmentId: "assess-agent-lineage-1",
    assessmentHashSha256: "d".repeat(64),
    copyHashSha256: "",
    copySchemaVersion: "v2.1",
    businessDnaSnapshotId: "bdna-agent-lineage-1",
    evidenceHashSha256: "e".repeat(64),
    campaignStrategySnapshotId: "strategy-agent-lineage-1",
    strategyHashSha256: "b".repeat(64),
    policyId: "policy-v2-default",
    policyVersion: 3,
    policyHashSha256: "c".repeat(64),
    approvedAtIso: "2026-07-01T08:03:00.000Z",
    candidateSource: "ai_initial",
    sourceProvenance: {
      adaptedFromLegacy: false,
      originSource: "ai_refined_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: false,
        legacyValidationPassed: true,
        legacyValidationScore: 96,
        legacyValidationRejections: [],
      },
    },
    decision: "approved",
    score: 96,
    hardIssueCodes: [],
    warningCodes: [],
  };
  // The copy hash depends on the envelope's copySchemaVersion, so it can only
  // be computed after the envelope is attached.
  pack.v2ApprovalEnvelope = {
    ...pack.v2ApprovalEnvelope,
    copyHashSha256: computeCampaignMessagePackCopyHash(pack),
  };

  return pack;
}

function buildAgentPackOutput(options?: { instagramAdaptedCta?: string }): Record<string, unknown> {
  return {
    videoConcepts: [
      {
        title: "Master Video",
        platform: "Instagram",
        duration: "30s",
        hook: "Stop losing staff to slow manual payouts",
        openingHook3Sec: "Open",
        scenes: [{ sceneNumber: 1, durationSeconds: 5, visualDescription: "Scene 1" }],
        backgroundMusicMood: "Upbeat",
        cta: "Learn More",
        visualStyle: "Clean",
        targetPersona: "Owner",
        funnelStage: "awareness",
        voiceoverScript: null,
        thumbnailPrompt: null,
      },
    ],
    carouselAds: [],
    socialPosts: [
      {
        platform: "Instagram",
        type: "social_post",
        title: "Master Post",
        hook: "Stop losing staff to slow manual payouts",
        caption:
          "Every week your team waits for manual payout paperwork. Zutohub's payout platform moves earnings faster, cuts admin, and keeps staff happy without extra salary cost. Manual payouts drain morale and time. Switch to automated payouts designed for small businesses in Randburg.",
        cta: "Learn More",
        hashtags: ["#fintech", "#smallbiz"],
        visualPrompt: "A clean visual",
        bestTimeToPost: "9am",
        salesAngle: "Save time",
        targetPersona: "Owner",
        funnelStage: "awareness",
        painPoint: "Manual payouts",
        transformation: "Automated payouts",
        urgency: null,
      },
    ],
    adCopyVariations: [],
    whatsAppPromos: [],
    emailCampaign: null,
    launchSequence: null,
    platformAdaptations: [
      {
        platform: "Instagram",
        adaptedCaption: "Instagram-scoped caption with line breaks and hashtag formatting.",
        adaptedCta: options?.instagramAdaptedCta ?? "Book a Demo",
        adaptedHashtags: ["#fintech", "#smallbiz", "#randburg"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
    ],
    hashtagSet: { core: ["#fintech"], trending: [], niche: [], platformSpecific: [] },
    hooks: null,
    ctaVariations: null,
    packSummary: "Pack summary",
  };
}

function mockRunAgentResponse(opts: { prompt: string }, runId: number): { runId: number; output: Record<string, unknown> } {
  if (opts.prompt.includes("supplementary")) {
    return {
      runId: runId + 1,
      output: {
        assets: [
          { assetType: "image", title: "Hero 1", content: "Prompt 1", prompt: null, platform: null, variations: null },
        ],
      },
    };
  }
  return { runId, output: buildAgentPackOutput() };
}

describe("creative agent platform caption lineage (WBS12.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists lineage on platform captions identifying the approved semantic source", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const approvedPack = buildGovernedApprovedPack();
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 91));

    const result = await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    expect(result.savedPosts).toBe(2);

    const envelope = approvedPack.v2ApprovalEnvelope!;
    const captionRows = db.insertedRows.filter((row) => row.values.assetType === "caption_adaptation");
    // Campaign platforms: Instagram (AI adaptation) + Facebook (fallback).
    expect(captionRows).toHaveLength(2);

    for (const row of captionRows) {
      const lineage = (row.values.metadata as any).creativeArtifactLineage;
      expect(lineage).toBeDefined();
      expect(lineage.artifactKind).toBe("platform_caption");
      expect(lineage.parent).toEqual({ artifactKind: "message_pack", artifactId: null });
      expect(lineage.approvedCopy).toEqual({
        copyHashSha256: envelope.copyHashSha256,
        copySchemaVersion: envelope.copySchemaVersion,
        approvedRevisionId: envelope.approvedRevisionId,
        assessmentHashSha256: envelope.assessmentHashSha256,
        contextLockId: envelope.contextLockId,
      });
      expect(lineage.strategy).toEqual({
        strategySnapshotId: testStrategyInput.authority.strategySnapshotId,
        strategyVersion: testStrategyInput.authority.strategyVersion,
        businessDnaSnapshotId: testStrategyInput.authority.businessDnaSnapshotId,
        strategyHashSha256: testStrategyInput.authority.strategyHashSha256,
        strategyRunId: testStrategyInput.authority.strategyRunId,
        approvalRequestId: testStrategyInput.authority.approvalRequestId,
        creativeBriefFingerprint: testStrategyInput.authority.creativeBriefFingerprint,
      });
      expect(lineage.lineageFingerprintSha256).toBe(
        deriveCreativeArtifactLineageFingerprint({
          artifactKind: "platform_caption",
          platform: (row.values.metadata as any).platform,
          parent: { artifactKind: "message_pack" },
          strategy: lineage.strategy,
          approvedCopy: lineage.approvedCopy,
        })
      );
    }

    const instagramRow = captionRows.find((row) => (row.values.metadata as any).platform === "Instagram")!;
    const facebookRow = captionRows.find((row) => (row.values.metadata as any).platform === "Facebook")!;
    expect(instagramRow).toBeDefined();
    expect(facebookRow).toBeDefined();
    // Facebook was a fallback adaptation bound to the pack-level CTA.
    expect((facebookRow.values.metadata as any).adaptedCta).toBe("Learn More");
  });

  it("persists lineage on the hashtag set as a derived variant of the approved copy", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const approvedPack = buildGovernedApprovedPack();
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 92));

    await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    const hashtagRow = db.insertedRows.find((row) => row.values.assetType === "hashtag_set");
    expect(hashtagRow).toBeDefined();
    const lineage = (hashtagRow!.values.metadata as any).creativeArtifactLineage;
    expect(lineage.artifactKind).toBe("hashtag_set");
    expect(lineage.parent).toEqual({ artifactKind: "message_pack", artifactId: null });
    expect(lineage.approvedCopy.copyHashSha256).toBe(approvedPack.v2ApprovalEnvelope!.copyHashSha256);
  });

  it("fails closed when a platform caption rewrites the approved CTA", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const approvedPack = buildGovernedApprovedPack();
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => ({
      runId: 93,
      output: buildAgentPackOutput({ instagramAdaptedCta: "Sign Up Today" }),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError(/rewrites the approved CTA/);

    // No governed caption adaptation may be persisted with a rewritten CTA.
    const captionRows = db.insertedRows.filter((row) => row.values.assetType === "caption_adaptation");
    expect(captionRows).toHaveLength(0);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("fails closed when the approved pack copy no longer hashes to its envelope", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const approvedPack = buildGovernedApprovedPack();
    // Simulate tampering after approval: copy rewritten without re-approval.
    approvedPack.cta = "Claim your millions now";
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 94));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError();

    const captionRows = db.insertedRows.filter((row) => row.values.assetType === "caption_adaptation");
    expect(captionRows).toHaveLength(0);
  });

  it("keeps envelope-less legacy packs ungoverned and lineage-free", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const legacyPack: CampaignMessagePack = {
      headline: "Payout platform for small businesses in Randburg",
      subheadline: "Move staff earnings faster and cut manual payout admin.",
      benefitBullets: [
        "Automated tip and commission payouts.",
        "Less admin time for owners.",
        "Staff get paid faster and more reliably.",
      ],
      cta: "Learn More",
      footerContact: { location: "Randburg" },
      proofPoints: [],
      platformCaptions: [],
      validation: { passed: true, score: 96, rejections: [], warnings: [] },
    };
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(legacyPack as any);
    // A divergent CTA is tolerated without governance and persists as before.
    vi.mocked(runAgent).mockImplementation(async (opts) => ({
      runId: 95,
      output: buildAgentPackOutput({ instagramAdaptedCta: "Sign Up Today" }),
    }));

    const result = await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    expect(result.savedPosts).toBe(2);
    const captionRows = db.insertedRows.filter((row) => row.values.assetType === "caption_adaptation");
    expect(captionRows).toHaveLength(2);
    for (const row of captionRows) {
      expect((row.values.metadata as any).creativeArtifactLineage).toBeUndefined();
    }
    const hashtagRow = db.insertedRows.find((row) => row.values.assetType === "hashtag_set");
    expect((hashtagRow!.values.metadata as any).creativeArtifactLineage).toBeUndefined();
  });

  it("treats formatting-only caption changes as the same semantic authority", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const dbFirst = createMockDb();
    vi.mocked(getDb).mockReturnValue(dbFirst as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => ({
      runId: 96,
      output: buildAgentPackOutput({ instagramAdaptedCta: "book a demo" }),
    }));

    await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    const firstInstagram = dbFirst.insertedRows.find(
      (row) => row.values.assetType === "caption_adaptation" && (row.values.metadata as any).platform === "Instagram"
    )!;
    const firstLineage = (firstInstagram.values.metadata as any).creativeArtifactLineage;

    // Same authority, formatting-level CTA casing change only: the lineage
    // fingerprint must be identical — no new semantic authority is minted.
    const dbSecond = createMockDb();
    vi.mocked(getDb).mockReturnValue(dbSecond as unknown as ReturnType<typeof getDb>);
    vi.mocked(runAgent).mockImplementation(async (opts) => ({
      runId: 97,
      output: buildAgentPackOutput({ instagramAdaptedCta: "Book a Demo" }),
    }));

    await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    const secondInstagram = dbSecond.insertedRows.find(
      (row) => row.values.assetType === "caption_adaptation" && (row.values.metadata as any).platform === "Instagram"
    )!;
    const secondLineage = (secondInstagram.values.metadata as any).creativeArtifactLineage;

    expect(secondLineage.lineageFingerprintSha256).toBe(firstLineage.lineageFingerprintSha256);
    expect(secondLineage.approvedCopy).toEqual(firstLineage.approvedCopy);
  });
});
