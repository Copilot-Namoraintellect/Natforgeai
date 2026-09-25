import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "./queries/connection";
import { runGovernedLearningCycle } from "./lib/learning/learning-cycle-service";
import { agentRouter } from "./agent-router";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/agents/strategy-agent", async () => {
  const actual = await vi.importActual<typeof import("./lib/agents/strategy-agent")>(
    "./lib/agents/strategy-agent"
  );
  return {
    ...actual,
    runStrategyAgent: vi.fn(),
    chargeForStrategyRun: vi.fn(),
  };
});

vi.mock("./lib/workflow/strategy-approval", () => ({
  assertApprovedStrategySemanticallyValid: vi.fn(async () => undefined),
  getStrategyApprovalStatus: vi.fn(() => ({
    currentFingerprint: "test-fingerprint",
    strategyFingerprint: "test-fingerprint",
    approvedStrategyFingerprint: "test-fingerprint",
    isCurrent: true,
    hasApprovedStrategy: true,
    strategyGeneratedForCurrentBrief: true,
    lineage: null,
  })),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "creatives_generating"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("./lib/creative/creative-generation-claim", () => ({
  generateOwnerToken: vi.fn(() => "test-owner-token"),
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "test-owner-token" },
  })),
  attachCreativeGenerationOperationReference: vi.fn(async () => ({ attached: true })),
  releaseClaimSafely: vi.fn(),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 300_000)),
  createClaimHeartbeatController: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    assertStillOwned: vi.fn(async () => undefined),
    abortSignal: undefined,
    lostOwnership: false,
  })),
}));

// The Learning cycle itself is covered end-to-end in learning-cycle-service
// tests; here we verify the agent endpoint wires to it and wraps the result
// in a governed, non-autonomous envelope.
vi.mock("./lib/learning/learning-cycle-service", () => ({
  runGovernedLearningCycle: vi.fn(),
}));

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 22, tierSlug: "startup" },
    session: { verified: true },
  } as any;
}

function fullKpiAssessment() {
  return {
    objectiveMetric: "conversions" as const,
    objectiveBasis: "primaryOutcome" as const,
    objectiveMatchedTerm: "bookings",
    windowStart: "2026-05-01",
    windowEnd: "2026-05-31",
    totals: {
      impressions: 100_000,
      clicks: 2000,
      conversions: 10,
      engagement: 0,
      reach: 0,
      followers: 0,
      leads: 0,
      revenue: 0,
    },
    kpis: [],
    overallStatus: "missed" as const,
  };
}

function buildRecordedResult() {
  return {
    status: "recorded" as const,
    idempotentReplay: false,
    record: {
      id: 501,
      userId: 22,
      campaignId: 7,
      evaluationVersion: "learning-v2",
      windowStart: "2026-05-01",
      windowEnd: "2026-05-31",
      objectiveSummary: 'Objective "conversions" assessed missed over 2026-05-01..2026-05-31.',
      kpiAssessment: fullKpiAssessment(),
      performanceFacts: [],
      positivePatterns: [],
      negativePatterns: [],
      confidence: "medium" as const,
      evidence: [],
      recommendedAdjustments: [
        {
          id: "rec_improve_hook_ctr",
          targetEngine: "creative" as const,
          adjustmentType: "improve_hook_ctr",
          summary: "Strengthen hooks",
          rationale: "Weak CTR",
          evidenceRefs: ["ao:1", "ao:2"],
          governance: { autoApply: false as const, requiresApproval: true as const },
        },
      ],
      governance: { autoApply: false as const, requiresApproval: true as const, phase: 2 },
      sourceObservations: [],
      normalisationIssues: [],
      provenance: {
        engine: "learning-engine",
        engineVersion: "learning-v2",
        trigger: "manual" as const,
        inputDigest: "digest",
        evaluatedAt: "2026-05-31T00:00:00.000Z",
      },
      status: "recorded",
      evaluatedAt: "2026-05-31T00:00:00.000Z",
      createdAt: "2026-05-31T00:00:00.000Z",
    },
  };
}

describe("agentRouter.runOptimisationAgent (WBS15.7 governed Learning cycle wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to the governed cycle and returns a governed envelope", async () => {
    vi.mocked(runGovernedLearningCycle).mockResolvedValue(buildRecordedResult());

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runOptimisationAgent({ campaignId: 7 });

    // The governed cycle result is wrapped, never auto-applied.
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("coming in Phase 5");

    // Non-autonomy is explicit at the endpoint boundary.
    expect(result.automaticChanges).toBe(false);
    expect(result.engine).toBe("learning-engine");
    expect(result.evaluationVersion).toBe("learning-v2");
    expect(result.status).toBe("recorded");

    // Delegation scoped to the authenticated user and requested campaign.
    expect(runGovernedLearningCycle).toHaveBeenCalledWith({
      userId: 22,
      campaignId: 7,
      trigger: "manual",
    });

    // Governed recommendations only.
    if (result.status === "recorded") {
      expect(result.record.recommendedAdjustments[0].governance.autoApply).toBe(false);
    }
  });

  it("propagates insufficient_data outcomes without fabricating a record", async () => {
    vi.mocked(runGovernedLearningCycle).mockResolvedValue({
      status: "insufficient_data",
      reason: "No factual observations exist for campaign 7 in window 2026-05-01..2026-05-31.",
      observationCount: 0,
      campaignId: 7,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-31",
    });

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runOptimisationAgent({ campaignId: 7 });

    expect(result.success).toBe(true);
    expect(result.automaticChanges).toBe(false);
    expect(result.status).toBe("insufficient_data");
  });

  it("propagates fail-closed authority_missing outcomes without fabricating a record", async () => {
    vi.mocked(runGovernedLearningCycle).mockResolvedValue({
      status: "authority_missing",
      reason: "Required Strategy authority is missing for campaign 7",
      campaignId: 7,
      readinessStatus: "authority_missing",
      requiredIssues: [],
    });

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runOptimisationAgent({ campaignId: 7 });

    expect(result.success).toBe(true);
    expect(result.automaticChanges).toBe(false);
    expect(result.status).toBe("authority_missing");
  });

  it("keeps getDb untouched by the endpoint itself (service owns persistence)", async () => {
    vi.mocked(runGovernedLearningCycle).mockResolvedValue({
      status: "insufficient_data",
      reason: "none",
      observationCount: 0,
      campaignId: 7,
      windowStart: null,
      windowEnd: null,
    });

    const caller = agentRouter.createCaller(buildCtx());
    await caller.runOptimisationAgent({ campaignId: 7 });

    expect(getDb).not.toHaveBeenCalled();
  });
});
