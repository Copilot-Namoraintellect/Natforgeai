import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { imageRouter } from "./image-router";
import { getDb } from "./queries/connection";
import * as service from "./lib/creative/service";
import {
  buildWorkflowOperationId,
  InMemoryWorkflowOperationRegistry,
} from "./lib/workflow/workflow-operation";
import { buildCandidateId } from "./lib/creative/quality/candidate-selection";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/creative/service", () => ({
  generatePremiumLeaflet: vi.fn(async () => ({
    jobId: "premium-job-1",
    provider: "premium-v2",
    status: "completed",
    imageUrl: "https://example.com/leaflet.png",
    extension: "png",
    creditsCharged: 20,
    qualityTier: "premium",
    qualityLabel: "Premium Marketing Leaflet",
    isDraft: false,
    usingFallback: false,
  })),
  generateBasicDraftLeaflet: vi.fn(),
  generateCaptionPack: vi.fn(),
}));

function buildCtx(userId = 18) {
  return {
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "pro" },
    session: { verified: true },
  } as any;
}

function mockPostLookup(rows: Array<{ campaignId: number | null }>) {
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  } as any);
}

const CALLER_INPUT = {
  contentPostId: 100,
  provider: "v2" as const,
  creativeType: "leaflet" as const,
  strongerBrandFit: false,
  regenerate: false,
  forceRegenerate: false,
};

function serviceCalls() {
  return vi.mocked(service.generatePremiumLeaflet).mock.calls.map((call) => call[0]);
}

