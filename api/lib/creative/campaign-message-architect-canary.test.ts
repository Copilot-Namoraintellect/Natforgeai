import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/runner", () => ({
  runAgent: vi.fn(),
  isTestMode: vi.fn(() => true),
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
}) {
  const storedRows = (overrides?.storedRowsRaw || (overrides?.storedPacks || []).map((pack, index) => ({
    id: index + 200,
    status: "ready",
    metadata: { approvedMessagePack: pack },
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
  })));

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
              if (tableName === "campaign_assets") return storedRows;
              return [];
            }),
          })),
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
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
                },
              ];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => {
      if (overrides?.insertThrows) throw new Error("insert failed");
      return [{ insertId: 1 }];
    }) })),
    update: vi.fn((table: any) => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
          if (overrides?.throwOnCampaignAssetsUpdate && tableName === "campaign_assets") {
            throw new Error("supersede update failed");
          }
          return [];
        }),
      })),
    })),
  };
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
});
