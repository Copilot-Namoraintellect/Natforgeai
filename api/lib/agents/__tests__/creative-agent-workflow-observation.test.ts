import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";
import * as observerModule from "../../creative/contracts/observe-quality-authority";

vi.mock("../runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

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

import { runAgent } from "../runner";
import { getDb } from "../../../queries/connection";
import { runCreativeAgent } from "../creative-agent";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb() {
  const campaign = {
    id: 30,
    userId: 22,
    businessId: 26,
    name: "Zuto Hub Campaign",
    goal: "consideration",
    workflowState: "creatives_generating",
    workflowContext: {
      coreMessage: "B2B payment orchestration",
      strategyApprovalLineage: {
        strategyRunId: 253,
        approvalRequestId: 36,
        approvedAt: "2026-07-01T08:00:00.000Z",
        status: "approved",
        creativeBriefFingerprint: "fp-253",
      },
      approvedStrategyFingerprint: "fp-253",
    },
    personas: [{ name: "Operations Manager" }],
    platforms: "Instagram, Facebook",
    targetAudience: "B2B finance teams",
    ctaStrategy: "Awareness: Learn More\nConsideration: Request a Consultation\nConversion: Request a Walkthrough",
    targetBuyer: "B2B finance teams and merchant operators",
    mainPainPoint: "manual reconciliation",
    productOrService: "B2B payment orchestration",
    offerDetails: "Book a guided walkthrough",
    preferredCta: "Awareness: Learn More\nConsideration: Request a Consultation\nConversion: Request a Walkthrough",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "professional",
  };

  const business = {
    id: 26,
    userId: 22,
    name: "Zuto Hub",
    industry: "Fintech",
    location: "South Africa",
    productOrService: "B2B payment orchestration",
    targetCustomer: "B2B finance teams",
    websiteEvidence: {
      businessCategory: "fintech",
      productsServices: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
        "transaction reservations",
        "controlled payment-instruction services",
      ],
      targetCustomers: ["B2B finance teams"],
    },
  };

  let insertIdCounter = 100;

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const tableName = getTableName(table);
        if (tableName === "campaigns") {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => [campaign]),
            })),
          };
        }
        if (tableName === "businesses") {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => [business]),
            })),
          };
        }
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
            then: vi.fn((resolve: (value: unknown[]) => void) => resolve([])),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => {
        insertIdCounter += 1;
        return [{ insertId: insertIdCounter }];
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  };
}

function buildMessagePackOutput() {
  return {
    headline: "B2B payment orchestration made simple",
    subheadline:
      "Zuto Hub helps B2B finance teams manage prefunded merchant accounts, verify balances and control payment instructions.",
    benefitBullets: [
      "Verify prefunded balances before issuing payment instructions",
      "Reserve transaction amounts with traceable administration",
      "Issue controlled payment instructions from a central account",
    ],
    cta: "Request a Consultation",
    footerContact: {
      phone: null,
      whatsapp: null,
      email: null,
      website: null,
      location: "South Africa",
    },
    proofPoints: [],
    platformCaptions: [
      {
        platform: "Instagram",
        caption:
          "Zuto Hub helps B2B finance teams verify prefunded balances and issue controlled payment instructions.",
        cta: "Request a Consultation",
        hashtags: ["#b2b", "#payments"],
      },
      {
        platform: "Facebook",
        caption:
          "Manage prefunded merchant accounts and transaction reservations with Zuto Hub.",
        cta: "Request a Consultation",
        hashtags: ["#b2b", "#payments"],
      },
    ],
  };
}

