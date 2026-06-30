import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
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
          ctaStrategy: "Book a demo",
          contentCalendar: null,
          offers: null,
          primaryOutcome: "Leads",
          targetBuyer: "Small business owner",
          mainPainPoint: "Manual payouts",
          productOrService: "Payout platform",
          offerDetails: "",
          preferredCta: "Book a demo",
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
        cta: "Book a demo",
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
        overallCta: "Book",
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
        cta: "Book a demo",
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
      cta: "Book",
      tone: "professional",
      segment: "Owners",
    },
    launchSequence: {
      title: "Launch",
      sequenceSteps: [{ stepNumber: 1, channel: "email", timing: "Day 1", message: "Hi", cta: "Book" }],
    },
    platformAdaptations: [
      {
        platform: "Instagram",
        adaptedCaption: "Caption",
        adaptedCta: "Book",
        adaptedHashtags: ["#fintech"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
    ],
    hashtagSet: { core: ["#fintech"], trending: [], niche: [], platformSpecific: [] },
    hooks: [{ text: "Hook 1", angle: null }],
    ctaVariations: [{ text: "Book now", angle: null }],
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
        cta: "Book a demo",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "Randburg" },
        proofPoints: null,
        platformCaptions: [
          {
            platform: "Instagram",
            caption: "Stop losing staff to slow manual payouts. Zutohub moves earnings faster.",
            cta: "Book a demo",
            hashtags: ["#fintech", "#smallbiz"],
          },
          {
            platform: "Facebook",
            caption: "Randburg small businesses: cut payout admin and keep staff happy.",
            cta: "Book a demo",
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

  it("throws a clear TRPCError when content_posts inserts fail", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: true }) as unknown as ReturnType<typeof getDb>);
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
  });

  it("returns successfully when at least one content post is saved", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../runner");
    const { runCreativeAgent } = await import("../creative-agent");

    vi.mocked(getDb).mockReturnValue(createMockDb({ insertShouldFail: false }) as unknown as ReturnType<typeof getDb>);
    vi.mocked(runAgent).mockImplementation(async (opts) => mockRunAgentResponse(opts, 92));

    const result = await runCreativeAgent({ userId: 18, campaignId: 28 });

    expect(result.savedPosts).toBe(2);
  });
});
