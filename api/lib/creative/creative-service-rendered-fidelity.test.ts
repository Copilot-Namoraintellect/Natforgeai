import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

const affordabilityState = vi.hoisted(() => ({ allowed: true }));

vi.mock("../billing/cost-control", () => ({
  enforceCostControl: vi.fn(async () =>
    affordabilityState.allowed
      ? { allowed: true, daily: 0, monthly: 0, balance: 100 }
      : { allowed: false, reason: "AI spend limit reached.", daily: 10, monthly: 10, balance: 100 }
  ),
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async () => ({ newBalance: 88 })),
  recordAiUsage: vi.fn(async () => {}),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({ publicUrl: "https://example.com/v2-image.png", localPath: "/tmp/v2-image.png" })),
  downloadAndStoreVideo: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn(async () => ({ text: "{}" })) };
});

vi.mock("./brand-palette", () => ({
  resolveBrandPalette: vi.fn(async () => ({ primary: "#1E3A8A", secondary: "#F59E0B", accent: "#10B981", source: "mock" })),
  extractLogoPalette: vi.fn(async () => null),
  contrastTextColor: vi.fn(() => "#FFFFFF"),
  normaliseHex: vi.fn((value: unknown) => {
    const clean = String(value ?? "").replace("#", "").trim();
    if (!clean) return undefined;
    if (/^[0-9A-Fa-f]{3}$/.test(clean)) return `#${clean.split("").map((c) => c + c).join("").toUpperCase()}`;
    if (/^[0-9A-Fa-f]{6}$/.test(clean)) return `#${clean.toUpperCase()}`;
    return undefined;
  }),
  safeText: vi.fn((value: unknown) => (value == null ? "" : String(value).trim())),
}));

// The copy validator is faked so this suite can deliberately render copy that
// diverges from the approved authority — the exact class of defect the
// semantic-fidelity gate exists to catch post-render. Copy-validation
// interplay itself is covered by the other CreativeService suites.
vi.mock("./campaign-message-architect", async () => {
  const actual = await vi.importActual<typeof import("./campaign-message-architect")>("./campaign-message-architect");
  return {
    ...actual,
    ensureApprovedMessagePack: vi.fn(),
    refineApprovedMessagePack: vi.fn(),
    saveApprovedMessagePack: vi.fn(),
    loadApprovedMessagePack: vi.fn(),
    validateCampaignCopy: vi.fn(() => ({ passed: true, score: 90, rejections: [], warnings: [] })),
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

vi.mock("./registry", async () => {
  const actual = await vi.importActual<typeof import("./registry")>("./registry");
  return {
    ...actual,
    isOpenAiLeafletConfigured: vi.fn(() => false),
    getOpenAiLeafletRenderer: vi.fn(() => ({ name: "openai-hybrid", configured: true, render: vi.fn(async () => ({ success: false, error: "ai quality failed" })) })),
  };
});

import { generatePremiumLeaflet, __setImageRenderClaimOrchestrationForTests, __setImageRenderClaimHeartbeatFactoryForTests, type ImageRenderClaimOrchestration } from "./service";
import * as architect from "./campaign-message-architect";
import * as creditEngine from "../billing/credit-engine";
import * as registry from "./registry";
import { storeImageBuffer } from "./storage";
import * as fidelityProductionGate from "./fidelity/rendered-fidelity-production-gate";
import * as fidelityGateAdapter from "./fidelity/rendered-semantic-fidelity-gate";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";
import { computeCreativeBriefFingerprint } from "./brief-grounding";

const OWNER = Object.freeze({
  claimId: 777,
  ownerToken: "owner-secret-finalization-token",
  requestAttemptKey: "a".repeat(64),
  intentFingerprint: "b".repeat(64),
  deductionKey: `img-deduction:${"a".repeat(64)}`,
});

// 1x1 transparent PNG — bytes are never inspected in this suite (storage is
// mocked); the render result only needs to be a successful V2 render with
// trustworthy layout metrics.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface DbLog {
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
  selectedTables: string[];
}

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] ?? "unknown");
}