describe("imageRouter.generatePremiumLeaflet Slice 5E router ownership", () => {
  let previousMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousMode = process.env.QUALITY_AUTHORITY_MODE;
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
    else process.env.QUALITY_AUTHORITY_MODE = previousMode;
  });

  it("off mode passes no workflow observation and preserves the legacy response", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "off";
    mockPostLookup([{ campaignId: 28 }]);

    const result = await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);

    expect(result).toEqual({
      success: true,
      imageUrl: "https://example.com/leaflet.png",
      provider: "premium-v2",
      jobId: "premium-job-1",
      creditsCharged: 20,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
    });
    const args = serviceCalls();
    expect(args).toHaveLength(1);
    expect(args[0].workflowObservation ?? null).toBeNull();
  });

  it("blocked enforce mode behaves as effective off and creates no authority", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    mockPostLookup([{ campaignId: 28 }]);

    const result = await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);

    expect(result.success).toBe(true);
    const args = serviceCalls();
    expect(args).toHaveLength(1);
    expect(args[0].workflowObservation ?? null).toBeNull();
  });

  it("observe mode creates exactly one running router-owned operation and passes it downstream", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    mockPostLookup([{ campaignId: 28 }]);
    const registerSpy = vi.spyOn(
      InMemoryWorkflowOperationRegistry.prototype,
      "registerOperation"
    );
    const transitionSpy = vi.spyOn(
      InMemoryWorkflowOperationRegistry.prototype,
      "transitionOperation"
    );

    await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);

    const args = serviceCalls();
    expect(args).toHaveLength(1);
    const observation = args[0].workflowObservation;
    expect(observation).not.toBeNull();
    // The exact registry instance is an InMemoryWorkflowOperationRegistry and
    // the operation it carries is already running before service execution.
    expect(observation!.registry).toBeInstanceOf(InMemoryWorkflowOperationRegistry);
    const operation = observation!.registry.findOperation(observation!.workflowOperationId);
    expect(operation).not.toBeNull();
    expect(operation!.status).toBe("running");
    expect(operation!.operationSource).toBe("manual");
    expect(operation!.operationReferenceId).toBe("100");
    // The operation binds the real positive campaign ID — never a sentinel.
    expect(operation!.campaignId).toBe(28);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy.mock.calls[0][1]).toBe("running");
    registerSpy.mockRestore();
    transitionSpy.mockRestore();
  });

  it("one-off post without a campaign creates no authority and preserves the legacy request", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    mockPostLookup([{ campaignId: null }]);
    const registerSpy = vi.spyOn(
      InMemoryWorkflowOperationRegistry.prototype,
      "registerOperation"
    );
    const transitionSpy = vi.spyOn(
      InMemoryWorkflowOperationRegistry.prototype,
      "transitionOperation"
    );

    const result = await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);

    // Legacy result unchanged and the service ran exactly once.
    expect(result).toEqual({
      success: true,
      imageUrl: "https://example.com/leaflet.png",
      provider: "premium-v2",
      jobId: "premium-job-1",
      creditsCharged: 20,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
    });
    expect(serviceCalls()).toHaveLength(1);
    // No registry, no operation, no transition — and workflowObservation is
    // null, so campaignId zero (or any other sentinel) never reaches
    // WorkflowOperationInput.
    expect(serviceCalls()[0].workflowObservation ?? null).toBeNull();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    registerSpy.mockRestore();
    transitionSpy.mockRestore();
  });

  it("off and blocked-enforce modes perform no lineage lookup and create no authority", async () => {
    for (const mode of ["off", "enforce"]) {
      process.env.QUALITY_AUTHORITY_MODE = mode;
      // Any preliminary observation lookup would throw; legacy mode must not
      // need the database at all.
      vi.mocked(getDb).mockImplementation(() => {
        throw new Error("observation lookup must not run in " + mode);
      });

      const result = await imageRouter
        .createCaller(buildCtx())
        .generatePremiumLeaflet(CALLER_INPUT);

      expect(result.success).toBe(true);
      expect(serviceCalls()).toHaveLength(1);
      expect(serviceCalls()[0].workflowObservation ?? null).toBeNull();
      vi.clearAllMocks();
    }
  });

  it("operation identity is deterministic for identical request lineage", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    mockPostLookup([{ campaignId: 28 }]);

    await imageRouter.createCaller(buildCtx(18)).generatePremiumLeaflet(CALLER_INPUT);
    await imageRouter.createCaller(buildCtx(18)).generatePremiumLeaflet(CALLER_INPUT);

    const [first, second] = serviceCalls();
    expect(first.workflowObservation!.workflowOperationId).toBe(
      second.workflowObservation!.workflowOperationId
    );
    expect(first.workflowObservation!.workflowOperationId).toBe(
      buildWorkflowOperationId({
        operationType: "creative_generation",
        operationSource: "manual",
        operationReferenceId: "100",
        campaignId: 28,
        userId: 18,
      })
    );
  });

  it("different post, campaign or user lineage resolves to a different operation identity", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    mockPostLookup([{ campaignId: 28 }]);
    await imageRouter.createCaller(buildCtx(18)).generatePremiumLeaflet(CALLER_INPUT);
    const baseId = serviceCalls()[0].workflowObservation!.workflowOperationId;

    // Different post under the same campaign/user.
    await imageRouter
      .createCaller(buildCtx(18))
      .generatePremiumLeaflet({ ...CALLER_INPUT, contentPostId: 101 });
    // Different campaign lineage for the same post id.
    mockPostLookup([{ campaignId: 29 }]);
    await imageRouter.createCaller(buildCtx(18)).generatePremiumLeaflet(CALLER_INPUT);
    // Different user for identical post/campaign lineage.
    mockPostLookup([{ campaignId: 28 }]);
    await imageRouter.createCaller(buildCtx(19)).generatePremiumLeaflet(CALLER_INPUT);

    const ids = serviceCalls().map((call) => call.workflowObservation!.workflowOperationId);
    expect(ids).toHaveLength(4);
    for (const id of ids.slice(1)) {
      expect(id).not.toBe(baseId);
    }
  });

  it("fails closed without authority when the post is unknown or lineage lookup fails", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";

    mockPostLookup([]);
    await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);
    expect(serviceCalls()[0].workflowObservation ?? null).toBeNull();

    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("db unavailable");
    });
    await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);
    expect(serviceCalls()[1].workflowObservation ?? null).toBeNull();
    // Legacy behavior preserved in both cases: the service still ran.
    expect(serviceCalls()).toHaveLength(2);
  });

  it("includes the router-supplied workflowOperationId in the Slice 4 candidate identity", () => {
    const operationId = buildWorkflowOperationId({
      operationType: "creative_generation",
      operationSource: "manual",
      operationReferenceId: "100",
      campaignId: 28,
      userId: 18,
    });
    const base = {
      contractFingerprint: "contract-fp",
      directionFingerprint: "direction-fp",
      candidateOrdinal: 1,
      contentFingerprint: "content-fp",
    };
    const candidateId = buildCandidateId({ ...base, workflowOperationId: operationId });
    const otherId = buildCandidateId({ ...base, workflowOperationId: "other-operation" });
    expect(candidateId).not.toBe(otherId);
    // Repeatable: same lineage, same candidate identity.
    expect(buildCandidateId({ ...base, workflowOperationId: operationId })).toBe(candidateId);
  });
});

