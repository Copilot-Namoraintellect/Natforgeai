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

const APPROVED_CTA = "Learn More";

/**
 * Approved message pack whose copy genuinely hashes to its V2 envelope, with
 * a platform-specific approved CTA for Instagram that differs from the
 * pack-level CTA.
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
    cta: APPROVED_CTA,
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
        cta: APPROVED_CTA,
        hashtags: ["#fintech", "#smallbiz"],
      },
    ],
    validation: { passed: true, score: 100, rejections: [], warnings: [] },
  };

  pack.v2ApprovalEnvelope = {
    schemaVersion: "v2.1",
    approvalMode: "canary",
    contextLockId: "ctx-format-lineage-1",
    approvedRevisionId: "rev-format-lineage-1",
    candidateId: "cand-format-lineage-1",
    assessmentId: "assess-format-lineage-1",
    assessmentHashSha256: "d".repeat(64),
    copyHashSha256: "",
    copySchemaVersion: "v2.1",
    businessDnaSnapshotId: "bdna-format-lineage-1",
    evidenceHashSha256: "e".repeat(64),
    campaignStrategySnapshotId: "strategy-format-lineage-1",
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

interface FormatOutputOptions {
  videoCta?: string;
  carouselCta?: string;
  adCtas?: string[];
  whatsappCta?: string;
  emailCta?: string;
  launchCtas?: string[];
  emailBody?: string;
  whatsappMessage?: string;
}

/**
 * Full Hero Campaign Pack output covering every WBS12.5/WBS12.6 format:
 * video script, carousel ad, ad copy variations, WhatsApp promo, email
 * campaign and launch sequence. All CTAs default to the approved CTA.
 */
