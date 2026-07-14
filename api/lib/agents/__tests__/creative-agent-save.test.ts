import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

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
  select: () => {
    from: (table: unknown) => {
      where: () => {
        limit: () => Promise<unknown[]>;
        orderBy: () => { limit: () => Promise<unknown[]> };
        then: (resolve: (value: unknown[]) => void) => void;
      };
    };
  };
  insert: (table: unknown) => { values: () => Promise<unknown> };
  update: () => { set: () => { where: () => Promise<unknown[]> } };
  delete: () => { where: () => Promise<unknown[]> };
}

function createMockDb({ insertShouldFail = false }: { insertShouldFail?: boolean } = {}): MockDb {
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

  const insertResult = (table: unknown) => {
    const tableName = getTableName(table);

    if (tableName === "content_posts" && insertShouldFail) {
      return {
        values: vi.fn(async () => {
          throw new Error("ER_WARN_DATA_OUT_OF_RANGE: integer overflow simulated");
        }),
      };
    }

    return {
      values: vi.fn(async () => [{ insertId: 123 }]),
    };
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })) as unknown as MockDb["select"],
    insert: vi.fn((table: unknown) => insertResult(table)) as unknown as MockDb["insert"],
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })) as unknown as MockDb["update"],
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })) as unknown as MockDb["delete"],
  };
}