function makeCampaignFixture(overrides: Record<string, unknown> = {}) {
  return {
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
    contentStyle: null,
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
    ...overrides,
  };
}

function createMockDb(options: { campaign?: Record<string, unknown> } = {}) {
  const log: DbLog = { inserts: [], updates: [], selectedTables: [] };
  const campaignRow = makeCampaignFixture(options.campaign);
  const businessRow = {
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
    contentStyle: null,
  };
  const postRow = { id: 100, userId: 10, campaignId: 28, title: "V2 Post", hook: "Hook", cta: "Post CTA", platform: "Instagram", metadata: {} };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          log.selectedTables.push(tableNameOf(table));
          const rowsFor = async () => {
            const name = tableNameOf(table);
            if (name === "content_posts") return [postRow];
            if (name === "campaigns") return [campaignRow];
            if (name === "businesses") return [businessRow];
            if (name === "generated_images") return [];
            return [];
          };
          return {
            then: (resolve: (value: unknown[]) => void) => {
              void rowsFor().then(resolve);
            },
            orderBy: vi.fn(() => ({ limit: vi.fn(rowsFor) })),
            limit: vi.fn(rowsFor),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        log.inserts.push({ table: tableNameOf(table), values });
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          log.updates.push({ table: tableNameOf(table), patch });
          return [];
        }),
      })),
    })),
  };
  return { db, log };
}

function makePack(overrides: Record<string, unknown> = {}) {
  return {
    headline: "Fast printing for Newmarket businesses",
    subheadline: "Same-day quotes and reliable delivery for local businesses struggling with slow turnaround.",
    // Every bullet is verbatim business capability evidence; an ungrounded
    // bullet would (correctly) fail the fidelity gate on its own.
    benefitBullets: ["Business cards", "Banners", "Courier", "Canvas"],
    cta: "Get a Quote",
    footerContact: { location: "Newmarket" },
    platformCaptions: [],
    messagePackSource: "user_structured_copy",
    validation: { passed: true, score: 90, rejections: [], warnings: [] },
    ...overrides,
  };
}

function makeFakeV2Renderer() {
  const renderMock = vi.fn(async () => ({
    success: true,
    imageBase64: PNG_1X1_BASE64,
    extension: "png",
    providerJobId: "premium-v2-fake-1",
    costUsd: 0,
    metadata: {
      v2LayoutMetrics: {
        width: 1080,
        height: 1350,
        ctaBoundingBox: { x: 240, y: 1160, w: 600, h: 80 },
        footerY: 1260,
        footerHeight: 60,
        minFontSizeUsed: 22,
        primaryCardCount: 4,
        secondaryCardCount: 0,
        layoutDensity: "premium_services",
        logoComposited: true,
      },
    },
  }));
  return {
    renderer: { name: "premium-v2", configured: true, render: renderMock },
    renderMock,
  };
}

function makeOrchestration(events: string[] = []) {
  const orchestration: ImageRenderClaimOrchestration = {
    getEffectiveMode: vi.fn(async () => "on" as const),
    evaluateGate: vi.fn(async (input) => {
      events.push("gate");
      return { status: "proceed" as const, owner: OWNER };
    }) as ImageRenderClaimOrchestration["evaluateGate"],
    createFinalizationDeps: vi.fn(() => ({}) as never) as ImageRenderClaimOrchestration["createFinalizationDeps"],
    finalize: vi.fn(async (input) => {
      events.push("finalize");
      return { status: "finalized" as const, generatedImageId: 4242, creditsCharged: input.charge.amount, newBalance: 88 };
    }) as ImageRenderClaimOrchestration["finalize"],
    failClaim: vi.fn(async () => {
      events.push("fail");
      return { transitioned: true, claim: {} as never };
    }) as ImageRenderClaimOrchestration["failClaim"],
  };
  return orchestration;
}

function useFakeV2Renderer() {
  const fake = makeFakeV2Renderer();
  vi.spyOn(registry, "getPremiumV2Renderer").mockReturnValue(fake.renderer as never);
  return fake;
}