function buildCreativePackOutput() {
  return {
    videoConcepts: [
      {
        title: "Master Video",
        platform: "Instagram",
        duration: "30s",
        hook: "Stop manual payment reconciliation",
        openingHook3Sec: "Open",
        scenes: [{ sceneNumber: 1, durationSeconds: 5, visualDescription: "Scene 1" }],
        backgroundMusicMood: "Upbeat",
        cta: "Request a Consultation",
        visualStyle: "Clean",
        targetPersona: "Operations Manager",
        funnelStage: "consideration",
        voiceoverScript: null,
        thumbnailPrompt: null,
      },
    ],
    carouselAds: [
      {
        title: "Carousel",
        platform: "Instagram",
        hook: "Stop manual payment reconciliation",
        slides: [{ slideNumber: 1, headline: "H", visualDirection: "V", bodyText: "B", cta: null }],
        overallCta: "Request a Consultation",
        visualStyle: "Clean",
        targetPersona: "Operations Manager",
        funnelStage: "consideration",
        benefitSequence: "B",
      },
    ],
    socialPosts: [
      {
        platform: "Instagram",
        type: "social_post",
        title: "Master Post",
        hook: "Stop manual payment reconciliation",
        caption:
          "Zuto Hub gives B2B finance teams prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
        cta: "Request a Consultation",
        hashtags: ["#b2b", "#payments"],
        visualPrompt: "A clean visual",
        bestTimeToPost: "9am",
        salesAngle: "Reduce manual reconciliation",
        targetPersona: "Operations Manager",
        funnelStage: "consideration",
        painPoint: "Manual reconciliation",
        transformation: "Controlled payment orchestration",
        urgency: null,
      },
    ],
    adCopyVariations: [],
    whatsAppPromos: [],
    emailCampaign: {
      subjectLine: "Subject",
      preheader: "Preheader",
      body: "Body",
      cta: "Request a Consultation",
      tone: "professional",
      segment: "Operations Managers",
    },
    launchSequence: {
      title: "Launch",
      sequenceSteps: [{ stepNumber: 1, channel: "email", timing: "Day 1", message: "Hi", cta: "Request a Consultation" }],
    },
    platformAdaptations: [
      {
        platform: "Instagram",
        adaptedCaption: "Caption",
        adaptedCta: "Request a Consultation",
        adaptedHashtags: ["#b2b"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
      {
        platform: "Facebook",
        adaptedCaption: "Caption",
        adaptedCta: "Request a Consultation",
        adaptedHashtags: ["#b2b"],
        bestTimeToPost: "9am",
        formatNotes: null,
      },
    ],
    hashtagSet: { core: ["#b2b"], trending: [], niche: [], platformSpecific: [] },
    hooks: [{ text: "Hook 1", angle: null }],
    ctaVariations: [{ text: "Request a Consultation", angle: null }],
    packSummary: "Pack summary",
  };
}

describe("runCreativeAgent workflow observation integration", () => {
  let originalMode: string | undefined;
  let observeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    observeSpy = vi.spyOn(observerModule, "observeIfEnabled");
    vi.clearAllMocks();
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
    observeSpy.mockRestore();
  });

  it("shares one injected registry between message-pack and creative-generation observations", async () => {
    const registry = new InMemoryWorkflowOperationRegistry();

    vi.mocked(runAgent)
      .mockImplementation(async (opts: any) => {
        if (typeof opts.prompt === "string" && opts.prompt.includes("BUSINESS GROUND TRUTH")) {
          return { runId: 200, output: buildMessagePackOutput() };
        }
        return { runId: 201, output: buildCreativePackOutput() };
      });

    const result = await runCreativeAgent({
      userId: 22,
      campaignId: 30,
      generationOperation: { source: "job", id: 12345 },
      registry,
    });

    expect(result.savedPosts).toBeGreaterThan(0);

    // Both observations in this single orchestration scope must have been
    // recorded against the same injected registry and the same workflow operation.
    const snapshot = registry.snapshot();
    expect(snapshot.operations).toHaveLength(1);
    const operation = snapshot.operations[0];
    expect(operation.status).toBe("running");

    const attempts = registry.listAttempts(operation.workflowOperationId);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    const attemptTypes = attempts.map((a) => a.attemptType);
    expect(attemptTypes).toContain("message_pack");
    expect(attemptTypes).toContain("creative_generation");
  });

  it("does not report WORKFLOW_OBSERVATION_SKIPPED_NO_REGISTRY in normal observe-mode production path", async () => {
    const registry = new InMemoryWorkflowOperationRegistry();

    vi.mocked(runAgent)
      .mockImplementation(async (opts: any) => {
        if (typeof opts.prompt === "string" && opts.prompt.includes("BUSINESS GROUND TRUTH")) {
          return { runId: 210, output: buildMessagePackOutput() };
        }
        return { runId: 211, output: buildCreativePackOutput() };
      });

    await runCreativeAgent({
      userId: 22,
      campaignId: 30,
      generationOperation: { source: "job", id: 12346 },
      registry,
    });

    // A registry was injected, so cross-point observation should not have
    // reported the safe no-registry skip code.
    expect(registry.snapshot().operations.length).toBeGreaterThan(0);
    const anySkipped = registry
      .snapshot()
      .attempts.some((a) =>
        a.failureCode?.includes("WORKFLOW_OBSERVATION_SKIPPED_NO_REGISTRY")
      );
    expect(anySkipped).toBe(false);
  });
});