function buildPackOutput(): Record<string, unknown> {
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
    carouselAds: [
      {
        title: "Carousel",
        platform: "Instagram",
        hook: "Stop losing staff to slow manual payouts",
        slides: [{ slideNumber: 1, headline: "H", visualDirection: "V", bodyText: "B", cta: null }],
        overallCta: "Learn More",
        visualStyle: "Clean",
        targetPersona: "Owner",
        funnelStage: "awareness",
        benefitSequence: "B",
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
    emailCampaign: {
      subjectLine: "Subject",
      preheader: "Preheader",
      body: "Body",
      cta: "Learn More",
      tone: "professional",
      segment: "Owners",
    },
    launchSequence: {
      title: "Launch",
      sequenceSteps: [{ stepNumber: 1, channel: "email", timing: "Day 1", message: "Hi", cta: "Learn More" }],
    },
    platformAdaptations: [
      {
        platform: "Instagram",
        adaptedCaption: "Caption",
        adaptedCta: "Learn More",
        adaptedHashtags: ["#fintech"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
    ],
    hashtagSet: { core: ["#fintech"], trending: [], niche: [], platformSpecific: [] },
    hooks: [{ text: "Hook 1", angle: null }],
    ctaVariations: [{ text: "Learn More", angle: null }],
    packSummary: "Pack summary",
  };
}

function buildAssetsOutput(): Record<string, unknown> {
  return {
    assets: [
      { assetType: "image", title: "Hero 1", content: "Prompt 1", prompt: null, platform: null, variations: null },
    ],
  };
}

function mockRunAgentResponse(opts: { prompt: string }, runId: number): { runId: number; output: Record<string, unknown> } {
  if (opts.prompt.includes("supplementary")) {
    return { runId: runId + 1, output: buildAssetsOutput() };
  }
  if (opts.prompt.includes("APPROVED CAMPAIGN MESSAGE PACK")) {
    return { runId, output: buildPackOutput() };
  }
  if (opts.prompt.toLowerCase().includes("campaign message pack")) {
    return {
      runId,
      output: {
        headline: "Payout platform for small businesses in Randburg",
        subheadline: "Move staff earnings faster and cut manual payout admin.",
        benefitBullets: [
          "Automated tip and commission payouts.",
          "Less admin time for owners.",
          "Staff get paid faster and more reliably.",
        ],
        cta: "Learn More",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Randburg" },
        proofPoints: null,
        platformCaptions: [
          {
            platform: "Instagram",
            caption: "Stop losing staff to slow manual payouts. Zutohub moves earnings faster.",
            cta: "Learn More",
            hashtags: ["#fintech", "#smallbiz"],
          },
          {
            platform: "Facebook",
            caption: "Randburg small businesses: cut payout admin and keep staff happy.",
            cta: "Learn More",
            hashtags: ["#fintech", "#smallbiz"],
          },
        ],
      },
    };
  }
  return { runId, output: buildPackOutput() };
}

describe("runCreativeAgent post-save failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function approvedPack() {
    return {
      headline: "Payout platform for small businesses in Randburg",
      subheadline: "Move staff earnings faster and cut manual payout admin.",
      benefitBullets: [
        "Automated tip and commission payouts.",
        "Less admin time for owners.",
        "Staff get paid faster and more reliably.",
      ],
      cta: "Learn More",
      footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Randburg" },
      proofPoints: [],
      platformCaptions: [
        {
          platform: "Instagram",
          caption: "Stop losing staff to slow manual payouts. Zutohub moves earnings faster.",
          cta: "Learn More",
          hashtags: ["#fintech", "#smallbiz"],
        },
      ],
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
    };
  }

  it("throws a clear TRPCError when content_posts inserts fail", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    const db = createMockDb({ insertShouldFail: true });
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack() as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 91));

    let thrownError: unknown;
    try {
      await runCreativeAgent({ userId: 18, campaignId: 28 });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(TRPCError);
    const trpcError = thrownError as TRPCError;
    expect(trpcError.code).toBe("INTERNAL_SERVER_ERROR");
    expect(trpcError.message).toContain("The Creative Agent ran but no posts were saved");
    expect(trpcError.message).toContain("ER_WARN_DATA_OUT_OF_RANGE");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("returns successfully when at least one content post is saved", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue(approvedPack() as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 92));

    const result = await runCreativeAgent({ userId: 18, campaignId: 28 });

    expect(result.savedPosts).toBe(2);
    expect(deductCredits).toHaveBeenCalledTimes(1);
  });

  it("forces message-pack rebuild on quality failure and does not charge when retry still fails", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack)
      .mockResolvedValueOnce(approvedPack() as any)
      .mockResolvedValueOnce(approvedPack() as any);

    const lowQualityPack = {
      ...buildPackOutput(),
      socialPosts: [
        {
          ...(buildPackOutput().socialPosts as any[])[0],
          hook: "Join the Trading Revolution",
          caption: "Join thousands and unlock your potential with this offer.",
        },
      ],
    };

    const unusableRetryPack = {
      ...buildPackOutput(),
      socialPosts: [],
      videoConcepts: [],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 300, output: lowQualityPack } as any)
      .mockResolvedValueOnce({ runId: 301, output: unusableRetryPack } as any);

    await expect(runCreativeAgent({ userId: 18, campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    expect(ensureApprovedMessagePack).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ensureApprovedMessagePack).mock.calls[1]?.[0]).toMatchObject({
      forceRebuild: true,
    });
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("uses grounded fallback-like message pack copy and charges only after successful save", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);
    vi.mocked(ensureApprovedMessagePack).mockResolvedValue({
      headline: "Simplify Staff, Restaurant and Delivery Payouts",
      subheadline:
        "Zuto Hub helps service-based employers manage tips, commissions and approved payouts with less manual reconciliation.",
      benefitBullets: [
        "Manage staff tips and commissions from one platform.",
        "Streamline restaurant and supplier payouts.",
        "Settle approved delivery orders with less manual administration.",
      ],
      cta: "Learn More",
      footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
      proofPoints: [],
      platformCaptions: [
        {
          platform: "Instagram",
          caption: "Manage staff tips and commissions with less manual reconciliation.",
          cta: "Learn More",
          hashtags: ["#payouts", "#fintech"],
        },
      ],
      validation: { passed: true, score: 96, rejections: [], warnings: [] },
      messagePackSource: "fallback_deterministic",
    } as any);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 302));

    const result = await runCreativeAgent({ userId: 18, campaignId: 30 });

    expect(result.savedPosts).toBe(2);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deductCredits).mock.calls[0]?.[0]).toMatchObject({
      type: "agent_deduction",
    });
  });

  it("accepts validated deterministic fallback, regenerates creative output, saves posts, and charges once", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack, saveApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);

    vi.mocked(ensureApprovedMessagePack)
      .mockResolvedValueOnce(approvedPack() as any)
      .mockResolvedValueOnce({
        ...approvedPack(),
        messagePackSource: "fallback_deterministic",
        validation: { passed: true, score: 100, rejections: [], warnings: [] },
      } as any);

    const lowQualityPack = {
      ...buildPackOutput(),
      socialPosts: [
        {
          ...(buildPackOutput().socialPosts as any[])[0],
          hook: "Join the Trading Revolution",
          caption: "Join thousands and unlock your potential with this offer.",
        },
      ],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 410, output: lowQualityPack } as any)
      .mockResolvedValueOnce({ runId: 411, output: buildPackOutput() } as any);

    const result = await runCreativeAgent({ userId: 18, campaignId: 30 });

    expect(result.packRunId).toBe(411);
    expect(result.savedPosts).toBe(2);
    expect(saveApprovedMessagePack).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
  });

  it("does not charge when creative regeneration from validated fallback still fails", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack, saveApprovedMessagePack } = await import("../../creative/campaign-message-architect");
    const { deductCredits } = await import("../../billing/credit-engine");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);

    vi.mocked(ensureApprovedMessagePack)
      .mockResolvedValueOnce(approvedPack() as any)
      .mockResolvedValueOnce({
        ...approvedPack(),
        messagePackSource: "fallback_deterministic",
        validation: { passed: true, score: 100, rejections: [], warnings: [] },
      } as any);

    const lowQualityPack = {
      ...buildPackOutput(),
      socialPosts: [
        {
          ...(buildPackOutput().socialPosts as any[])[0],
          hook: "Join the Trading Revolution",
          caption: "Join thousands and unlock your potential with this offer.",
        },
      ],
    };

    const unusableRetryPack = {
      ...buildPackOutput(),
      socialPosts: [],
      videoConcepts: [],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 510, output: lowQualityPack } as any)
      .mockResolvedValueOnce({ runId: 511, output: unusableRetryPack } as any);

    await expect(runCreativeAgent({ userId: 18, campaignId: 30 })).rejects.toBeInstanceOf(TRPCError);

    expect(saveApprovedMessagePack).toHaveBeenCalledTimes(1);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("preserves approved recovery headline, subheadline, benefits and CTA when retry output is generic", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");
    const { ensureApprovedMessagePack } = await import("../../creative/campaign-message-architect");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);

    const groundedRecoveryPack = {
      ...approvedPack(),
      headline: "Zuto Hub payout platform for frontline teams",
      subheadline: "Automate tips and commissions without manual reconciliation.",
      benefitBullets: [
        "Manage mass disbursements in one dashboard.",
        "Reduce payout reconciliation admin work.",
        "Speed up approved settlements for teams.",
      ],
      cta: "Learn More",
      messagePackSource: "fallback_deterministic",
      validation: { passed: true, score: 90, rejections: [], warnings: [] },
    } as any;

    vi.mocked(ensureApprovedMessagePack).mockReset();
    vi.mocked(runAgent).mockReset();

    vi.mocked(ensureApprovedMessagePack)
      .mockResolvedValueOnce(approvedPack() as any)
      .mockResolvedValueOnce(groundedRecoveryPack);

    const lowQualityPack = {
      ...buildPackOutput(),
      socialPosts: [
        {
          ...(buildPackOutput().socialPosts as any[])[0],
          hook: "Join the Trading Revolution",
          caption: "Join thousands and unlock your potential.",
          cta: "Act now",
        },
      ],
    };

    vi.mocked(runAgent)
      .mockResolvedValueOnce({ runId: 610, output: lowQualityPack } as any)
      .mockResolvedValueOnce({ runId: 611, output: lowQualityPack } as any);

    const result = await runCreativeAgent({ userId: 18, campaignId: 30 });

    expect(result.pack.socialPosts[0].hook).toBe(groundedRecoveryPack.headline);
    expect(result.pack.socialPosts[0].cta).toBe(groundedRecoveryPack.cta);
    expect(result.pack.socialPosts[0].caption).toContain(groundedRecoveryPack.subheadline);
    expect(result.pack.socialPosts[0].caption).toContain(groundedRecoveryPack.benefitBullets[0]);
  });
});