async function runService(options: {
  campaign?: Record<string, unknown>;
  pack?: Record<string, unknown>;
  provider?: "v2";
  clientAttemptId?: string;
} = {}) {
  const { getDb } = await import("../../queries/connection");
  const mock = createMockDb({ campaign: options.campaign });
  vi.mocked(getDb).mockReturnValue(mock.db as never);
  vi.mocked(architect.ensureApprovedMessagePack).mockResolvedValue(makePack(options.pack) as never);
  vi.mocked(architect.loadApprovedMessagePack).mockResolvedValue(makePack(options.pack) as never);
  const result = await generatePremiumLeaflet({
    userId: 10,
    contentPostId: 100,
    provider: options.provider ?? "v2",
    clientAttemptId: options.clientAttemptId,
  });
  return { result, mock };
}

function lastGateOutcome(spy: ReturnType<typeof vi.spyOn>) {
  const calls = spy.mock.results;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1].value as ReturnType<typeof fidelityProductionGate.evaluateRenderedFidelityProductionGate>;
}

function saveMode(): string | undefined {
  return process.env.RENDERED_FIDELITY_GATE_MODE;
}

function restoreMode(previous: string | undefined) {
  if (previous === undefined) delete process.env.RENDERED_FIDELITY_GATE_MODE;
  else process.env.RENDERED_FIDELITY_GATE_MODE = previous;
}

beforeAll(async () => {
  await ensureFixtureLogos();
});

beforeEach(() => {
  vi.clearAllMocks();
  affordabilityState.allowed = true;
  delete process.env.RENDERED_FIDELITY_GATE_MODE;
  __setImageRenderClaimHeartbeatFactoryForTests(() => ({
    lostOwnership: false,
    assertStillOwned: async () => {},
    stop: async () => {},
  }));
});

afterEach(() => {
  __setImageRenderClaimOrchestrationForTests(null);
  __setImageRenderClaimHeartbeatFactoryForTests(null);
  delete process.env.RENDERED_FIDELITY_GATE_MODE;
});