function buildAgentPackOutput(options: FormatOutputOptions = {}): Record<string, unknown> {
  return {
    videoConcepts: [
      {
        title: "Master Video",
        platform: "Instagram",
        duration: "30s",
        hook: "Stop losing staff to slow manual payouts",
        openingHook3Sec: "Every week your team waits for manual payout paperwork.",
        scenes: [
          {
            sceneNumber: 1,
            durationSeconds: 5,
            visualDescription: "Owner reconciles payout paperwork at a desk.",
            onScreenText: "Manual payouts drain morale",
            voiceoverScript: "Manual payouts drain morale and time.",
            audioDirection: "Soft tension",
            productShotInstruction: null,
          },
          {
            sceneNumber: 2,
            durationSeconds: 5,
            visualDescription: "Zutohub dashboard automates the payout run.",
            onScreenText: "Automated payouts for small businesses",
            voiceoverScript: "Zutohub moves earnings faster and cuts admin.",
            audioDirection: "Upbeat resolve",
            productShotInstruction: "Close-up of the payout dashboard.",
          },
        ],
        backgroundMusicMood: "Upbeat",
        cta: options.videoCta ?? APPROVED_CTA,
        visualStyle: "Clean",
        targetPersona: "Owner",
        funnelStage: "awareness",
        voiceoverScript: null,
        thumbnailPrompt: null,
      },
    ],
    carouselAds: [
      {
        title: "Carousel",
        platform: "Instagram",
        hook: "Stop losing staff to slow manual payouts",
        slides: [
          { slideNumber: 1, headline: "Slow payouts cost morale", visualDirection: "V", bodyText: "Manual payout admin eats owner time.", cta: null },
          { slideNumber: 2, headline: "Automate the payout run", visualDirection: "V", bodyText: "Zutohub moves earnings faster.", cta: null },
        ],
        overallCta: options.carouselCta ?? APPROVED_CTA,
        visualStyle: "Clean",
        targetPersona: "Owner",
        funnelStage: "awareness",
        benefitSequence: "Pain → solution → outcome",
      },
    ],
    socialPosts: [
      {
        platform: "Instagram",
        type: "social_post",
        title: "Master Post",
        hook: "Stop losing staff to slow manual payouts",
        caption:
          "Every week your team waits for manual payout paperwork. Zutohub's payout platform moves earnings faster, cuts admin, and keeps staff happy without extra salary cost. Manual payouts drain morale and time. Switch to automated payouts designed for small businesses in Randburg.",
        cta: APPROVED_CTA,
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
    adCopyVariations: [
      {
        variantName: "V1",
        angle: "Time saving",
        headline: "Cut manual payout admin",
        primaryText: "Zutohub automates staff payouts for Randburg small businesses.",
        cta: options.adCtas?.[0] ?? APPROVED_CTA,
        platform: "Facebook",
        funnelStage: "awareness",
      },
      {
        variantName: "V2",
        angle: "Staff retention",
        headline: "Pay staff faster",
        primaryText: "Slow payouts drain morale. Zutohub moves earnings faster.",
        cta: options.adCtas?.[1] ?? APPROVED_CTA,
        platform: "Instagram",
        funnelStage: "awareness",
      },
    ],
    whatsAppPromos: [
      {
        title: "WhatsApp Promo",
        message: options.whatsappMessage ?? "Zutohub moves staff earnings faster and cuts payout admin for Randburg small businesses.",
        followUp: null,
        cta: options.whatsappCta ?? APPROVED_CTA,
        tone: "friendly",
      },
    ],
    emailCampaign: {
      subjectLine: "Faster staff payouts without the admin",
      preheader: "Zutohub automates payouts for small businesses.",
      body: options.emailBody ?? "Every week your team waits for manual payout paperwork. Zutohub moves earnings faster and cuts admin for Randburg small businesses.",
      cta: options.emailCta ?? APPROVED_CTA,
      tone: "professional",
      segment: "Owners",
    },
    launchSequence: {
      title: "Launch",
      sequenceSteps: [
        { stepNumber: 1, channel: "email", timing: "Day 1", message: "Announcement for the payout platform.", cta: options.launchCtas?.[0] ?? APPROVED_CTA },
        { stepNumber: 2, channel: "whatsapp", timing: "Day 3", message: "Reminder for small business owners.", cta: options.launchCtas?.[1] ?? APPROVED_CTA },
      ],
    },
    platformAdaptations: [
      {
        platform: "Instagram",
        adaptedCaption: "Instagram-scoped caption with line breaks and hashtag formatting.",
        adaptedCta: "Book a Demo",
        adaptedHashtags: ["#fintech", "#smallbiz", "#randburg"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
      {
        platform: "Facebook",
        adaptedCaption: "Facebook-scoped caption with conversational formatting.",
        adaptedCta: APPROVED_CTA,
        adaptedHashtags: ["#fintech", "#smallbiz"],
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

async function runAgentWithPack(pack: CampaignMessagePack, runId: number) {
  const { getDb } = await import("../../../queries/connection");
  const { runAgent } = await import("../runner");
  const { runCreativeAgent } = await import("../creative-agent");
  const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

  const db = createMockDb();
  vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  vi.mocked(ensureApprovedMessagePack).mockResolvedValue(pack as any);
  vi.mocked(runAgent).mockImplementation(async () => ({
    runId,
    output: buildAgentPackOutput(),
  }));

  const result = await runCreativeAgent({
    userId: 18,
    campaignId: 28,
    generationOperation: testGenerationOperation,
    strategyInput: testStrategyInput,
  });

  return { db, result };
}

function getLineage(row: { values: Record<string, unknown> }) {
  return (row.values.metadata as any).creativeArtifactLineage;
}

function expectGovernedLineage(
  lineage: any,
  expected: {
    artifactKind: string;
    platform: string | null;
    envelope: NonNullable<CampaignMessagePack["v2ApprovalEnvelope"]>;
  }
) {
  expect(lineage).toBeDefined();
  expect(lineage.artifactKind).toBe(expected.artifactKind);
  expect(lineage.platform).toBe(expected.platform);
  expect(lineage.parent).toEqual({ artifactKind: "message_pack", artifactId: null });
  expect(lineage.approvedCopy).toEqual({
    copyHashSha256: expected.envelope.copyHashSha256,
    copySchemaVersion: expected.envelope.copySchemaVersion,
    approvedRevisionId: expected.envelope.approvedRevisionId,
    assessmentHashSha256: expected.envelope.assessmentHashSha256,
    contextLockId: expected.envelope.contextLockId,
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
      artifactKind: expected.artifactKind as any,
      platform: expected.platform,
      parent: { artifactKind: "message_pack" },
      strategy: lineage.strategy,
      approvedCopy: lineage.approvedCopy,
    })
  );
}

describe("creative agent video/script and non-social format lineage (WBS12.5/WBS12.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists exact Strategy + approved-copy lineage on the governed video script", async () => {
    const approvedPack = buildGovernedApprovedPack();
    const { db, result } = await runAgentWithPack(approvedPack, 201);

    expect(result.savedPosts).toBe(2);
    const videoRow = db.insertedRows.find((row) => row.values.type === "video_concept");
    expect(videoRow).toBeDefined();
    expectGovernedLineage(getLineage(videoRow!), {
      artifactKind: "video_script",
      platform: "Instagram",
      envelope: approvedPack.v2ApprovalEnvelope!,
    });
  });

  it("persists lineage on email, WhatsApp, ad, carousel and launch artifacts", async () => {
    const approvedPack = buildGovernedApprovedPack();
    const { db } = await runAgentWithPack(approvedPack, 202);
    const envelope = approvedPack.v2ApprovalEnvelope!;

    const emailRow = db.insertedRows.find((row) => row.values.assetType === "email_copy");
    expectGovernedLineage(getLineage(emailRow!), {
      artifactKind: "email_copy",
      platform: "email",
      envelope,
    });

    const whatsappRow = db.insertedRows.find((row) => row.values.assetType === "whatsapp_promo");
    expectGovernedLineage(getLineage(whatsappRow!), {
      artifactKind: "whatsapp_copy",
      platform: "whatsapp",
      envelope,
    });

    const adRow = db.insertedRows.find((row) => row.values.assetType === "ad_copy");
    expectGovernedLineage(getLineage(adRow!), {
      artifactKind: "ad_copy",
      platform: null,
      envelope,
    });

    const carouselRow = db.insertedRows.find((row) => row.values.assetType === "carousel_ad");
    expectGovernedLineage(getLineage(carouselRow!), {
      artifactKind: "carousel_ad",
      platform: "Instagram",
      envelope,
    });

    const launchRow = db.insertedRows.find((row) => row.values.assetType === "launch_pack");
    expectGovernedLineage(getLineage(launchRow!), {
      artifactKind: "launch_pack",
      platform: null,
      envelope,
    });
  });

  it("fails closed when a video script rewrites the approved CTA and persists nothing", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 203,
      output: buildAgentPackOutput({ videoCta: "Sign Up Today" }),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError(/video_script for Instagram rewrites the approved CTA/);

    // Governance fails closed before any governed artifact is persisted.
    expect(db.insertedRows).toHaveLength(0);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("fails closed when an email campaign rewrites the approved CTA", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 204,
      output: buildAgentPackOutput({ emailCta: "Claim your millions now" }),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError(/email_copy campaign rewrites the approved CTA/);

    expect(db.insertedRows).toHaveLength(0);
  });

  it("fails closed when an ad variation rewrites the approved CTA", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 205,
      output: buildAgentPackOutput({ adCtas: [APPROVED_CTA, "Buy now before it is gone"] }),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError(/ad_copy variation "V2" rewrites the approved CTA/);

    expect(db.insertedRows).toHaveLength(0);
  });

  it("fails closed when a launch sequence step rewrites the approved CTA", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 206,
      output: buildAgentPackOutput({ launchCtas: [APPROVED_CTA, "Last chance — act now"] }),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError(/launch_pack step 2 rewrites the approved CTA/);

    expect(db.insertedRows).toHaveLength(0);
  });

  it("fails closed when the approved pack copy no longer hashes to its envelope", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const tamperedPack = buildGovernedApprovedPack();
    // Simulate tampering after approval: copy rewritten without re-approval.
    tamperedPack.cta = "Claim your millions now";
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(tamperedPack as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 207,
      output: buildAgentPackOutput(),
    }));

    await expect(
      runCreativeAgent({
        userId: 18,
        campaignId: 28,
        generationOperation: testGenerationOperation,
        strategyInput: testStrategyInput,
      })
    ).rejects.toThrowError();

    expect(db.insertedRows).toHaveLength(0);
  });

  it("treats formatting-only channel adaptation as the same semantic authority", async () => {
    const first = await runAgentWithPack(buildGovernedApprovedPack(), 208);
    const firstEmail = first.db.insertedRows.find((row) => row.values.assetType === "email_copy")!;
    const firstLineage = getLineage(firstEmail);

    // Same authority; only channel formatting/tone wording changes. The
    // approved CTA stays authoritative, so the replayed lineage fingerprint
    // must be identical — no new semantic authority is minted.
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const dbSecond = createMockDb();
    vi.mocked(getDb).mockReturnValue(dbSecond as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(buildGovernedApprovedPack() as any);
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 209,
      output: buildAgentPackOutput({
        emailBody: "Reformatted email body with different paragraph breaks and wording, still grounded in the approved message.",
        whatsappMessage: "Shorter WhatsApp wording with the same approved call to action.",
      }),
    }));

    await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    const secondEmail = dbSecond.insertedRows.find((row) => row.values.assetType === "email_copy")!;
    const secondLineage = getLineage(secondEmail);

    expect(secondLineage.lineageFingerprintSha256).toBe(firstLineage.lineageFingerprintSha256);
    expect(secondLineage.approvedCopy).toEqual(firstLineage.approvedCopy);
    expect(secondLineage.strategy).toEqual(firstLineage.strategy);
  });

  it("keeps envelope-less legacy packs lineage-free and tolerant of CTA divergence", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    const legacyPack: CampaignMessagePack = {
      headline: "Payout platform for small businesses in Randburg",
      subheadline: "Move staff earnings faster and cut manual payout admin.",
      benefitBullets: ["Automated tip and commission payouts."],
      cta: APPROVED_CTA,
      footerContact: { location: "Randburg" },
      proofPoints: [],
      platformCaptions: [],
      validation: { passed: true, score: 96, rejections: [], warnings: [] },
    };
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(legacyPack as any);
    // A divergent CTA is tolerated without governance and persists as before.
    vi.mocked(runAgent).mockImplementation(async () => ({
      runId: 210,
      output: buildAgentPackOutput({ videoCta: "Sign Up Today", emailCta: "Sign Up Today" }),
    }));

    const result = await runCreativeAgent({
      userId: 18,
      campaignId: 28,
      generationOperation: testGenerationOperation,
      strategyInput: testStrategyInput,
    });

    expect(result.savedPosts).toBe(2);
    for (const row of db.insertedRows) {
      expect((row.values.metadata as any).creativeArtifactLineage).toBeUndefined();
    }
  });

  it("persists exactly one row per artifact — governance causes no duplicate persistence", async () => {
    const { db, result } = await runAgentWithPack(buildGovernedApprovedPack(), 211);

    expect(result.savedPosts).toBe(2);
    const postRows = db.insertedRows.filter((row) => row.table === "content_posts");
    expect(postRows).toHaveLength(2);

    const assetRows = db.insertedRows.filter((row) => row.table === "campaign_assets");
    const byType = (assetType: string) => assetRows.filter((row) => row.values.assetType === assetType);
    expect(byType("carousel_ad")).toHaveLength(1);
    expect(byType("ad_copy")).toHaveLength(1);
    expect(byType("whatsapp_promo")).toHaveLength(1);
    expect(byType("email_copy")).toHaveLength(1);
    expect(byType("launch_pack")).toHaveLength(1);
    expect(byType("caption_adaptation")).toHaveLength(2);
    expect(byType("hashtag_set")).toHaveLength(1);
    expect(assetRows).toHaveLength(8);
    expect(db.insertedRows).toHaveLength(10);
  });
});
