import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
}));

vi.mock("./message-approval/evaluator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-approval/evaluator")>();
  return { ...actual, evaluateMessageCandidate: vi.fn(actual.evaluateMessageCandidate) };
});

vi.mock("./message-approval/canary-proof", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-approval/canary-proof")>();
  return { ...actual, verifyCanaryApprovalProof: vi.fn(actual.verifyCanaryApprovalProof) };
});

// Tripwires: the campaign message architect must never invoke content
// generation orchestration, BullMQ queues, or downstream agents directly.
// These mocks intercept any future wiring at those boundaries.
vi.mock("../jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(),
}));

vi.mock("../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => false),
  getPublishingQueue: vi.fn(),
  getContentGenerationQueue: vi.fn(),
  toSafeBullMqJobId: vi.fn(),
  toContentGenerationBullMqJobId: vi.fn(),
  toPublishingBullMqJobId: vi.fn(),
  schedulePublishingJob: vi.fn(),
  removePublishingJob: vi.fn(),
  scheduleContentGenerationJob: vi.fn(),
  pausePublishingQueue: vi.fn(),
}));

vi.mock("../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(),
}));

vi.mock("./message-approval/shadow-runner", () => ({
  runShadowMessageApproval: vi.fn(() => null),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runAgent } from "../agents/runner";
import { logInfo, logWarn, logError } from "../logger";
import {
  buildApprovedMessagePack,
  ensureApprovedMessagePack,
  refineApprovedMessagePack,
  saveApprovedMessagePack,
  type CampaignMessagePack,
} from "./campaign-message-architect";
import * as architectModule from "./campaign-message-architect";
import { runShadowMessageApproval } from "./message-approval/shadow-runner";
import { verifyCanaryApprovalProof } from "./message-approval/canary-proof";
import { processContentGenerationJob } from "../jobs/content-generation-job";
import {
  getContentGenerationQueue,
  getPublishingQueue,
  scheduleContentGenerationJob,
  schedulePublishingJob,
} from "../queue/bullmq";
import { runCreativeAgent } from "../agents/creative-agent";
import { runDistributionAgent } from "../agents/distribution-agent";
import { campaign30BusinessDna, campaign30Policy, campaign30ReplayCases, campaign30Strategy } from "./message-approval/fixtures/campaign30";
import { createMessagePackCandidate } from "./message-approval/candidate";
import * as candidateModule from "./message-approval/candidate";
import { evaluateMessageCandidate } from "./message-approval/evaluator";
import { createApprovedMessagePack } from "./message-approval/approve";
import { buildV2ApprovalEnvelope } from "./message-approval/compatibility-adapter";
import { buildLegacyShadowContextProjection } from "./message-approval/integration/legacy-shadow-context";
import { DEFAULT_V2_MESSAGE_QUALITY_POLICY } from "./message-approval/policy";
import type { CanaryApprovalProof, MessageApprovalContextLock, ShadowEvaluationResult } from "./message-approval/contracts";

function createMockDb(overrides?: {
  storedPacks?: CampaignMessagePack[];
  storedRowsRaw?: any[];
  insertThrows?: boolean;
  throwOnCampaignAssetsUpdate?: boolean;
  campaignSelectCount?: { count: number };
  businessSelectCount?: { count: number };
  campaignFields?: Record<string, unknown>;
  businessFields?: Record<string, unknown>;
}) {
  const storedRows = (overrides?.storedRowsRaw || (overrides?.storedPacks || []).map((pack, index) => ({
    id: index + 200,
    status: "ready",
    metadata: { approvedMessagePack: pack },
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
  })));

  const tableNameOf = (table: any) =>
    (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
  const insertCalls: Array<{ table: string; values: any }> = [];
  const updateCalls: Array<{ table: string; set: any }> = [];

  const mock = {
    insertCalls,
    updateCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = tableNameOf(table);
              if (tableName === "campaign_assets") return storedRows;
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const tableName = tableNameOf(table);
            if (tableName === "campaigns") {
              if (overrides?.campaignSelectCount) overrides.campaignSelectCount.count += 1;
              return [
                {
                  id: 1,
                  userId: 10,
                  businessId: 20,
                  name: "Zuto Hub Payout Awareness",
                  productOrService: "Payout platform",
                  targetBuyer: "Restaurants, delivery platforms, and frontline teams",
                  mainPainPoint: "manual payout reconciliation",
                  offerDetails: "",
                  excludedOffers: "",
                  preferredCta: "Awareness: Learn More\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
                  platforms: "Instagram, Facebook",
                  location: "South Africa",
                  ...(overrides?.campaignFields || {}),
                },
              ];
            }
            if (tableName === "businesses") {
              if (overrides?.businessSelectCount) overrides.businessSelectCount.count += 1;
              return [
                {
                  id: 20,
                  userId: 10,
                  name: "Zuto Hub",
                  industry: "Financial Operations",
                  location: "South Africa",
                  websiteEvidence: {
                    businessCategory: "fintech payouts",
                    productsServices: [
                      "payout platform",
                      "mass disbursements",
                      "tips and commissions payouts",
                      "supplier payouts",
                    ],
                    targetCustomers: ["restaurants", "delivery platforms", "frontline teams"],
                  },
                  ...(overrides?.businessFields || {}),
                },
              ];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({ values: vi.fn(async (values: any) => {
      insertCalls.push({ table: tableNameOf(table), values });
      if (overrides?.insertThrows) throw new Error("insert failed");
      return [{ insertId: 1 }];
    }) })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async () => {
          const tableName = tableNameOf(table);
          updateCalls.push({ table: tableName, set });
          if (overrides?.throwOnCampaignAssetsUpdate && tableName === "campaign_assets") {
            throw new Error("supersede update failed");
          }
          return [];
        }),
      })),
    })),
  };

  return mock;
}

const basePack: CampaignMessagePack = {
  headline: "Reduce payout delays for restaurants and delivery platforms",
  subheadline: "Zuto Hub payout platform helps frontline teams avoid manual payout reconciliation.",
  benefitBullets: [
    "Mass disbursements settle staff payouts faster for frontline teams.",
    "Tips and commissions payouts reduce manual payout reconciliation effort.",
    "Supplier payouts stay traceable for restaurants and delivery platforms.",
  ],
  cta: "Learn More",
  footerContact: { location: "South Africa" },
  proofPoints: ["Mass disbursements and supplier payouts in one payout platform."],
  platformCaptions: [
    {
      platform: "Instagram",
      caption:
        "Restaurants and delivery platforms can reduce delayed staff payouts with Zuto Hub payout platform workflows.",
      cta: "Learn More",
      hashtags: ["#payoutplatform", "#restaurantops"],
    },
  ],
  validation: { passed: true, score: 100, rejections: [], warnings: [] },
};