describe("WBS12E3 rendered semantic fidelity production wiring", () => {
  it("default mode observes a divergent render: reports wouldBlock but never blocks lifecycle or billing", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    // Rendered CTA (approved pack) diverges from the campaign CTA authority.
    const { result, mock } = await runService({
      campaign: { preferredCta: "Book a Consultation" },
    });

    expect(result.status).toBe("completed");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("observed");
    expect(outcome.mode).toBe("observe");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(true);
    expect(outcome.reasonCodes).toContain("RENDERED_CTA_OVERRIDES_APPROVED");

    // Lifecycle proceeded: stored, billed, post marked ready.
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    const readyUpdate = mock.log.updates.find((e) => (e.patch as any).metadata?.imageStatus === "ready");
    expect(readyUpdate).toBeTruthy();
  });

  it("observe mode never blocks an unsupported introduced claim but reports it", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "observe";
    const { result } = await runService({
      pack: {
        benefitBullets: ["Business cards", "Banners", "Courier", "AI-powered fraud prevention on every payment"],
      },
    });

    expect(result.status).toBe("completed");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("observed");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(true);
    expect(outcome.reasonCodes).toContain("UNSUPPORTED_CLAIM_INTRODUCED");
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
  });

  it("enforce mode blocks a divergent approved CTA before storage and billing (legacy claims-off path)", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result, mock } = await runService({
      campaign: { preferredCta: "Book a Consultation" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
    expect(result.errorMessage).not.toContain("Get a Quote");

    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked).toBe(true);

    // Blocked before permanent storage and before any billing write.
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
    expect(creditEngine.recordAiUsage).not.toHaveBeenCalled();
    expect(mock.log.inserts.filter((e) => e.table === "generated_images")).toHaveLength(0);
    const failedUpdate = mock.log.updates.find((e) => (e.patch as any).metadata?.imageStatus === "failed");
    expect((failedUpdate?.patch as any)?.metadata?.imageError).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
  });

  it("enforce mode blocks unsupported introduced claims", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result } = await runService({
      pack: {
        benefitBullets: ["Business cards", "Banners", "Courier", "AI-powered fraud prevention on every payment"],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("UNSUPPORTED_CLAIM_INTRODUCED");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("blocked");
    expect(storeImageBuffer).not.toHaveBeenCalled();
  });

  it("enforce mode blocks missing required grounded claims", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result } = await runService({
      pack: { benefitBullets: ["Business cards"] },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("MISSING_APPROVED_CLAIMS");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("blocked");
    expect(storeImageBuffer).not.toHaveBeenCalled();
  });

  it("a faithful render proceeds normally in enforce mode (storage + billing once)", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    const fake = useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result, mock } = await runService();

    expect(result.status).toBe("completed");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("passed");
    expect(outcome.blocked).toBe(false);
    expect(outcome.wouldBlock).toBe(false);
    expect(fake.renderMock).toHaveBeenCalledTimes(1);
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
    expect(mock.log.inserts.filter((e) => e.table === "generated_images")).toHaveLength(1);
  });

  it("enforce failure with claims on fails the owned claim exactly once, before finalization, with no rerender", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    const events: string[] = [];
    const orchestration = makeOrchestration(events);
    __setImageRenderClaimOrchestrationForTests(orchestration);
    const fake = useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";

    const { result } = await runService({
      campaign: { preferredCta: "Book a Consultation" },
      clientAttemptId: "attempt-fidelity-1",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("RENDERED_CTA_OVERRIDES_APPROVED");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("blocked");

    // Owned claim failed exactly once; finalization (billing) never ran; the
    // provider rendered exactly once — fidelity rejection never retries.
    expect(events).toEqual(["gate", "fail"]);
    expect(orchestration.failClaim).toHaveBeenCalledTimes(1);
    expect(orchestration.finalize).not.toHaveBeenCalled();
    expect(fake.renderMock).toHaveBeenCalledTimes(1);
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("faithful render with claims on finalizes normally and never fails the claim", async () => {
    const events: string[] = [];
    const orchestration = makeOrchestration(events);
    __setImageRenderClaimOrchestrationForTests(orchestration);
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";

    const { result } = await runService({ clientAttemptId: "attempt-fidelity-2" });

    expect(result.status).toBe("completed");
    expect(events).toEqual(["gate", "finalize"]);
    expect(orchestration.finalize).toHaveBeenCalledTimes(1);
    expect(orchestration.failClaim).not.toHaveBeenCalled();
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
  });

  it("unavailable evaluation is fail-closed in enforce mode", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    vi.spyOn(fidelityGateAdapter, "evaluateRenderedSemanticFidelityGate").mockImplementation(() => {
      throw new Error("delegate unavailable");
    });
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result } = await runService();

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("FIDELITY_EVALUATION_ERROR");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked).toBe(true);
    expect(storeImageBuffer).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).not.toHaveBeenCalled();
  });

  it("legacy/envelope-less requests without approved lineage keep legacy behaviour even in enforce mode", async () => {
    const gateSpy = vi.spyOn(fidelityProductionGate, "evaluateRenderedFidelityProductionGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "enforce";
    const { result } = await runService({
      campaign: { workflowContext: {} },
    });

    expect(result.status).toBe("completed");
    const outcome = lastGateOutcome(gateSpy);
    expect(outcome.status).toBe("not_requested");
    expect(outcome.notRequestedReason).toMatch(/^lineage_not_authoritative:/);
    expect(storeImageBuffer).toHaveBeenCalledTimes(1);
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
  });

  it("off mode performs no fidelity evaluation at all", async () => {
    const adapterSpy = vi.spyOn(fidelityGateAdapter, "evaluateRenderedSemanticFidelityGate");
    useFakeV2Renderer();
    process.env.RENDERED_FIDELITY_GATE_MODE = "off";
    const { result } = await runService({
      campaign: { preferredCta: "Book a Consultation" },
    });

    expect(result.status).toBe("completed");
    expect(adapterSpy).not.toHaveBeenCalled();
    expect(creditEngine.deductCredits).toHaveBeenCalledTimes(1);
  });
});
