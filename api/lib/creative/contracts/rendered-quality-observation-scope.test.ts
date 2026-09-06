import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRenderedQualityObservationScope,
  observeRenderedQualityScope,
  registerRenderedQualityEvidence,
  type RenderedQualityObservationScopeInput,
} from "./rendered-quality-observation-scope";
import { createTrustedRenderedCreativeEvidence } from "../quality/rendered-creative-test-fixtures";
import { InMemoryRenderedEvidenceRegistry } from "../quality/rendered-evidence-registry";
import { isTrustedRenderedCreativeEvidence } from "../quality/rendered-creative-evaluator";
import { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";

const originalMode = process.env.QUALITY_AUTHORITY_MODE;

function baseInput() {
  return {
    campaignId: 14,
    userId: 7,
    businessId: 3,
    businessName: "Acme Print",
    lineage: {
      campaignId: 14,
      userId: 7,
      strategyRunId: 12,
      approvalRequestId: 34,
      approvedStrategyFingerprint: "approved-strategy-fingerprint",
      approvedAt: "2026-08-01T00:00:00.000Z",
      status: "approved" as const,
      strategyRunStatus: "completed" as const,
    },
    expectedApprovedStrategyFingerprint: "approved-strategy-fingerprint",
    funnelStage: "conversion" as const,
    campaignWideCta: "Request a Quote",
    campaignInputCta: "Request a Quote",
    targetAudience: "local business owners",
    offer: "10% off printing",
    offerRequired: true,
    businessCapabilities: ["Printing", "Business cards", "Banners"],
    legacySelectedCta: "Request a Quote",
    proposedContent: {
      headline: "Fast printing for local businesses",
      primaryText: "Reliable printing and banners with fast turnaround.",
      benefits: ["Printing", "Business cards", "Banners"],
      cta: "Request a Quote",
      funnelStage: "conversion" as const,
      targetAudience: "local business owners",
      offer: "10% off printing",
      businessName: "Acme Print",
      protectedFields: { businessName: "Acme Print" },
    },
    operationType: "creative_generation" as const,
    operationSource: "automatic" as const,
    operationReferenceId: 99,
    attemptType: "render" as const,
  };
}

/**
 * Simulates the existing Slice 3-4 request orchestration owner: it owns the
 * registry and the already-running workflow operation.
 */
function orchestrationOwner({ transitionToRunning = true } = {}) {
  const workflowRegistry = new InMemoryWorkflowOperationRegistry();
  const { operation } = workflowRegistry.registerOperation({
    operationType: "creative_generation",
    operationSource: "automatic",
    operationReferenceId: "99",
    campaignId: 14,
    userId: 7,
    businessId: 3,
    contractFingerprint: "approved-strategy-fingerprint",
    strategyRunId: 12,
    approvalRequestId: 34,
    claimId: null,
    approvedAt: "2026-08-01T00:00:00.000Z",
  });
  if (transitionToRunning) {
    workflowRegistry.transitionOperation(operation.workflowOperationId, "running");
  }
  return { workflowRegistry, workflowOperationId: operation.workflowOperationId };
}

function scopedInput(overrides: Partial<RenderedQualityObservationScopeInput> = {}) {
  const { workflowRegistry, workflowOperationId } = orchestrationOwner();
  const input: RenderedQualityObservationScopeInput = {
    ...baseInput(),
    registry: workflowRegistry,
    workflowOperationId,
    renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
    ...overrides,
  };
  return { input, workflowRegistry, workflowOperationId };
}

afterEach(() => {
  if (originalMode === undefined) delete process.env.QUALITY_AUTHORITY_MODE;
  else process.env.QUALITY_AUTHORITY_MODE = originalMode;
  vi.restoreAllMocks();
});

describe("RenderedQualityObservationScope", () => {
  it("is observe-only, frozen, and rejects spread or JSON-forged copies", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { input } = scopedInput();
    const scope = createRenderedQualityObservationScope(input);
    expect(scope).not.toBeNull();
    expect(Object.isFrozen(scope!)).toBe(true);
    expect(registerRenderedQualityEvidence({ ...(scope as object) }, {}).status).toBe("not_requested");
    expect(registerRenderedQualityEvidence(JSON.parse(JSON.stringify(scope)), {}).status).toBe("not_requested");
    expect(observeRenderedQualityScope({})).toBeNull();

    process.env.QUALITY_AUTHORITY_MODE = "off";
    expect(createRenderedQualityObservationScope(input)).toBeNull();
  });

  it("fails closed when workflow authority is missing, unknown, or not running", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    // Set up the owner simulations first; the spies below must only observe
    // scope-creation behavior.
    const { workflowRegistry } = orchestrationOwner();
    const createdOnly = orchestrationOwner({ transitionToRunning: false });
    const registerSpy = vi.spyOn(InMemoryWorkflowOperationRegistry.prototype, "registerOperation");
    const transitionSpy = vi.spyOn(InMemoryWorkflowOperationRegistry.prototype, "transitionOperation");

    // Missing registry.
    expect(
      createRenderedQualityObservationScope({
        ...baseInput(),
        workflowOperationId: "operation-id",
        renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
      })
    ).toBeNull();
    // Missing operation id.
    expect(
      createRenderedQualityObservationScope({
        ...baseInput(),
        registry: workflowRegistry,
        renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
      })
    ).toBeNull();
    // Unknown operation id.
    expect(
      createRenderedQualityObservationScope({
        ...baseInput(),
        registry: workflowRegistry,
        workflowOperationId: "not-a-real-operation",
        renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
      })
    ).toBeNull();
    // Operation exists but is only "created", not running.
    expect(
      createRenderedQualityObservationScope({
        ...baseInput(),
        registry: createdOnly.workflowRegistry,
        workflowOperationId: createdOnly.workflowOperationId,
        renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
      })
    ).toBeNull();

    // The scope never manufactures authority.
    expect(registerSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("reuses the exact supplied registry and running operation without creating, transitioning, or finalizing", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { input, workflowRegistry, workflowOperationId } = scopedInput();
    const registerSpy = vi.spyOn(InMemoryWorkflowOperationRegistry.prototype, "registerOperation");
    const transitionSpy = vi.spyOn(InMemoryWorkflowOperationRegistry.prototype, "transitionOperation");

    const scope = createRenderedQualityObservationScope(input);
    expect(scope).not.toBeNull();
    // Scope creation itself must not touch workflow operations.
    expect(registerSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();

    const evidence = await createTrustedRenderedCreativeEvidence();
    expect(registerRenderedQualityEvidence(scope, evidence).status).toBe("registered");

    const observation = observeRenderedQualityScope(scope);
    expect(observation).not.toBeNull();
    expect(observation!.workflowOperationId).toBe(workflowOperationId);
    expect(observation!.operationStatus).toBe("running");

    // Observation ran against the exact supplied registry instance: the
    // pre-existing observer replayed the operation and recorded its render
    // attempt there, and the operation is still running (never finalized).
    const operation = workflowRegistry.findOperation(workflowOperationId);
    expect(operation).not.toBeNull();
    expect(operation!.status).toBe("running");
    expect(workflowRegistry.listAttempts(workflowOperationId).length).toBeGreaterThan(0);
    expect(transitionSpy.mock.calls.every(([, status]) => status === "running")).toBe(true);

    // A different registry instance sees none of it.
    const otherRegistry = new InMemoryWorkflowOperationRegistry();
    expect(otherRegistry.findOperation(workflowOperationId)).toBeNull();
  });

  it("registers only exact trusted evaluator evidence under the supplied operation identity", async () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const { input, workflowOperationId } = scopedInput();
    const scope = createRenderedQualityObservationScope(input);
    const evidence = await createTrustedRenderedCreativeEvidence();

    expect(registerRenderedQualityEvidence(scope, { ...evidence }).status).toBe("rejected_untrusted");
    const first = registerRenderedQualityEvidence(scope, evidence);
    expect(first).toEqual({
      status: "registered",
      renderedAssetFingerprint: evidence.renderedAssetFingerprint,
    });
    expect(registerRenderedQualityEvidence(scope, evidence).status).toBe("idempotent_replay");

    const observation = observeRenderedQualityScope(scope);
    expect(observation!.trustedRenderedEvidenceCount).toBe(1);
    expect(observation!.renderEvidenceObservationStatus).toBe("evaluated");
    expect(observation!.workflowOperationId).toBe(workflowOperationId);
    expect(isTrustedRenderedCreativeEvidence(evidence)).toBe(true);
  });
});