describe("campaign-message-architect canary wrappers", () => {
  const getAllLogPayloads = () => [
    ...vi.mocked(logInfo).mock.calls,
    ...vi.mocked(logWarn).mock.calls,
    ...vi.mocked(logError).mock.calls,
  ].map((call) => call[1]);

  const assertNoSensitiveLogFields = (serializedLogs: string) => {
    expect(serializedLogs).not.toContain("userId");
    expect(serializedLogs).not.toContain("groundedFactsUsed");
    expect(serializedLogs).not.toContain("refinementInstruction");
    expect(serializedLogs).not.toContain("rejections");
    expect(serializedLogs).not.toContain("warnings");
    expect(serializedLogs).not.toContain("Transform your business");
    expect(serializedLogs).not.toContain("manual payout reconciliation");
    expect(serializedLogs).not.toContain("SENSITIVE_EXCEPTION_TEXT");
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CREATIVE_PIPELINE_V2_MODE;
    delete process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED;
    delete process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS;
    delete process.env.CREATIVE_PIPELINE_V2_CANARY_SALT;
    delete process.env.CREATIVE_PIPELINE_V2_CANARY_PERCENT;
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 123,
      output: {
        headline: "Cut delayed staff payouts with Zuto Hub payout platform",
        subheadline: "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.",
        benefitBullets: [
          "Mass disbursements improve payout speed for frontline teams.",
          "Tips and commissions payouts reduce reconciliation bottlenecks.",
          "Supplier payouts remain consistent across restaurant locations.",
        ],
        cta: "Learn More",
        footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
        proofPoints: ["Payout platform supports mass disbursements and supplier payouts."],
        platformCaptions: [
          {
            platform: "Instagram",
            caption:
              "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.",
            cta: "Learn More",
            hashtags: ["#payoutplatform", "#frontlineteams"],
          },
        ],
      },
    } as any);
    vi.mocked(runShadowMessageApproval).mockReturnValue(null);
  });

  it("shared canary fixture is V2-approved with zero hard issues and threshold score", () => {
    const projection = buildLegacyShadowContextProjection({
      campaignId: 1,
      business: {
        id: 20,
        name: "Zuto Hub",
        industry: "Financial Operations",
        websiteEvidence: {
          businessCategory: "fintech payouts",
          productsServices: [
            "payout platform",
            "mass disbursements",
            "tips and commissions payouts",
            "supplier payouts",
          ],
          targetCustomers: ["restaurants", "delivery platforms", "frontline teams"],
        },
      },
      campaign: {
        id: 1,
        businessId: 20,
        name: "Zuto Hub Payout Awareness",
        productOrService: "Payout platform",
        targetBuyer: "Restaurants, delivery platforms, and frontline teams",
        mainPainPoint: "manual payout reconciliation",
        preferredCta: "Awareness: Learn More\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
      },
      validationContext: {
        businessName: "Zuto Hub",
        industry: "Financial Operations",
        productOrService: "Payout platform",
        targetCustomer: "Restaurants, delivery platforms, and frontline teams",
        mainPainPoint: "manual payout reconciliation",
        preferredCta: "Awareness: Learn More\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
      },
    });

    const candidate = createMessagePackCandidate({
      candidateId: "fixture-approved-candidate",
      campaignId: 1,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: {
        copySchemaVersion: "v2.1",
        headline: "Reduce payout delays for restaurants and delivery platforms",
        subheadline:
          "Zuto Hub payout platform helps frontline teams avoid manual payout reconciliation and delayed staff payouts.",
        benefitBulletsOrdered: [
          "Mass disbursements settle staff payouts faster for frontline teams.",
          "Tips and commissions payouts reduce manual payout reconciliation effort.",
          "Supplier payouts stay traceable for restaurants and delivery platforms.",
        ],
        cta: "Learn More",
        footer: {
          phone: null,
          whatsapp: null,
          email: null,
          website: null,
          location: "South Africa",
        },
        proofPointsOrdered: ["Mass disbursements and supplier payouts in one payout platform."],
        platformCaptionsOrdered: [
          {
            platform: "Instagram",
            caption:
              "Restaurants and delivery platforms can reduce delayed staff payouts with Zuto Hub payout platform workflows.",
            cta: "Learn More",
            hashtagsOrdered: ["#payoutplatform", "#restaurantops"],
          },
        ],
      },
      businessDnaSnapshotId: projection.businessDna.snapshotId,
      evidenceHashSha256: projection.businessDna.evidenceHashSha256,
      campaignStrategySnapshotId: projection.campaignStrategy.snapshotId,
      strategyHashSha256: projection.campaignStrategy.strategyHashSha256,
      qualityPolicyId: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyId,
      qualityPolicyVersion: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyVersion,
      policyHashSha256: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyHashSha256,
      provenance: {
        adaptedFromLegacy: false,
        originSource: "ai_refined_pack",
        modelName: null,
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    const assessment = evaluateMessageCandidate({
      assessmentId: "fixture-approved-assessment",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate,
      businessDna: projection.businessDna,
      campaignStrategy: projection.campaignStrategy,
      policy: DEFAULT_V2_MESSAGE_QUALITY_POLICY,
    });

    expect(assessment.decision).toBe("approved");
    expect(assessment.hardIssues).toHaveLength(0);
    expect(assessment.score).toBeGreaterThanOrEqual(DEFAULT_V2_MESSAGE_QUALITY_POLICY.minScoreForApproval);
  });

  it("direct refine selected-canary succeeds with ai_refined envelope and preserves exact refined copy", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const candidateSpy = vi.spyOn(candidateModule, "createMessagePackCandidate");

    const storedPack: CampaignMessagePack = {
      ...basePack,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "latest_message_pack",
      isGeneric: false,
    };
    vi.mocked(getDb).mockReturnValue(createMockDb({ storedPacks: [storedPack] }) as any);

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Make the copy more urgent",
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    const prompt = (runAgent as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain(basePack.headline);
    expect(prompt).toContain("Make the copy more urgent");

    expect(refined.v2ApprovalEnvelope).toBeDefined();
    expect(refined.v2ApprovalEnvelope?.candidateSource).toBe("ai_refined");
    expect(refined.v2ApprovalEnvelope?.candidateSource).not.toBe("ai_initial");
    expect(refined.v2ApprovalEnvelope?.contextLockId).toBeTruthy();
    expect(refined.v2ApprovalEnvelope?.candidateId).toBeTruthy();
    expect(refined.v2ApprovalEnvelope?.assessmentId).toBeTruthy();
    expect(refined.v2ApprovalEnvelope?.assessmentHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refined.v2ApprovalEnvelope?.copyHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refined.v2ApprovalEnvelope?.decision).toBe("approved");
    expect(
      candidateSpy.mock.calls.some((call) => call[0]?.source === "ai_initial")
    ).toBe(false);
    expect(refined.headline).toBe("Cut delayed staff payouts with Zuto Hub payout platform");
    expect(refined.cta).toBe("Learn More");
    expect(Array.isArray(refined.benefitBullets)).toBe(true);
    candidateSpy.mockRestore();
  });

  it("selected-canary build uses safe logs without sensitive fields or raw exception text", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    vi.mocked(runAgent).mockRejectedValue(new Error("SENSITIVE_EXCEPTION_TEXT"));

    await expect(
      buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 })
    ).rejects.toThrow(/rejected all candidates/);

    const serializedLogs = JSON.stringify(getAllLogPayloads());
    assertNoSensitiveLogFields(serializedLogs);

    expect(serializedLogs).toContain("CREATIVE_GENERATION_FAILED");
    expect(serializedLogs).toContain("legacy_build_run_agent");
  });

  it("selected-canary direct refine uses safe logs without refinement instruction or raw rejection strings", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    vi.mocked(runAgent)
      .mockResolvedValueOnce({
        runId: 124,
        output: {
          headline: "Transform your business today",
          subheadline: "Unlock success for your business.",
          benefitBullets: ["Great outcomes", "Best support", "Amazing growth"],
          cta: "Learn More",
          footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
          proofPoints: [],
          platformCaptions: [],
        },
      } as any)
      .mockResolvedValueOnce({
        runId: 125,
        output: {
          headline: "Cut delayed staff payouts with Zuto Hub payout platform",
          subheadline: "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.",
          benefitBullets: [
            "Mass disbursements improve payout speed for frontline teams.",
            "Tips and commissions payouts reduce reconciliation bottlenecks.",
            "Supplier payouts remain consistent across restaurant locations.",
          ],
          cta: "Learn More",
          footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
          proofPoints: ["Payout platform supports mass disbursements and supplier payouts."],
          platformCaptions: [
            {
              platform: "Instagram",
              caption: "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.",
              cta: "Learn More",
              hashtags: ["#payoutplatform", "#frontlineteams"],
            },
          ],
        },
      } as any);

    await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Please tighten copy and keep urgency",
      skipBilling: true,
      maxAttempts: 1,
    });

    const serializedLogs = JSON.stringify(getAllLogPayloads());
    assertNoSensitiveLogFields(serializedLogs);
    expect(serializedLogs).toContain("legacy_refine_validation");
    expect(serializedLogs).not.toContain("Please tighten copy and keep urgency");
  });

  it("keeps legacy direct refine path when canary is not selected", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "999";

    const refined = await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Make the copy more urgent",
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(refined.v2ApprovalEnvelope).toBeUndefined();
  });

  it("off, non-selected canary, active, and unknown modes do not run shadow observer", async () => {
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";

    process.env.CREATIVE_PIPELINE_V2_MODE = "off";
    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "999";
    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

    process.env.CREATIVE_PIPELINE_V2_MODE = "active";
    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

    process.env.CREATIVE_PIPELINE_V2_MODE = "unknown_mode";
    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

    expect(runShadowMessageApproval).not.toHaveBeenCalled();
  });

  it("shadow mode runs exactly one shadow observation per top-level call", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";

    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });
    expect(runShadowMessageApproval).toHaveBeenCalledTimes(1);
  });

  it("selected canary loads business context once per top-level direct refine flow", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const businessCount = { count: 0 };
    vi.mocked(getDb).mockReturnValue(createMockDb({ businessSelectCount: businessCount }) as any);

    await refineApprovedMessagePack({
      userId: 10,
      campaignId: 1,
      existingPack: basePack,
      refinementInstruction: "Make the copy more urgent",
      skipBilling: true,
      maxAttempts: 1,
    });

    expect(businessCount.count).toBe(1);
  });

  it("request-scoped evaluation registry does not leak across top-level operations", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const nowSpy = vi.spyOn(Date, "now");
    let tick = 1000;
    nowSpy.mockImplementation(() => {
      tick += 1;
      return tick;
    });

    const duplicateStored: CampaignMessagePack = {
      ...basePack,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "ai_refined_pack",
    };

    vi.mocked(getDb).mockReturnValue(createMockDb({ storedRowsRaw: [
      {
        id: 500,
        status: "ready",
        metadata: { approvedMessagePack: duplicateStored },
        createdAt: new Date("2026-07-01T08:00:00.000Z"),
      },
      {
        id: 501,
        status: "ready",
        metadata: { approvedMessagePack: duplicateStored },
        createdAt: new Date("2026-07-01T08:00:00.000Z"),
      },
    ] }) as any);

    const first = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });
    const second = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

    expect(first.v2ApprovalEnvelope?.assessmentId).toBeTruthy();
    expect(second.v2ApprovalEnvelope?.assessmentId).toBeTruthy();
    expect(first.v2ApprovalEnvelope?.assessmentId).not.toBe(second.v2ApprovalEnvelope?.assessmentId);
    nowSpy.mockRestore();
  });

  it("persisted stored envelope never bypasses current-request reassessment", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const staleStored: CampaignMessagePack = {
      ...basePack,
      headline: "Transform your business today",
      subheadline: "Unlock success for your business.",
      benefitBullets: ["Great outcomes", "Best support", "Amazing growth"],
      isGeneric: false,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      v2ApprovalEnvelope: {
        schemaVersion: "v2.1",
        approvalMode: "canary",
        contextLockId: "stale",
        approvedRevisionId: "rev-stale",
        candidateId: "cand-stale",
        assessmentId: "assess-stale",
        assessmentHashSha256: "stale",
        copyHashSha256: "stale",
        copySchemaVersion: "v2.1",
        businessDnaSnapshotId: "stale",
        evidenceHashSha256: "stale",
        campaignStrategySnapshotId: "stale",
        strategyHashSha256: "stale",
        policyId: "stale",
        policyVersion: 1,
        policyHashSha256: "stale",
        approvedAtIso: "2026-07-01T08:00:00.000Z",
        candidateSource: "existing_approved",
        sourceProvenance: {
          adaptedFromLegacy: true,
          originSource: "latest_message_pack",
          modelName: null,
          diagnostics: {
            legacyIsGeneric: null,
            legacyValidationPassed: null,
            legacyValidationScore: null,
            legacyValidationRejections: [],
          },
        },
        decision: "approved",
        score: 100,
        hardIssueCodes: [],
        warningCodes: [],
      },
    };

    vi.mocked(getDb).mockReturnValue(createMockDb({ storedPacks: [staleStored] }) as any);

    await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("skips malformed stored row while still assessing valid stored row", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const validStored: CampaignMessagePack = {
      ...basePack,
      proofPoints: ["Local coverage"],
      isGeneric: false,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "ai_refined_pack",
    };

    const rows = [
      {
        id: 400,
        status: "ready",
        metadata: { approvedMessagePack: { bad: "shape" } },
        createdAt: new Date("2026-07-01T08:00:00.000Z"),
      },
      {
        id: 401,
        status: "ready",
        metadata: { approvedMessagePack: validStored },
        createdAt: new Date("2026-07-01T08:00:00.000Z"),
      },
    ];

    vi.mocked(getDb).mockReturnValue(createMockDb({ storedRowsRaw: rows }) as any);

    const pack = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });
    expect(pack.headline).toBe(validStored.headline);
    expect(pack.v2ApprovalEnvelope?.candidateSource).toBe("existing_approved");
  });

  it("canary save fails with envelope-only payload and without proof", async () => {
    const invalid = {
      ...basePack,
      v2ApprovalEnvelope: {
        schemaVersion: "v2.1",
      } as any,
    } as CampaignMessagePack;

    await expect(saveApprovedMessagePack(10, 1, invalid, { mode: "canary" as const })).rejects.toThrow(
      /Canary save requires approval proof and envelope/
    );
  });

  it("canary save fails when proof is missing candidate, assessment, or context lock", async () => {
    const approvedReplay = campaign30ReplayCases.find((item) => item.caseId === "C");
    if (!approvedReplay) throw new Error("Missing approved replay fixture");

    const lock: MessageApprovalContextLock = {
      contextLockId: "ctx-1",
      mode: "canary",
      campaignId: 1,
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

    const candidate = createMessagePackCandidate({
      candidateId: "cand-1",
      campaignId: 1,
      createdAtIso: "2026-07-01T08:00:00.000Z",
      source: "ai_refined",
      copy: {
        copySchemaVersion: "v2.1",
        headline: approvedReplay.copy.headline,
        subheadline: approvedReplay.copy.subheadline,
        benefitBulletsOrdered: [...approvedReplay.copy.benefitBullets],
        cta: approvedReplay.copy.cta,
        footer: {
          phone: approvedReplay.copy.footerContact.phone,
          whatsapp: approvedReplay.copy.footerContact.whatsapp,
          email: approvedReplay.copy.footerContact.email,
          website: approvedReplay.copy.footerContact.website,
          location: approvedReplay.copy.footerContact.location,
        },
        proofPointsOrdered: [],
        platformCaptionsOrdered: [
          {
            platform: "Instagram",
            caption: "Operations managers can reduce payout delays with payout automation.",
            cta: "Learn More",
            hashtagsOrdered: ["#payoutautomation"],
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
        adaptedFromLegacy: false,
        originSource: "ai_refined_pack",
        modelName: null,
        diagnostics: {
          legacyIsGeneric: null,
          legacyValidationPassed: null,
          legacyValidationScore: null,
          legacyValidationRejections: [],
        },
      },
    });

    const assessment = evaluateMessageCandidate({
      assessmentId: "assess-1",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });
    expect(assessment.decision).toBe("approved");
    expect(assessment.hardIssues).toHaveLength(0);
    expect(assessment.score).toBeGreaterThanOrEqual(campaign30Policy.minScoreForApproval);

    const approved = createApprovedMessagePack({
      approvedRevisionId: "rev-1",
      approvedAtIso: "2026-07-01T08:02:00.000Z",
      candidate,
      assessment,
      policy: campaign30Policy,
    });
    const envelope = buildV2ApprovalEnvelope({
      contextLock: lock,
      approved,
      candidateSource: "ai_refined",
      assessment,
    });
    const pack: CampaignMessagePack = {
      headline: candidate.copy.headline,
      subheadline: candidate.copy.subheadline,
      benefitBullets: [...candidate.copy.benefitBulletsOrdered],
      cta: candidate.copy.cta,
      footerContact: {
        phone: candidate.copy.footer?.phone ?? undefined,
        whatsapp: candidate.copy.footer?.whatsapp ?? undefined,
        email: candidate.copy.footer?.email ?? undefined,
        website: candidate.copy.footer?.website ?? undefined,
        location: candidate.copy.footer?.location ?? undefined,
      },
      proofPoints: [...candidate.copy.proofPointsOrdered],
      platformCaptions: candidate.copy.platformCaptionsOrdered.map((caption) => ({
        platform: caption.platform,
        caption: caption.caption,
        cta: caption.cta,
        hashtags: [...caption.hashtagsOrdered],
      })),
      messagePackSource: "ai_refined_pack",
      validation: { passed: true, score: assessment.score, rejections: [], warnings: [] },
      v2ApprovalEnvelope: envelope,
    };

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          contextLock: lock,
          candidate,
          assessment,
          envelope,
        } as any,
      })
    ).rejects.toThrow(/incomplete/);

    const validProof: CanaryApprovalProof = {
      contextLock: lock,
      candidate,
      assessment,
      approvedMessagePack: approved,
      envelope,
    };

    const validateSpy = vi.spyOn(architectModule, "validateCampaignCopy");
    await saveApprovedMessagePack(10, 1, pack, { mode: "canary", proof: validProof });
    expect(validateSpy).not.toHaveBeenCalled();
    validateSpy.mockRestore();

    const tamperedScoreAssessment = {
      ...assessment,
      score: assessment.score - 1,
    };

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          assessment: tamperedScoreAssessment as any,
          envelope: {
            ...validProof.envelope,
            assessmentHashSha256: assessment.assessmentHashSha256,
          },
        },
      })
    ).rejects.toThrow(/assessment hash mismatch/);

    const tamperedWarningAssessment = {
      ...assessment,
      warnings: [...assessment.warnings, { code: "WARN_TAMPERED", message: "Tampered warning" }],
    };

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          assessment: tamperedWarningAssessment as any,
          envelope: {
            ...validProof.envelope,
            assessmentHashSha256: assessment.assessmentHashSha256,
          },
        },
      })
    ).rejects.toThrow(/assessment hash mismatch/);

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          envelope: {
            ...validProof.envelope,
            assessmentHashSha256: "0".repeat(64),
          },
        },
      })
    ).rejects.toThrow(/assessment hash mismatch/);

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          contextLock: undefined as any,
        },
      })
    ).rejects.toThrow(/incomplete/);

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          candidate: undefined as any,
        },
      })
    ).rejects.toThrow(/incomplete/);

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...validProof,
          assessment: undefined as any,
        },
      })
    ).rejects.toThrow(/incomplete/);

    const mutatedPack = {
      ...pack,
      platformCaptions: [
        {
          ...pack.platformCaptions[0],
          caption: `${pack.platformCaptions[0].caption} MUTATED`,
        },
      ],
    };

    await expect(
      saveApprovedMessagePack(10, 1, mutatedPack, {
        mode: "canary",
        proof: validProof,
      })
    ).rejects.toThrow(/semantic mismatch|copy hash mismatch/);

    const mutatedHeadline = {
      ...pack,
      headline: `${pack.headline} MUTATED`,
    };

    await expect(
      saveApprovedMessagePack(10, 1, mutatedHeadline, {
        mode: "canary",
        proof: validProof,
      })
    ).rejects.toThrow(/semantic mismatch|copy hash mismatch/);

    const mutatedProofPoints = {
      ...pack,
      proofPoints: ["Changed proof point"],
    };

    await expect(
      saveApprovedMessagePack(10, 1, mutatedProofPoints, {
        mode: "canary",
        proof: validProof,
      })
    ).rejects.toThrow(/semantic mismatch|copy hash mismatch/);
  });

  function createValidCanarySaveBaseline(): {
    assessment: ReturnType<typeof evaluateMessageCandidate>;
    envelope: ReturnType<typeof buildV2ApprovalEnvelope>;
    proof: CanaryApprovalProof;
    pack: CampaignMessagePack;
  } {
    const lock: MessageApprovalContextLock = {
      contextLockId: "ctx-1",
      mode: "canary",
      campaignId: 1,
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

    let selected:
      | {
          candidate: ReturnType<typeof createMessagePackCandidate>;
          assessment: ReturnType<typeof evaluateMessageCandidate>;
        }
      | undefined;

    for (const replay of campaign30ReplayCases.filter((item) => item.expectedDecision === "approved")) {
      const candidate = createMessagePackCandidate({
        candidateId: `cand-${replay.caseId}`,
        campaignId: 1,
        createdAtIso: "2026-07-01T08:00:00.000Z",
        source: "ai_refined",
        copy: {
          copySchemaVersion: "v2.1",
          headline: replay.copy.headline,
          subheadline: replay.copy.subheadline,
          benefitBulletsOrdered: [...replay.copy.benefitBullets],
          cta: replay.copy.cta,
          footer: {
            phone: replay.copy.footerContact.phone,
            whatsapp: replay.copy.footerContact.whatsapp,
            email: replay.copy.footerContact.email,
            website: replay.copy.footerContact.website,
            location: replay.copy.footerContact.location,
          },
          proofPointsOrdered: [],
          platformCaptionsOrdered: [
            {
              platform: "Instagram",
              caption: "Operations managers can reduce payout delays with payout automation.",
              cta: "Learn More",
              hashtagsOrdered: ["#payoutautomation"],
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
          adaptedFromLegacy: false,
          originSource: replay.source,
          modelName: null,
          diagnostics: {
            legacyIsGeneric: replay.legacyIsGeneric,
            legacyValidationPassed: replay.legacyValidationPassed,
            legacyValidationScore: replay.legacyValidationScore,
            legacyValidationRejections: [...replay.legacyValidationRejections],
          },
        },
      });

      const assessment = evaluateMessageCandidate({
        assessmentId: `assess-${replay.caseId}`,
        evaluatedAtIso: "2026-07-01T08:01:00.000Z",
        candidate,
        businessDna: campaign30BusinessDna,
        campaignStrategy: campaign30Strategy,
        policy: campaign30Policy,
      });

      if (
        assessment.decision === "approved" &&
        assessment.hardIssues.length === 0 &&
        assessment.score >= campaign30Policy.minScoreForApproval &&
        assessment.warnings.length > 0
      ) {
        selected = { candidate, assessment };
        break;
      }
    }

    if (!selected) {
      throw new Error("Missing approved replay fixture that yields an assessment warning for tamper isolation tests.");
    }

    const { candidate, assessment } = selected;

    const approved = createApprovedMessagePack({
      approvedRevisionId: "rev-1",
      approvedAtIso: "2026-07-01T08:02:00.000Z",
      candidate,
      assessment,
      policy: campaign30Policy,
    });

    const envelope = buildV2ApprovalEnvelope({
      contextLock: lock,
      approved,
      candidateSource: "ai_refined",
      assessment,
    });

    const pack: CampaignMessagePack = {
      headline: candidate.copy.headline,
      subheadline: candidate.copy.subheadline,
      benefitBullets: [...candidate.copy.benefitBulletsOrdered],
      cta: candidate.copy.cta,
      footerContact: {
        phone: candidate.copy.footer?.phone ?? undefined,
        whatsapp: candidate.copy.footer?.whatsapp ?? undefined,
        email: candidate.copy.footer?.email ?? undefined,
        website: candidate.copy.footer?.website ?? undefined,
        location: candidate.copy.footer?.location ?? undefined,
      },
      proofPoints: [...candidate.copy.proofPointsOrdered],
      platformCaptions: candidate.copy.platformCaptionsOrdered.map((caption) => ({
        platform: caption.platform,
        caption: caption.caption,
        cta: caption.cta,
        hashtags: [...caption.hashtagsOrdered],
      })),
      messagePackSource: "ai_refined_pack",
      validation: { passed: true, score: assessment.score, rejections: [], warnings: [] },
      v2ApprovalEnvelope: envelope,
    };

    const proof: CanaryApprovalProof = {
      contextLock: lock,
      candidate,
      assessment,
      approvedMessagePack: approved,
      envelope,
    };

    return { assessment, envelope, proof, pack };
  }

  it("canary save rejects warning-code tampering when stored assessment hashes remain stale", async () => {
    const { assessment, envelope, proof, pack } = createValidCanarySaveBaseline();

    await saveApprovedMessagePack(10, 1, pack, { mode: "canary", proof });

    const tamperedWarningCodeAssessment = {
      ...assessment,
      warnings: [
        { ...assessment.warnings[0], code: `${assessment.warnings[0].code}_TAMPERED` },
        ...assessment.warnings.slice(1),
      ],
      assessmentHashSha256: assessment.assessmentHashSha256,
    };

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...proof,
          assessment: tamperedWarningCodeAssessment as any,
          envelope: {
            ...envelope,
            assessmentHashSha256: assessment.assessmentHashSha256,
          },
        },
      })
    ).rejects.toThrow(/assessment hash mismatch/);
  });

  it("canary save rejects warning-message tampering when stored assessment hashes remain stale", async () => {
    const { assessment, envelope, proof, pack } = createValidCanarySaveBaseline();

    await saveApprovedMessagePack(10, 1, pack, { mode: "canary", proof });

    const tamperedWarningMessageAssessment = {
      ...assessment,
      warnings: [
        { ...assessment.warnings[0], message: `${assessment.warnings[0].message} TAMPERED` },
        ...assessment.warnings.slice(1),
      ],
      assessmentHashSha256: assessment.assessmentHashSha256,
    };

    await expect(
      saveApprovedMessagePack(10, 1, pack, {
        mode: "canary",
        proof: {
          ...proof,
          assessment: tamperedWarningMessageAssessment as any,
          envelope: {
            ...envelope,
            assessmentHashSha256: assessment.assessmentHashSha256,
          },
        },
      })
    ).rejects.toThrow(/assessment hash mismatch/);
  });

  it("force rebuild supersedes prior artifact only after successful replacement save", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const storedPack: CampaignMessagePack = {
      ...basePack,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "latest_message_pack",
      isGeneric: false,
    };

    const db = createMockDb({ storedPacks: [storedPack] }) as any;
    vi.mocked(getDb).mockReturnValue(db);

    await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1, forceRebuild: true });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertOrder = (db.insert as any).mock.invocationCallOrder[0] as number;
    const campaignAssetUpdates = (db.update as any).mock.calls.filter((call: any[]) => {
      const tableName = (call[0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
      return tableName === "campaign_assets";
    });
    expect(campaignAssetUpdates.length).toBeGreaterThan(0);
    const campaignAssetUpdateOrder = (db.update as any).mock.invocationCallOrder.find((_: number, idx: number) => {
      const tableName = ((db.update as any).mock.calls[idx][0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
      return tableName === "campaign_assets";
    });
    expect(campaignAssetUpdateOrder).toBeGreaterThan(insertOrder);
  });

  it("force rebuild replacement-save failure preserves prior artifact by preventing supersede", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const storedPack: CampaignMessagePack = {
      ...basePack,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "latest_message_pack",
      isGeneric: false,
    };

    const db = createMockDb({ storedPacks: [storedPack], insertThrows: true }) as any;
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1, forceRebuild: true })
    ).rejects.toThrow(/insert failed/);

    const campaignAssetUpdates = (db.update as any).mock.calls.filter((call: any[]) => {
      const tableName = (call[0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
      return tableName === "campaign_assets";
    });
    expect(campaignAssetUpdates).toHaveLength(0);
  });

  it("force rebuild supersede maintenance failure does not remove newly saved artifact", async () => {
    process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
    process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";

    const storedPack: CampaignMessagePack = {
      ...basePack,
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "latest_message_pack",
      isGeneric: false,
    };

    const db = createMockDb({ storedPacks: [storedPack], throwOnCampaignAssetsUpdate: true }) as any;
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1, forceRebuild: true })
    ).rejects.toThrow(/supersede update failed/);

    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  describe("shadow-mode public entry point hardening", () => {
    const expectedLegacyHeadline = "Cut delayed staff payouts with Zuto Hub payout platform";
    const expectedLegacySubheadline = "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.";
    const expectedBenefit = "Mass disbursements improve payout speed for frontline teams.";
    const expectedCta = "Learn More";
    const expectedCaption = "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.";
    const expectedProofPoint = "Payout platform supports mass disbursements and supplier payouts.";

    function countShadowObservations(): number {
      return getAllLogPayloads().filter((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation").length;
    }

    function findShadowObservation(): Record<string, unknown> | undefined {
      return getAllLogPayloads().find((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation");
    }

    function findShadowSkipped(): Record<string, unknown> | undefined {
      return getAllLogPayloads().find((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation_skipped");
    }

    function makeShadowResult(input: any): ShadowEvaluationResult {
      return {
        mode: "shadow",
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        contextSource: "legacy_loaded_context",
        contextReadyForComparison: true,
        missingContextFields: [],
        candidateId: input.candidateId,
        candidateSource: "ai_refined",
        copyHashSha256: "a".repeat(64),
        legacyDecision: "approved",
        legacyIsGeneric: false,
        legacyScore: 95,
        v2Decision: "approved",
        v2HardIssueCodes: [],
        v2WarningCodes: [],
        v2Score: 92,
        decisionMatched: true,
        durationMs: 10,
        errorStage: null,
        errorCode: null,
      };
    }

    function runAgentOutput(cta = expectedCta) {
      return {
        runId: 124,
        output: {
          headline: expectedLegacyHeadline,
          subheadline: expectedLegacySubheadline,
          benefitBullets: [
            expectedBenefit,
            "Tips and commissions payouts reduce reconciliation bottlenecks.",
            "Supplier payouts remain consistent across restaurant locations.",
          ],
          cta,
          footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
          proofPoints: [expectedProofPoint],
          platformCaptions: [
            {
              platform: "Instagram",
              caption: expectedCaption,
              cta,
              hashtags: ["#payoutplatform", "#frontlineteams"],
            },
          ],
        },
      } as any;
    }

    beforeEach(() => {
      process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
      vi.mocked(runShadowMessageApproval).mockImplementation((input: any) => {
        const result = makeShadowResult(input);
        input.log(result);
        return result;
      });
    });

    it("buildApprovedMessagePack returns the legacy pack, emits exactly one v2_shadow_observation and contains no raw copy", async () => {
      delete process.env.CREATIVE_PIPELINE_V2_MODE;
      const legacySnapshot = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      let passedLegacy: CampaignMessagePack | undefined;
      vi.clearAllMocks();
      process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
      vi.mocked(runShadowMessageApproval).mockImplementation((input: any) => {
        passedLegacy = input.legacyPack;
        const result = makeShadowResult(input);
        input.log(result);
        return result;
      });

      const pack = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack).toEqual(legacySnapshot);
      expect(pack).toBe(passedLegacy);
      expect(pack.headline).toBe(expectedLegacyHeadline);
      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).toHaveBeenCalledTimes(1);
      expect(countShadowObservations()).toBe(1);

      const observation = findShadowObservation();
      expect(observation).toBeDefined();
      expect(observation?.event).toBe("v2_shadow_observation");
      expect(observation?.decisionMatched).toBe(true);
      expect(observation?.copyHashSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation).not.toHaveProperty("headline");
      expect(observation).not.toHaveProperty("subheadline");
      expect(observation).not.toHaveProperty("benefitBullets");
      expect(observation).not.toHaveProperty("cta");
      expect(observation).not.toHaveProperty("caption");

      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain(expectedLegacyHeadline);
      expect(serialized).not.toContain(expectedLegacySubheadline);
      expect(serialized).not.toContain(expectedBenefit);
      expect(serialized).not.toContain(expectedCta);
      expect(serialized).not.toContain(expectedCaption);
      expect(serialized).not.toContain(expectedProofPoint);

      const db = vi.mocked(getDb).mock.results[0]?.value;
      expect(db?.insert).not.toHaveBeenCalled();
    });

    it("ensureApprovedMessagePack returns the legacy pack, emits exactly one v2_shadow_observation and does not leak raw copy", async () => {
      vi.mocked(runAgent).mockResolvedValueOnce(runAgentOutput("Book a Demo"));
      delete process.env.CREATIVE_PIPELINE_V2_MODE;
      const legacySnapshot = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      let passedLegacy: CampaignMessagePack | undefined;
      vi.clearAllMocks();
      process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
      vi.mocked(runAgent).mockResolvedValueOnce(runAgentOutput("Book a Demo"));
      vi.mocked(runShadowMessageApproval).mockImplementation((input: any) => {
        passedLegacy = input.legacyPack;
        const result = makeShadowResult(input);
        input.log(result);
        return result;
      });

      const pack = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack).toEqual(legacySnapshot);
      expect(pack).toBe(passedLegacy);
      expect(pack.headline).toBe(expectedLegacyHeadline);
      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).toHaveBeenCalledTimes(1);
      expect(countShadowObservations()).toBe(1);
      expect(findShadowObservation()?.event).toBe("v2_shadow_observation");

      const serialized = JSON.stringify(findShadowObservation());
      expect(serialized).not.toContain(expectedLegacyHeadline);
      expect(serialized).not.toContain(expectedBenefit);
      expect(serialized).not.toContain("Book a Demo");

      const db = vi.mocked(getDb).mock.results[0]?.value;
      expect(db?.insert).toHaveBeenCalledTimes(1);
    });

    it("refineApprovedMessagePack returns the legacy pack, emits exactly one v2_shadow_observation and does not leak raw copy", async () => {
      delete process.env.CREATIVE_PIPELINE_V2_MODE;
      const legacySnapshot = await refineApprovedMessagePack({
        userId: 10,
        campaignId: 1,
        existingPack: basePack,
        refinementInstruction: "Make it more urgent",
        skipBilling: true,
        maxAttempts: 1,
      });

      let passedLegacy: CampaignMessagePack | undefined;
      vi.clearAllMocks();
      process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
      vi.mocked(runShadowMessageApproval).mockImplementation((input: any) => {
        passedLegacy = input.legacyPack;
        const result = makeShadowResult(input);
        input.log(result);
        return result;
      });

      const pack = await refineApprovedMessagePack({
        userId: 10,
        campaignId: 1,
        existingPack: basePack,
        refinementInstruction: "Make it more urgent",
        skipBilling: true,
        maxAttempts: 1,
      });

      expect(pack).toEqual(legacySnapshot);
      expect(pack).toBe(passedLegacy);
      expect(pack.headline).toBe(expectedLegacyHeadline);
      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).toHaveBeenCalledTimes(1);
      expect(countShadowObservations()).toBe(1);
      expect(findShadowObservation()?.event).toBe("v2_shadow_observation");

      const serialized = JSON.stringify(findShadowObservation());
      expect(serialized).not.toContain(expectedLegacyHeadline);
      expect(serialized).not.toContain(expectedBenefit);
      expect(serialized).not.toContain(expectedCaption);

      const db = vi.mocked(getDb).mock.results[0]?.value;
      expect(db?.insert).not.toHaveBeenCalled();
    });

    it("shadow output cannot replace the legacy result even when V2 disagrees", async () => {
      delete process.env.CREATIVE_PIPELINE_V2_MODE;
      const legacySnapshot = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      vi.clearAllMocks();
      process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
      vi.mocked(runShadowMessageApproval).mockImplementation((input: any) => {
        const result: ShadowEvaluationResult = { ...makeShadowResult(input), v2Decision: "rejected", decisionMatched: false };
        input.log(result);
        return result;
      });

      const pack = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack).toEqual(legacySnapshot);
      expect(pack.headline).toBe(expectedLegacyHeadline);
      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(findShadowObservation()?.event).toBe("v2_shadow_observation");
      expect(findShadowObservation()?.decisionMatched).toBe(false);
    });

    it("shadow evaluation failure is isolated and the legacy response is still returned", async () => {
      vi.mocked(runShadowMessageApproval).mockImplementation(() => {
        throw new Error("shadow runner exploded");
      });

      const pack = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack.headline).toBe(expectedLegacyHeadline);
      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).toHaveBeenCalledTimes(1);

      const skipped = findShadowSkipped();
      expect(skipped).toBeDefined();
      expect(skipped?.event).toBe("v2_shadow_observation_skipped");
      expect(skipped?.errorCode).toBe("SHADOW_OBSERVATION_FAILED");
      expect(findShadowObservation()).toBeUndefined();
      expect(countShadowObservations()).toBe(0);
    });

    it("off, active, unknown and non-selected canary modes do not emit a shadow observation", async () => {
      vi.mocked(runShadowMessageApproval).mockReturnValue(null);

      const modes: Array<{ mode: string; campaignIds?: string }> = [
        { mode: "off" },
        { mode: "active" },
        { mode: "unknown_mode" },
        { mode: "canary", campaignIds: "999" },
      ];

      for (const m of modes) {
        vi.clearAllMocks();
        delete process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED;
        delete process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS;
        process.env.CREATIVE_PIPELINE_V2_MODE = m.mode;
        if (m.mode === "canary") {
          process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
          process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = m.campaignIds;
        }

        await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });
        expect(runShadowMessageApproval).not.toHaveBeenCalled();
        expect(findShadowObservation()).toBeUndefined();
        expect(findShadowSkipped()).toBeUndefined();
      }
    });
  });

  describe("canary authority routing", () => {
    function countShadowObservations(): number {
      return getAllLogPayloads().filter((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation").length;
    }

    function findShadowObservation(): Record<string, unknown> | undefined {
      return getAllLogPayloads().find((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation");
    }

    function findShadowSkipped(): Record<string, unknown> | undefined {
      return getAllLogPayloads().find((p) => (p as Record<string, unknown>)?.event === "v2_shadow_observation_skipped");
    }

    function setSelectedCanary() {
      process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
      process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
      process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";
    }

    function setNonSelectedCanary() {
      process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
      process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
      process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "999";
    }

    beforeEach(() => {
      vi.mocked(runShadowMessageApproval).mockReturnValue(null);
    });

    it("selected canary buildApprovedMessagePack follows canary authority once and does not run shadow", async () => {
      setSelectedCanary();

      const pack = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack.v2ApprovalEnvelope).toBeDefined();
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("selected canary ensureApprovedMessagePack follows canary authority once and does not run shadow", async () => {
      setSelectedCanary();

      const pack = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack.v2ApprovalEnvelope).toBeDefined();
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("selected canary refineApprovedMessagePack follows canary authority once and does not run shadow", async () => {
      setSelectedCanary();

      const pack = await refineApprovedMessagePack({
        userId: 10,
        campaignId: 1,
        existingPack: basePack,
        refinementInstruction: "Make it more urgent",
        skipBilling: true,
        maxAttempts: 1,
      });

      expect(pack.v2ApprovalEnvelope).toBeDefined();
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("non-selected canary buildApprovedMessagePack stays on legacy path and does not run shadow", async () => {
      setNonSelectedCanary();

      const pack = await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("non-selected canary ensureApprovedMessagePack stays on legacy path and does not run shadow", async () => {
      setNonSelectedCanary();

      const pack = await ensureApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("non-selected canary refineApprovedMessagePack stays on legacy path and does not run shadow", async () => {
      setNonSelectedCanary();

      const pack = await refineApprovedMessagePack({
        userId: 10,
        campaignId: 1,
        existingPack: basePack,
        refinementInstruction: "Make it more urgent",
        skipBilling: true,
        maxAttempts: 1,
      });

      expect(pack.v2ApprovalEnvelope).toBeUndefined();
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
      expect(findShadowObservation()).toBeUndefined();
      expect(findShadowSkipped()).toBeUndefined();
    });

    it("ensures canary and shadow authority never execute during the same top-level call", async () => {
      setSelectedCanary();

      await buildApprovedMessagePack({ userId: 10, campaignId: 1, skipBilling: true, maxAttempts: 1 });

      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(runShadowMessageApproval).not.toHaveBeenCalled();
      expect(countShadowObservations()).toBe(0);
    });
  });

  describe("WBS 4E.3 forceRebuild canary containment — single invocation", () => {
    const setSelectedCanary = () => {
      process.env.CREATIVE_PIPELINE_V2_MODE = "canary";
      process.env.CREATIVE_PIPELINE_V2_CANARY_ENABLED = "true";
      process.env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS = "1";
    };

    const NEW_PACK_HEADLINE = "Cut delayed staff payouts with Zuto Hub payout platform";

    const forceRebuildInvocation = {
      userId: 10,
      campaignId: 1,
      skipBilling: true,
      maxAttempts: 1,
      forceRebuild: true,
      privacyMode: "safe" as const,
    };

    const storedApprovedPack = (cta?: string): CampaignMessagePack => ({
      ...basePack,
      cta: cta ?? basePack.cta,
      platformCaptions: basePack.platformCaptions.map((caption) => ({
        ...caption,
        cta: cta ?? caption.cta,
      })),
      validation: { passed: true, score: 100, rejections: [], warnings: [] },
      messagePackSource: "latest_message_pack",
      isGeneric: false,
    });

    // With this brief override the exact V2 CTA policy requires
    // "Request a Walkthrough" (awareness stage) — a CTA that legacy
    // genericity derivation does NOT classify as generic. Tests that assert
    // exact supersede counts use it so the generic-marking housekeeping in
    // saveApprovedMessagePack stays out of the assertion surface.
    const WALKTHROUGH_CAMPAIGN_FIELDS = {
      preferredCta: "Awareness: Request a Walkthrough\nConsideration: Book a Demo\nConversion: Request a Walkthrough",
    };

    const walkthroughAgentOutput = {
      headline: NEW_PACK_HEADLINE,
      subheadline:
        "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.",
      benefitBullets: [
        "Mass disbursements improve payout speed for frontline teams.",
        "Tips and commissions payouts reduce reconciliation bottlenecks.",
        "Supplier payouts remain consistent across restaurant locations.",
      ],
      cta: "Request a Walkthrough",
      footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
      proofPoints: ["Payout platform supports mass disbursements and supplier payouts."],
      platformCaptions: [
        {
          platform: "Instagram",
          caption:
            "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.",
          cta: "Request a Walkthrough",
          hashtags: ["#payoutplatform", "#frontlineteams"],
        },
      ],
    };

    // Passes legacy validation (CTA mismatch is only a legacy warning) but is
    // rejected by the V2 authority: the campaign strategy requires the exact
    // CTA "Learn More" (awareness stage) for this fixture.
    const ctaMismatchedAgentOutput = {
      headline: NEW_PACK_HEADLINE,
      subheadline:
        "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.",
      benefitBullets: [
        "Mass disbursements improve payout speed for frontline teams.",
        "Tips and commissions payouts reduce reconciliation bottlenecks.",
        "Supplier payouts remain consistent across restaurant locations.",
      ],
      cta: "Book a Demo",
      footerContact: { phone: null, whatsapp: null, email: null, website: null, location: "South Africa" },
      proofPoints: ["Payout platform supports mass disbursements and supplier payouts."],
      platformCaptions: [
        {
          platform: "Instagram",
          caption:
            "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.",
          cta: "Book a Demo",
          hashtags: ["#payoutplatform", "#frontlineteams"],
        },
      ],
    };

    it("TEST A — forceRebuild evaluates the stored approved pack but does not reuse or return it", async () => {
      setSelectedCanary();
      const db = createMockDb({ storedPacks: [storedApprovedPack()] }) as any;
      vi.mocked(getDb).mockReturnValue(db);

      const pack = await ensureApprovedMessagePack(forceRebuildInvocation);

      // The new candidate path was attempted via the creative agent.
      expect(runAgent).toHaveBeenCalled();
      // The returned pack is the freshly generated candidate, not the stored pack.
      expect(pack.headline).toBe(NEW_PACK_HEADLINE);
      expect(pack.headline).not.toBe(basePack.headline);
      // Exactly one save occurred and it persisted the NEW candidate.
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insertCalls).toHaveLength(1);
      expect(db.insertCalls[0].table).toBe("campaign_assets");
      expect(db.insertCalls[0].values.assetType).toBe("message_pack");
      expect(db.insertCalls[0].values.metadata.approvedMessagePack.headline).toBe(NEW_PACK_HEADLINE);
    });

    it("TEST B — a successful V2 candidate saves exactly once in canary mode with a verified proof and envelope", async () => {
      setSelectedCanary();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      const pack = await ensureApprovedMessagePack(forceRebuildInvocation);

      // Exactly one persistence call — no second save path.
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insertCalls).toHaveLength(1);
      const savedValues = db.insertCalls[0].values;
      expect(savedValues.assetType).toBe("message_pack");
      expect(savedValues.status).toBe("ready");
      // The persisted pack carries the V2 approval envelope (canary-mode evidence).
      expect(savedValues.metadata.v2ApprovalEnvelope).toBeDefined();
      expect(savedValues.metadata.approvedMessagePack.v2ApprovalEnvelope).toBeDefined();
      expect(savedValues.metadata.v2ApprovalEnvelope.candidateSource).toBe("ai_initial");
      expect(pack.v2ApprovalEnvelope).toBeDefined();
      // Proof verification ran exactly once for the single save — proof was supplied.
      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      const [verifiedPack, verifiedProof] = vi.mocked(verifyCanaryApprovalProof).mock.calls[0];
      expect(verifiedPack.v2ApprovalEnvelope).toBeDefined();
      expect(verifiedProof.envelope).toBeDefined();
      // Single attempt — no retry loop and no duplicate agent run.
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("TEST C — the prior-best asset is superseded exactly once, only after the replacement save succeeds", async () => {
      setSelectedCanary();
      const db = createMockDb({
        storedPacks: [storedApprovedPack("Request a Walkthrough")],
        campaignFields: WALKTHROUGH_CAMPAIGN_FIELDS,
      }) as any;
      vi.mocked(getDb).mockReturnValue(db);
      vi.mocked(runAgent).mockResolvedValue({ runId: 123, output: walkthroughAgentOutput } as any);

      await ensureApprovedMessagePack(forceRebuildInvocation);

      expect(db.insert).toHaveBeenCalledTimes(1);
      const newAssetId = 1; // createMockDb insertId

      const assetUpdates = db.updateCalls.filter((call: any) => call.table === "campaign_assets");
      expect(assetUpdates).toHaveLength(1);
      expect(assetUpdates[0].set.metadata.supersededBy).toBe(newAssetId);
      expect(assetUpdates[0].set.metadata.approvedMessagePack.supersededBy).toBe(newAssetId);

      // The supersede is strictly ordered after the replacement insert.
      const insertOrder = (db.insert as any).mock.invocationCallOrder[0] as number;
      const assetUpdateIndex = (db.update as any).mock.calls.findIndex((call: any[]) => {
        const tableName = (call[0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        return tableName === "campaign_assets";
      });
      const assetUpdateOrder = (db.update as any).mock.invocationCallOrder[assetUpdateIndex] as number;
      expect(assetUpdateOrder).toBeGreaterThan(insertOrder);
    });

    it("TEST D — a failed replacement save never supersedes and leaves the prior asset and workflow context untouched", async () => {
      setSelectedCanary();
      const db = createMockDb({ storedPacks: [storedApprovedPack()], insertThrows: true }) as any;
      vi.mocked(getDb).mockReturnValue(db);

      await expect(ensureApprovedMessagePack(forceRebuildInvocation)).rejects.toThrow(/insert failed/);

      // The replacement was attempted exactly once and failed before any supersede.
      expect(db.insertCalls.filter((call: any) => call.table === "campaign_assets")).toHaveLength(1);
      expect(db.updateCalls.filter((call: any) => call.table === "campaign_assets")).toHaveLength(0);
      // campaigns.workflowContext is only written after a successful save.
      expect(db.updateCalls.filter((call: any) => call.table === "campaigns")).toHaveLength(0);
    });

    it("TEST E — rejected AI candidates and a rejected deterministic fallback fail safely with BAD_REQUEST", async () => {
      setSelectedCanary();
      // Default brief: the deterministic fallback pack misses pain-point alignment,
      // so every candidate (initial, refinements, deterministic) is V2-rejected.
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);
      vi.mocked(runAgent).mockResolvedValue({ runId: 123, output: ctaMismatchedAgentOutput } as any);

      const error = await ensureApprovedMessagePack(forceRebuildInvocation).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toBe("V2 message approval rejected all candidates.");

      // Bounded candidate attempts: initial + two refinements (the deterministic
      // fallback requires no agent run).
      expect(runAgent).toHaveBeenCalledTimes(3);
      // No message pack saved and no existing pack superseded.
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.insertCalls).toHaveLength(0);
      expect(db.updateCalls).toHaveLength(0);
    });

    it("TEST F — the deterministic fallback is approved through V2 and replaces the prior best after exactly one save", async () => {
      setSelectedCanary();
      // Relax the pain point so the deterministic fallback aligns with the V2
      // grounding policy and can be approved. "reconciliation" is a substring of
      // both the stored pack's "manual payout reconciliation" and the
      // deterministic pack's "less manual reconciliation", so the prior best
      // stays V2-eligible. The brief override also makes "Request a
      // Walkthrough" the exact required CTA (non-generic per legacy
      // derivation) so exactly one supersede update is expected.
      const db = createMockDb({
        storedPacks: [storedApprovedPack("Request a Walkthrough")],
        campaignFields: {
          ...WALKTHROUGH_CAMPAIGN_FIELDS,
          mainPainPoint: "reconciliation",
        },
      }) as any;
      vi.mocked(getDb).mockReturnValue(db);
      vi.mocked(runAgent).mockResolvedValue({ runId: 123, output: ctaMismatchedAgentOutput } as any);

      const pack = await ensureApprovedMessagePack(forceRebuildInvocation);

      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(db.insert).toHaveBeenCalledTimes(1);
      const savedValues = db.insertCalls[0].values;
      expect(savedValues.metadata.v2ApprovalEnvelope).toBeDefined();
      expect(savedValues.metadata.v2ApprovalEnvelope.candidateSource).toBe("deterministic_fallback");
      expect(savedValues.metadata.approvedMessagePack.messagePackSource).toBe("fallback_deterministic");
      expect(pack.messagePackSource).toBe("fallback_deterministic");
      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      // Supersession of the prior best occurred exactly once, after the save.
      const assetUpdates = db.updateCalls.filter((call: any) => call.table === "campaign_assets");
      expect(assetUpdates).toHaveLength(1);
      const insertOrder = (db.insert as any).mock.invocationCallOrder[0] as number;
      const assetUpdateIndex = (db.update as any).mock.calls.findIndex((call: any[]) => {
        const tableName = (call[0] as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
        return tableName === "campaign_assets";
      });
      const assetUpdateOrder = (db.update as any).mock.invocationCallOrder[assetUpdateIndex] as number;
      expect(assetUpdateOrder).toBeGreaterThan(insertOrder);
    });

    it("TEST G — a duplicate evaluation key is evaluated once and creates no second approval/save path", async () => {
      setSelectedCanary();
      // Stored pack copy is byte-identical to the generated candidate copy.
      const identicalStoredPack: CampaignMessagePack = {
        headline: NEW_PACK_HEADLINE,
        subheadline:
          "Restaurants and delivery platforms reduce manual payout reconciliation with mass disbursements.",
        benefitBullets: [
          "Mass disbursements improve payout speed for frontline teams.",
          "Tips and commissions payouts reduce reconciliation bottlenecks.",
          "Supplier payouts remain consistent across restaurant locations.",
        ],
        cta: "Request a Walkthrough",
        footerContact: { location: "South Africa" },
        proofPoints: ["Payout platform supports mass disbursements and supplier payouts."],
        platformCaptions: [
          {
            platform: "Instagram",
            caption:
              "Frontline teams can avoid delayed staff payouts using Zuto Hub payout platform automation.",
            cta: "Request a Walkthrough",
            hashtags: ["#payoutplatform", "#frontlineteams"],
          },
        ],
        validation: { passed: true, score: 100, rejections: [], warnings: [] },
        messagePackSource: "latest_message_pack",
        isGeneric: false,
      };
      const db = createMockDb({
        storedPacks: [identicalStoredPack],
        campaignFields: WALKTHROUGH_CAMPAIGN_FIELDS,
      }) as any;
      vi.mocked(getDb).mockReturnValue(db);
      vi.mocked(runAgent).mockResolvedValue({ runId: 123, output: walkthroughAgentOutput } as any);

      const evaluationsBefore = vi.mocked(evaluateMessageCandidate).mock.calls.length;

      const pack = await ensureApprovedMessagePack(forceRebuildInvocation);

      // Stored pack (1 evaluation) + generated candidate (cache hit) = exactly one V2 evaluation.
      expect(vi.mocked(evaluateMessageCandidate).mock.calls.length - evaluationsBefore).toBe(1);
      expect(
        vi.mocked(logInfo).mock.calls.some((call) => String(call[0]).includes("duplicate candidate key reused"))
      ).toBe(true);
      // The duplicate created no second approval/save path.
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(pack.v2ApprovalEnvelope).toBeDefined();
      const assetUpdates = db.updateCalls.filter((call: any) => call.table === "campaign_assets");
      expect(assetUpdates).toHaveLength(1);
    });

    it("TEST H — the direct architect invocation propagates skipBilling=true to every agent execution", async () => {
      setSelectedCanary();
      const db = createMockDb({ storedPacks: [storedApprovedPack()] }) as any;
      vi.mocked(getDb).mockReturnValue(db);

      await ensureApprovedMessagePack(forceRebuildInvocation);

      expect(runAgent).toHaveBeenCalledTimes(1);
      for (const call of vi.mocked(runAgent).mock.calls) {
        expect(call[0].skipBilling).toBe(true);
      }
    });

    it("TEST I — the force-rebuild path writes only the approved message pack asset and the workflow-context envelope", async () => {
      setSelectedCanary();
      const db = createMockDb({ storedPacks: [storedApprovedPack()] }) as any;
      vi.mocked(getDb).mockReturnValue(db);

      await ensureApprovedMessagePack(forceRebuildInvocation);

      // Only one row inserted, into campaign_assets (the approved message pack).
      // No content_posts, publishing_queue, schedules, approval_requests,
      // agent_runs, or ai_usage rows are created by this path.
      expect(db.insertCalls.map((call: any) => call.table)).toEqual(["campaign_assets"]);
      // Only campaign_assets (supersede) and campaigns (workflowContext) are updated.
      const updatedTables = [...new Set(db.updateCalls.map((call: any) => call.table))] as string[];
      expect(updatedTables.every((table) => ["campaign_assets", "campaigns"].includes(table))).toBe(true);

      // The campaigns update touches only workflowContext — no status/state progression.
      const campaignUpdates = db.updateCalls.filter((call: any) => call.table === "campaigns");
      expect(campaignUpdates).toHaveLength(1);
      expect(Object.keys(campaignUpdates[0].set)).toEqual(["workflowContext"]);
      expect(campaignUpdates[0].set.workflowContext.v2ApprovalEnvelope).toBeDefined();
      expect(campaignUpdates[0].set.workflowContext.approvedMessagePack).toBeDefined();
      expect(campaignUpdates[0].set.status).toBeUndefined();

      // No workflow orchestration, queue, publishing, distribution, or content
      // generation side effects at the module boundaries.
      expect(processContentGenerationJob).not.toHaveBeenCalled();
      expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
      expect(getContentGenerationQueue).not.toHaveBeenCalled();
      expect(getPublishingQueue).not.toHaveBeenCalled();
      expect(schedulePublishingJob).not.toHaveBeenCalled();
      expect(runCreativeAgent).not.toHaveBeenCalled();
      expect(runDistributionAgent).not.toHaveBeenCalled();
    });
  });

  describe("WBS 4E.3 canary save authority", () => {
    it("rejects a canary save whose pack lacks the V2 approval envelope even when a proof object is supplied", async () => {
      const { proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      const { v2ApprovalEnvelope, ...envelopeLessPack } = pack;
      expect(v2ApprovalEnvelope).toBeDefined();

      await expect(
        saveApprovedMessagePack(10, 1, envelopeLessPack as CampaignMessagePack, { mode: "canary", proof })
      ).rejects.toThrow(/Canary save requires approval proof and envelope/);

      // Rejected before proof verification and before any persistence.
      expect(verifyCanaryApprovalProof).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("accepts a valid proof with matching envelope once and writes the envelope to workflowContext only after the save", async () => {
      const { envelope, proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      await saveApprovedMessagePack(10, 1, pack, { mode: "canary", proof });

      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insertCalls[0].values.metadata.v2ApprovalEnvelope).toEqual(envelope);
      const campaignUpdates = db.updateCalls.filter((call: any) => call.table === "campaigns");
      expect(campaignUpdates).toHaveLength(1);
      expect(campaignUpdates[0].set.workflowContext.v2ApprovalEnvelope).toEqual(envelope);
    });

    it("does not write the V2 envelope to workflowContext when the save itself fails", async () => {
      const { proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb({ insertThrows: true }) as any;
      vi.mocked(getDb).mockReturnValue(db);

      await expect(saveApprovedMessagePack(10, 1, pack, { mode: "canary", proof })).rejects.toThrow(/insert failed/);

      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      expect(db.updateCalls.filter((call: any) => call.table === "campaigns")).toHaveLength(0);
    });

    it("treats legacy validation.passed as insufficient authority for canary saves while leaving legacy mode intact", async () => {
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      // A pack with every legacy green light (passed, non-generic) but no V2
      // proof/envelope is still rejected in canary mode. The CTA avoids the
      // legacy generic-CTA list so the legacy control save below exercises the
      // validation.passed branch specifically.
      const legacyGreenPack: CampaignMessagePack = {
        ...basePack,
        cta: "Request a Walkthrough",
        platformCaptions: basePack.platformCaptions.map((caption) => ({
          ...caption,
          cta: "Request a Walkthrough",
        })),
        validation: { passed: true, score: 100, rejections: [], warnings: [] },
        isGeneric: false,
      };
      await expect(
        saveApprovedMessagePack(10, 1, legacyGreenPack, { mode: "canary" })
      ).rejects.toThrow(/Canary save requires approval proof and envelope/);
      expect(verifyCanaryApprovalProof).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();

      // The very same pack is accepted by the unchanged legacy authority.
      await saveApprovedMessagePack(10, 1, legacyGreenPack);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it("lets the V2 proof authority — not the legacy validation flag — decide canary approval", async () => {
      const { proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      // Force a failing legacy validation result onto a fully proven V2 pack.
      const legacyFailingProvenPack: CampaignMessagePack = {
        ...pack,
        validation: { passed: false, score: 12, rejections: ["legacy rejection"], warnings: [] },
      };
      await saveApprovedMessagePack(10, 1, legacyFailingProvenPack, { mode: "canary", proof });
      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it("does not let the legacy isGeneric flag grant or block canary saves — proof remains the sole authority", async () => {
      const { proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      // The baseline copy derives isGeneric=true (its CTA "Learn More" sits on
      // the legacy generic-CTA list). Claiming isGeneric=false on the input
      // cannot smuggle it past the canary authority: the flag is re-derived
      // from the verified final copy, and the proven canary save still succeeds
      // because canary authority never consults the legacy generic flag.
      const claimedNonGeneric: CampaignMessagePack = { ...pack, isGeneric: false };
      await saveApprovedMessagePack(10, 1, claimedNonGeneric, { mode: "canary", proof });
      expect(verifyCanaryApprovalProof).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insertCalls[0].values.metadata.isGeneric).toBe(true);

      // Contrast: the unchanged legacy authority rejects the same derived-generic
      // pack even with validation.passed=true — legacy protections are intact.
      await expect(
        saveApprovedMessagePack(10, 1, { ...claimedNonGeneric, validation: { passed: true, score: 95, rejections: [], warnings: [] } })
      ).rejects.toThrow(/Generic message packs cannot be approved/);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it("keeps the legacy isGeneric protection fully enforced for legacy saves", async () => {
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      const genericPack: CampaignMessagePack = {
        ...basePack,
        cta: "Click Here",
        validation: { passed: true, score: 100, rejections: [], warnings: [] },
      };
      await expect(saveApprovedMessagePack(10, 1, genericPack)).rejects.toThrow(
        /Generic message packs cannot be approved/
      );
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("rejects a tampered proof whose envelope identity binding no longer matches", async () => {
      const { envelope, proof, pack } = createValidCanarySaveBaseline();
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);

      await expect(
        saveApprovedMessagePack(10, 1, pack, {
          mode: "canary",
          proof: { ...proof, envelope: { ...envelope, candidateId: "tampered-candidate" } },
        })
      ).rejects.toThrow(/identity mismatch/);

      await expect(
        saveApprovedMessagePack(10, 1, pack, {
          mode: "canary",
          proof: { ...proof, envelope: { ...envelope, approvedRevisionId: "tampered-revision" } },
        })
      ).rejects.toThrow(/identity mismatch/);

      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