describe("imageRouter.generatePremiumLeaflet B2A clientAttemptId ingress (dormant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUALITY_AUTHORITY_MODE = "off";
    mockPostLookup([{ campaignId: 28 }]);
  });

  const UUID_TOKEN = "9b2fcee2-7d1a-4c5b-9e3f-2a8c6d4b1e70";
  const OPAQUE_TOKEN = "a".repeat(64);

  it("omitted token remains accepted with the unchanged legacy response", async () => {
    const result = await imageRouter.createCaller(buildCtx()).generatePremiumLeaflet(CALLER_INPUT);
    expect(result).toEqual({
      success: true,
      imageUrl: "https://example.com/leaflet.png",
      provider: "premium-v2",
      jobId: "premium-job-1",
      creditsCharged: 20,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
    });
    expect(serviceCalls()).toHaveLength(1);
  });

  it("accepts a valid UUID token", async () => {
    const result = await imageRouter
      .createCaller(buildCtx())
      .generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: UUID_TOKEN });
    expect(result.success).toBe(true);
    expect(serviceCalls()).toHaveLength(1);
  });

  it("accepts a bounded opaque token at the 64-character limit", async () => {
    const result = await imageRouter
      .createCaller(buildCtx())
      .generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: OPAQUE_TOKEN });
    expect(result.success).toBe(true);
    expect(serviceCalls()).toHaveLength(1);
  });

  it("rejects an empty token", async () => {
    await expect(
      imageRouter.createCaller(buildCtx()).generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: "" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(serviceCalls()).toHaveLength(0);
  });

  it("rejects whitespace, slash, colon and other invalid characters", async () => {
    for (const bad of ["has space", "has/slash", "has:colon", "has+punct", "has.dot"]) {
      await expect(
        imageRouter.createCaller(buildCtx()).generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: bad })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(serviceCalls()).toHaveLength(0);
  });

  it("rejects the exact ASCII-range hazard characters: [ \\ ] ^ backtick", async () => {
    for (const bad of ["[", "\\", "]", "^", "`"]) {
      await expect(
        imageRouter.createCaller(buildCtx()).generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: bad })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(serviceCalls()).toHaveLength(0);
  });

  it("rejects a token longer than 64 characters", async () => {
    await expect(
      imageRouter
        .createCaller(buildCtx())
        .generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: "b".repeat(65) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(serviceCalls()).toHaveLength(0);
  });

  it("never forwards the token to the service, mints no server token, and leaves the external response unchanged", async () => {
    const result = await imageRouter
      .createCaller(buildCtx())
      .generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: UUID_TOKEN });

    const args = serviceCalls();
    expect(args).toHaveLength(1);
    // The service receives exactly its previous argument shape: no token key,
    // and the token value appears nowhere in the arguments.
    expect("clientAttemptId" in args[0]).toBe(false);
    expect(JSON.stringify(args[0])).not.toContain(UUID_TOKEN);
    // No server-minted token is added to the external response.
    expect(result).toEqual({
      success: true,
      imageUrl: "https://example.com/leaflet.png",
      provider: "premium-v2",
      jobId: "premium-job-1",
      creditsCharged: 20,
      qualityTier: "premium",
      qualityLabel: "Premium Marketing Leaflet",
      isDraft: false,
    });
    expect(Object.keys(result)).not.toContain("clientAttemptId");
    expect(JSON.stringify(result)).not.toContain(UUID_TOKEN);
  });

  it("keeps not-found lineage behavior unchanged when a token is present", async () => {
    mockPostLookup([]);
    const result = await imageRouter
      .createCaller(buildCtx())
      .generatePremiumLeaflet({ ...CALLER_INPUT, clientAttemptId: UUID_TOKEN });
    // Legacy fail-closed observation: service still runs, response unchanged.
    expect(result.success).toBe(true);
    expect(serviceCalls()).toHaveLength(1);
    expect(serviceCalls()[0].workflowObservation ?? null).toBeNull();
  });
});
