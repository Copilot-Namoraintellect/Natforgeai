import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ success: true, transactionId: "tx-123", newBalance: 90 })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://example.com/v2-image.png", localPath: "/tmp/v2-image.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({
    primary: "#1E3A8A",
    secondary: "#F59E0B",
    accent: "#10B981",
    source: "mock",
  })),
  extractLogoPalette: vi.fn(async () => null),
  normaliseHex: vi.fn((value: unknown) => {
    const clean = String(value ?? "").replace("#", "").trim();
    if (!clean) return undefined;
    if (/^[0-9A-Fa-f]{3}$/.test(clean)) return `#${clean.split("").map((c) => c + c).join("").toUpperCase()}`;
    if (/^[0-9A-Fa-f]{6}$/.test(clean)) return `#${clean.toUpperCase()}`;
    return undefined;
  }),
  safeText: vi.fn((value: unknown) => (value == null ? "" : String(value).trim())),
}));

vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>("./campaign-message-architect");
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    refineApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    loadApprovedMessagePack: vi.fn(),
  };
});

const hybridState = vi.hoisted(() => ({ enabled: false }));

vi.mock("../env", async () => {
  const actual = await vi.importActual<typeof import("../env")>("../env");
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHybridLeafletPipeline() {
        return hybridState.enabled;
      },
    },
  };
});

vi.mock("./premium-v2/hybrid-pipeline", () => ({
  runHybridPipeline: vi.fn(),
}));

import { generatePremiumLeaflet } from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import * as scopeModule from "./contracts/rendered-quality-observation-scope";
import * as renderedCreativeEvaluator from "./quality/rendered-creative-evaluator";
import { runHybridPipeline } from "./premium-v2/hybrid-pipeline";
import { InMemoryRenderedEvidenceRegistry } from "./quality/rendered-evidence-registry";
import { isTrustedRenderedCreativeEvidence } from "./quality/rendered-creative-evaluator";
import { InMemoryWorkflowOperationRegistry } from "../workflow/workflow-operation";
import { computeCreativeBriefFingerprint } from "./brief-grounding";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";

const campaignRow = {
  id: 28,
  userId: 10,
  businessId: 24,
  name: "Print Campaign",
  productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
  targetBuyer: "Local businesses",
  mainPainPoint: "Slow turnaround on print jobs",
  offerDetails: "10% off first order",
  excludedOffers: "",
  preferredCta: "Get a Quote",
  platforms: "Instagram, Facebook",
  primaryOutcome: "Leads",
  coreMessage: "Fast local printing",
  workflowContext: {
    approvedStrategyFingerprint: "approved-print-strategy",
    strategyApprovalLineage: {
      strategyRunId: 91,
      approvalRequestId: 92,
      approvedAt: "2026-08-01T00:00:00.000Z",
      status: "approved",
      creativeBriefFingerprint: "approved-print-strategy",
    },
  },
};

const campaignFingerprint = computeCreativeBriefFingerprint(campaignRow);

function createMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          then: (resolve: (value: any[]) => void) => resolve([]),
          limit: vi.fn(async () => {
            const tableName = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string;
            if (tableName === "content_posts") {
              return [{ id: 100, userId: 10, campaignId: 28, title: "V2 Post", hook: "Hook", cta: "Post CTA", platform: "Instagram", metadata: {} }];
            }
            if (tableName === "campaigns") {
              return [campaignRow];
            }
            if (tableName === "businesses") {
              return [{
                id: 24,
                userId: 10,
                name: "3@1 Newmarket",
                displayName: "3@1 Newmarket",
                logo: resolveFixtureLogoPath("3at1"),
                industry: "Print and courier",
                location: "Newmarket",
                phone: "011 123 9999",
                website: "https://3at1newmarket.test",
                productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier, Business cards, Banners, Canvas",
                targetCustomer: "Local businesses and students",
                brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
                visualStyle: "modern",
                websiteEvidence: {
                  businessCategory: "print and courier",
                  productsServices: ["Printing", "Copying", "Scanning", "Laminating", "Binding", "Courier", "Business cards", "Banners", "Canvas"],
                },
              }];
            }
            if (tableName === "generated_images") return [];
            if (tableName === "campaign_assets") return [];
            return [];
          }),
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 1 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
}

const validPack: architect.CampaignMessagePack = {
  headline: "Fast printing for Newmarket businesses",
  subheadline: "Same-day quotes and reliable delivery for local businesses struggling with slow turnaround.",
  benefitBullets: ["Business cards", "Flyers", "Banners", "Courier"],
  cta: "Get a Quote",
  footerContact: { location: "Newmarket" },
  platformCaptions: [],
  messagePackSource: "user_structured_copy",
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  creativeBriefFingerprint: campaignFingerprint,
};

describe("generatePremiumLeaflet V2 provider", () => {
  beforeAll(async () => {
    await ensureFixtureLogos();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a V2 premium leaflet for the 3@1 Newmarket fixture", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
    expect(result.provider).toBe("premium-v2");
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
  });

  it("preserves approved copy on a design-only V2 refinement", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
      refinementInstruction: "Make the design darker and more premium",
    });

    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://example.com/v2-image.png");
  });

  it("fails before charging credits when the V2 brief quality gate rejects bad copy", async () => {
    const { getDb } = await import("../../queries/connection");
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);

    const badPack: architect.CampaignMessagePack = {
      headline: "Hi",
      subheadline: "",
      benefitBullets: [],
      cta: "",
      footerContact: { location: "Newmarket" },
      platformCaptions: [],
      messagePackSource: "user_structured_copy",
      validation: { passed: true, score: 20, rejections: [], warnings: [] },
      creativeBriefFingerprint: campaignFingerprint,
    };
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(badPack);

    const result = await generatePremiumLeaflet({
      userId: 10,
      contentPostId: 100,
      provider: "v2",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/quality gate/i);
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("keeps Slice 5B inactive for a direct request without orchestration context", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
    const observeSpy = vi.spyOn(scopeModule, "observeRenderedQualityScope");

    try {
      const result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
      });

      expect(result.status).toBe("completed");
      const generatedImage = db.insert.mock.results
        .map((result: any) => result.value.values.mock.calls[0]?.[0])
        .find((value: any) => value?.provider === "premium-v2");
      expect(generatedImage.metadata.renderRequest.qualityObservationScope).toBeUndefined();
      expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
      // No workflow authority exists for this request: no observation runs.
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });

  it("threads orchestration-owned authority through service and renderer without finalizing", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
    const observeSpy = vi.spyOn(scopeModule, "observeRenderedQualityScope");
    const registerSpy = vi.spyOn(InMemoryRenderedEvidenceRegistry.prototype, "register");

    // Existing Slice 3-4 orchestration owner: it owns the registry and the
    // already-running workflow operation for this request.
    const workflowRegistry = new InMemoryWorkflowOperationRegistry();
    const { operation } = workflowRegistry.registerOperation({
      operationType: "creative_generation",
      operationSource: "automatic",
      operationReferenceId: "100",
      campaignId: 28,
      userId: 10,
      businessId: 24,
      contractFingerprint: "approved-print-strategy",
      strategyRunId: 91,
      approvalRequestId: 92,
      claimId: null,
      approvedAt: "2026-08-01T00:00:00.000Z",
    });
    workflowRegistry.transitionOperation(operation.workflowOperationId, "running");
    const transitionSpy = vi.spyOn(workflowRegistry, "transitionOperation");

    try {
      const result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
        workflowObservation: {
          registry: workflowRegistry,
          workflowOperationId: operation.workflowOperationId,
        },
      });

      expect(result.status).toBe("completed");
      expect(observeSpy).toHaveBeenCalledTimes(1);

      // The real 3@1 render (usedContentHeight 924 / availableContentHeight
      // 942, didCrowd false) is accepted: density is diagnostic-only, never a
      // hard gate. The registered evidence is bound to the supplied operation
      // identity and remains the exact trusted in-process object.
      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [identity, evidence] = registerSpy.mock.calls[0];
      expect(identity.workflowOperationId).toBe(operation.workflowOperationId);
      expect(isTrustedRenderedCreativeEvidence(evidence)).toBe(true);
      expect((evidence as { reasonCodes: string[] }).reasonCodes).toContain(
        "RENDER_DENSITY_DIAGNOSTIC"
      );

      // The same registry instance was observed: the operation is still
      // running and was never transitioned to a terminal state.
      expect(workflowRegistry.findOperation(operation.workflowOperationId)!.status).toBe("running");
      expect(workflowRegistry.listAttempts(operation.workflowOperationId).length).toBeGreaterThan(0);
      expect(transitionSpy.mock.calls.every(([, status]) => status === "running")).toBe(true);

      const generatedImage = db.insert.mock.results
        .map((result: any) => result.value.values.mock.calls[0]?.[0])
        .find((value: any) => value?.provider === "premium-v2");
      expect(generatedImage.metadata.renderRequest.qualityObservationScope).toBeUndefined();
      expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    } finally {
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });

  it("produces identical side effects in off and observe modes for a direct request", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    const { getDb } = await import("../../queries/connection");
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
    const observeSpy = vi.spyOn(scopeModule, "observeRenderedQualityScope");

    async function runDirect(mode: string) {
      process.env.QUALITY_AUTHORITY_MODE = mode;
      vi.clearAllMocks();
      vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
      vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
      const db = createMockDb() as any;
      vi.mocked(getDb).mockReturnValue(db);
      const result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
      });
      return {
        result,
        insertCalls: db.insert.mock.calls.length,
        updateCalls: db.update.mock.calls.length,
        observeCalls: observeSpy.mock.calls.length,
        creditCalls: vi.mocked(creditEngine.deductCredits).mock.calls.length,
      };
    }

    try {
      const offRun = await runDirect("off");
      const observeRun = await runDirect("observe");

      expect(offRun.result.status).toBe("completed");
      expect(observeRun.result.status).toBe("completed");
      expect(observeRun.result.imageUrl).toBe(offRun.result.imageUrl);
      expect(observeRun.result.provider).toBe(offRun.result.provider);

      // Identical persistence, credit, and Slice 5B behavior: none of it
      // changes when the authority mode flips, because a direct request has
      // no orchestration-owned workflow context.
      expect(observeRun.insertCalls).toBe(offRun.insertCalls);
      expect(observeRun.insertCalls).toBeGreaterThan(0);
      expect(observeRun.updateCalls).toBe(offRun.updateCalls);
      expect(observeRun.creditCalls).toBe(offRun.creditCalls);
      expect(observeRun.creditCalls).toBe(1);
      expect(observeRun.observeCalls).toBe(0);
      expect(offRun.observeCalls).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });

  it("reports render_evaluation_not_supported for the hybrid pipeline without evaluating or observing", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    hybridState.enabled = true;
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(runHybridPipeline).mockResolvedValue({
      buffer: Buffer.from("hybrid-png-bytes"),
      metadata: {
        finalDecision: "premium_ready",
        fallbackReason: null,
        inventedOfferDetected: false,
      },
      critic: {
        passed: true,
        scores: {
          brandFidelity: 90,
          readability: 90,
          premiumFeel: 90,
          visualHierarchy: 90,
          logoUsage: 90,
          CTAVisibility: 90,
          genericTemplateRisk: 5,
        },
        criticalIssues: [],
        improvementSuggestions: [],
      },
      brandKit: { brandAsset: null },
    } as any);
    const observeSpy = vi.spyOn(scopeModule, "observeRenderedQualityScope");
    const evidenceSpy = vi.spyOn(scopeModule, "registerRenderedQualityEvidence");
    const evaluateSpy = vi.spyOn(renderedCreativeEvaluator, "evaluateTrustedRenderedCreative");

    // Router-owned authority is supplied, but the hybrid pipeline cannot
    // produce trusted V2 evidence; observation must not silently activate.
    const workflowRegistry = new InMemoryWorkflowOperationRegistry();
    const { operation } = workflowRegistry.registerOperation({
      operationType: "creative_generation",
      operationSource: "manual",
      operationReferenceId: "100",
      campaignId: 28,
      userId: 10,
    });
    workflowRegistry.transitionOperation(operation.workflowOperationId, "running");

    try {
      const result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
        workflowObservation: {
          registry: workflowRegistry,
          workflowOperationId: operation.workflowOperationId,
        },
      });

      expect(result.status).toBe("completed");
      expect(result.renderEvaluationStatus).toBe("render_evaluation_not_supported");
      expect(result.imageUrl).toBe("https://example.com/v2-image.png");
      // No V2 evaluator run, no trusted evidence registration, no observation.
      expect(evaluateSpy).not.toHaveBeenCalled();
      expect(evidenceSpy).not.toHaveBeenCalled();
      expect(observeSpy).not.toHaveBeenCalled();
      // Legacy side effects unchanged: one deduction, persistence ran.
      expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
      expect(db.insert.mock.calls.length).toBeGreaterThan(0);
    } finally {
      hybridState.enabled = false;
      observeSpy.mockRestore();
      evidenceSpy.mockRestore();
      evaluateSpy.mockRestore();
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });

  it("preserves the legacy success result when rendered-quality observation throws", async () => {
    const previousMode = process.env.QUALITY_AUTHORITY_MODE;
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { getDb } = await import("../../queries/connection");
    const db = createMockDb() as any;
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(validPack);
    vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(validPack);
    const observeSpy = vi
      .spyOn(scopeModule, "observeRenderedQualityScope")
      .mockImplementation(() => {
        throw new Error("observer boom");
      });

    const workflowRegistry = new InMemoryWorkflowOperationRegistry();
    const { operation } = workflowRegistry.registerOperation({
      operationType: "creative_generation",
      operationSource: "manual",
      operationReferenceId: "100",
      campaignId: 28,
      userId: 10,
    });
    workflowRegistry.transitionOperation(operation.workflowOperationId, "running");

    try {
      const result = await generatePremiumLeaflet({
        userId: 10,
        contentPostId: 100,
        provider: "v2",
        workflowObservation: {
          registry: workflowRegistry,
          workflowOperationId: operation.workflowOperationId,
        },
      });

      expect(result.status).toBe("completed");
      expect(result.imageUrl).toBe("https://example.com/v2-image.png");
      expect(result.renderEvaluationStatus).toBe("observation_failed_legacy_preserved");
      expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
      // Operation stays running; the observer never finalizes it, even when
      // the observation itself fails.
      expect(workflowRegistry.findOperation(operation.workflowOperationId)!.status).toBe("running");
    } finally {
      observeSpy.mockRestore();
      if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
      else process.env.QUALITY_AUTHORITY_MODE = previousMode;
    }
  });
});
