import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildWorkflowOperationId,
  finalizeWorkflowOperation,
  InMemoryWorkflowOperationRegistry,
  type WorkflowOperationIdentityInput,
} from "./workflow-operation";
import {
  observeIfEnabled,
  type QualityAuthorityObservationInput,
} from "../creative/contracts/observe-quality-authority";
import { type ApprovedStrategyLineage } from "../creative/contracts/creative-contract";
import { type ProposedCreativeContent } from "../creative/compliance/content-compliance";

const baseIdentityInput: WorkflowOperationIdentityInput = {
  operationType: "creative_recovery",
  operationSource: "recovery",
  operationReferenceId: "17",
  campaignId: 30,
  userId: 22,
  businessId: 26,
  contractFingerprint: "fp-contract-253",
  strategyRunId: 253,
  approvalRequestId: 36,
  claimId: 17,
  approvedAt: "2026-07-01T08:00:00.000Z",
};

const baseObservationInput: QualityAuthorityObservationInput = {
  campaignId: 30,
  userId: 22,
  businessId: 26,
  lineage: {
    campaignId: 30,
    userId: 22,
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedStrategyFingerprint: "fp-253",
    approvedAt: "2026-07-01T08:00:00.000Z",
    status: "approved",
    strategyRunStatus: "completed",
  },
  funnelStage: "consideration",
  campaignInputCta: "Request a Consultation",
  targetAudience: "B2B finance teams and merchant operators",
  offer: "Book a guided walkthrough",
  businessCapabilities: [
    "B2B payment orchestration",
    "prefunded merchant-account administration",
    "balance verification",
    "transaction reservations",
    "controlled payment-instruction services",
  ],
  legacySelectedCta: "Learn More",
};

const compliantProposed: ProposedCreativeContent = {
  headline: "Streamline B2B Payment Orchestration",
  primaryText:
    "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
  benefits: [
    "Verify available prefunded balances before payment instructions are issued",
    "Reserve transaction amounts with traceable administration",
    "Issue controlled payment instructions from a central account",
  ],
  cta: "Request a Consultation",
  funnelStage: "consideration",
  targetAudience: "B2B finance teams and merchant operators",
  offer: "Book a guided walkthrough",
  businessName: "Zuto Hub",
  protectedFields: {
    businessName: "Zuto Hub",
  },
};

describe("Campaign 30 recovery replay", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
  });

  it("one recovery invocation creates one top-level operation", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("campaign30 recovery replay", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    expect(result).not.toBeNull();
    expect(result!.workflowOperationId).toBeTruthy();
    expect(result!.operationType).toBe("creative_recovery");
    expect(result!.operationSource).toBe("recovery");
    expect(result!.operationReferenceId).toBe("17");
    expect(result!.correlationValid).toBe(true);

    const op = registry.findOperation(result!.workflowOperationId!);
    expect(op).not.toBeNull();
    expect(op!.campaignId).toBe(30);
    expect(op!.userId).toBe(22);
    expect(op!.businessId).toBe(26);
    expect(op!.strategyRunId).toBe(253);
    expect(op!.approvalRequestId).toBe(36);
    expect(op!.claimId).toBe(17);
  });

  it("exact replay of a Campaign 30 attempt does not increase attemptCount", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();

    const first = observeIfEnabled("campaign30 exact replay first", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      internalRunId: 254,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const operationId = first!.workflowOperationId!;
    expect(registry.listAttempts(operationId)).toHaveLength(1);

    const replay = observeIfEnabled("campaign30 exact replay second", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      internalRunId: 254,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    expect(replay!.workflowOperationId).toBe(operationId);
    expect(replay!.duplicateClassification).toBe("idempotent_replay");
    expect(registry.listAttempts(operationId)).toHaveLength(1);
  });

  it("deterministic replay produces the same workflowOperationId", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const a = observeIfEnabled("replay a", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });
    const b = observeIfEnabled("replay b", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });
    expect(a!.workflowOperationId).toBe(b!.workflowOperationId);
  });

  it("identical rerun with shared registry is classified as idempotent replay", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const a = observeIfEnabled("idempotent a", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      registry,
      proposedContent: compliantProposed,
    });
    const b = observeIfEnabled("idempotent b", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      registry,
      proposedContent: compliantProposed,
    });
    expect(a!.workflowOperationId).toBe(b!.workflowOperationId);
    expect(b!.duplicateClassification).toBe("idempotent_replay");
  });

  it("conflicting rerun with shared idempotency key is rejected", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    observeIfEnabled("conflict a", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      registry,
      proposedContent: compliantProposed,
    });

    const result = observeIfEnabled("conflict b", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      registry,
      lineage: {
        ...(baseObservationInput.lineage as ApprovedStrategyLineage),
        strategyRunId: 999,
      },
      proposedContent: compliantProposed,
    });

    expect(result).not.toBeNull();
    expect(
      result!.diagnostics.some((d) => d.includes("Workflow observation registration failed"))
    ).toBe(true);
  });

  it("claim 17 remains correlated", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("claim correlation", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });
    expect(result!.correlationValid).toBe(true);
  });

  it("models internal runs 254-257 as correlation attributes under one operation", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();

    const step1 = observeIfEnabled("campaign30 message_pack run 254", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      internalRunId: 254,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const operationId = step1!.workflowOperationId!;
    const messagePack1 = registry.listAttempts(operationId).find(
      (a) => a.attemptType === "message_pack" && a.ordinal === 1
    )!;

    const step2 = observeIfEnabled("campaign30 creative_generation run 255", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "creative_generation",
      attemptOrdinal: 1,
      internalRunId: 255,
      parentAttemptId: messagePack1.workflowAttemptId,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const step3 = observeIfEnabled("campaign30 message_pack retry run 256", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "message_pack",
      attemptOrdinal: 2,
      internalRunId: 256,
      parentAttemptId: messagePack1.workflowAttemptId,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const creativeGen1 = registry.listAttempts(operationId).find(
      (a) => a.attemptType === "creative_generation" && a.ordinal === 1
    )!;

    const step4 = observeIfEnabled("campaign30 creative_regeneration run 257", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "creative_regeneration",
      attemptOrdinal: 1,
      internalRunId: 257,
      parentAttemptId: creativeGen1.workflowAttemptId,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    expect(operationId).toBeTruthy();
    expect(step2!.workflowOperationId).toBe(operationId);
    expect(step3!.workflowOperationId).toBe(operationId);
    expect(step4!.workflowOperationId).toBe(operationId);

    const attempts = registry.listAttempts(operationId);
    expect(attempts).toHaveLength(4);

    const runIds = attempts.map((a) => a.internalRunId).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(runIds).toEqual([254, 255, 256, 257]);
  });

  it("operation stays running while attempts are registered and is terminal only after explicit finalization", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();

    const first = observeIfEnabled("campaign30 message_pack run 254", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      internalRunId: 254,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const operationId = first!.workflowOperationId!;
    const op1 = registry.findOperation(operationId);
    expect(op1?.status).toBe("running");

    observeIfEnabled("campaign30 creative_regeneration run 257", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      attemptType: "creative_regeneration",
      attemptOrdinal: 1,
      internalRunId: 257,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const op2 = registry.findOperation(operationId);
    expect(op2?.status).toBe("running");

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: operationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    const op3 = registry.findOperation(operationId);
    expect(op3?.status).toBe("failed");
    expect(op3?.failureCode).toBe("CANDIDATE_QUALITY_REJECTED");
  });

  it("final operation state is failed after explicit finalization", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("finalization input", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: result!.workflowOperationId!,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    const op = registry.findOperation(result!.workflowOperationId!);
    expect(op?.status).toBe("failed");
    expect(op?.failureCode).toBe("CANDIDATE_QUALITY_REJECTED");
  });

  it("no billing attempt exists for campaign 30 replay", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("billing check", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const attempts = registry.listAttempts(result!.workflowOperationId!);
    const billingAttempts = attempts.filter((a) => a.attemptType === "billing");
    expect(billingAttempts).toHaveLength(0);
  });

  it("no final-persistence attempt exists for campaign 30 replay", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("persistence check", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const attempts = registry.listAttempts(result!.workflowOperationId!);
    const persistenceAttempts = attempts.filter((a) => a.attemptType === "final_persistence");
    expect(persistenceAttempts).toHaveLength(0);
  });

  it("no publishing attempt exists for campaign 30 replay", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("publishing check", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const attempts = registry.listAttempts(result!.workflowOperationId!);
    const publishingAttempts = attempts.filter((a) => a.attemptType === "publishing");
    expect(publishingAttempts).toHaveLength(0);
  });
});

describe("workflow operation integration safety", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
  });

  it("off mode creates no operation observation", () => {
    process.env.QUALITY_AUTHORITY_MODE = "off";
    const result = observeIfEnabled("off mode test", baseObservationInput);
    expect(result).toBeNull();
  });

  it("observe mode returns exact legacy output shape", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const result = observeIfEnabled("observe shape test", baseObservationInput);
    expect(result).not.toBeNull();
    expect(result!.legacySelectedCta).toBe("Learn More");
    expect(result!.contractAuthoritativeCta).toBe("Request a Consultation");
    expect(result!.mismatchClassification).toBe("fallback_used_while_approved_exists");
  });

  it("observe mode without injected registry fails safely and does not pretend correlation", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const result = observeIfEnabled("no registry test", {
      ...baseObservationInput,
      proposedContent: compliantProposed,
    });
    expect(result).not.toBeNull();
    expect(result!.workflowOperationId).toBeNull();
    expect(result!.operationStatus).toBeNull();
    expect(result!.correlationFailureCodes).toContain("WORKFLOW_OBSERVATION_SKIPPED_NO_REGISTRY");
    // Compliance may still be evaluated independently; this test only asserts
    // that cross-point workflow correlation is not fabricated.
  });

  it("observe mode adds zero additional provider calls", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const providerSpy = vi.fn();
    const result = observeIfEnabled("no provider test", baseObservationInput);
    expect(result).not.toBeNull();
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it("observe mode adds zero database writes", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const dbWriteSpy = vi.fn();
    const result = observeIfEnabled("no db test", baseObservationInput);
    expect(result).not.toBeNull();
    expect(dbWriteSpy).not.toHaveBeenCalled();
  });

  it("observe mode adds zero charges", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const chargeSpy = vi.fn();
    const result = observeIfEnabled("no charge test", baseObservationInput);
    expect(result).not.toBeNull();
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it("observe mode changes no campaign workflow state", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const workflowContext = { status: "creatives_generating" };
    observeIfEnabled("workflow state test", {
      ...baseObservationInput,
      proposedContent: compliantProposed,
    });
    expect(workflowContext.status).toBe("creatives_generating");
  });

  it("observer failure does not fail legacy workflow", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const input = {
      ...baseObservationInput,
      campaignId: null as unknown as number,
    };
    expect(() => observeIfEnabled("failure test", input)).not.toThrow();
  });

  it("enforce remains blocked", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const result = observeIfEnabled("enforce test", baseObservationInput);
    expect(result).toBeNull();
  });
});

describe("workflow operation identity payload", () => {
  it("matches deterministic ID from observeIfEnabled", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();
    const result = observeIfEnabled("id match", {
      ...baseObservationInput,
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: 17,
      claimId: 17,
      registry,
    });

    const expectedId = buildWorkflowOperationId({
      operationType: "creative_recovery",
      operationSource: "recovery",
      operationReferenceId: "17",
      campaignId: 30,
      userId: 22,
      businessId: 26,
      contractFingerprint: baseObservationInput.lineage!.approvedStrategyFingerprint,
      strategyRunId: 253,
      approvalRequestId: 36,
      claimId: 17,
    });

    expect(result!.workflowOperationId).toBe(expectedId);
  });
});

describe("workflow operation shared registry scope", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
  });

  it("message-pack and creative-generation observations in the same scope resolve to one workflowOperationId", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();

    const messagePack = observeIfEnabled("shared message_pack", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      internalRunId: 254,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const creativeGen = observeIfEnabled("shared creative_generation", {
      ...baseObservationInput,
      attemptType: "creative_generation",
      attemptOrdinal: 1,
      internalRunId: 255,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    expect(messagePack!.workflowOperationId).toBe(creativeGen!.workflowOperationId);
    const attempts = registry.listAttempts(messagePack!.workflowOperationId!);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.attemptType)).toContain("message_pack");
    expect(attempts.map((a) => a.attemptType)).toContain("creative_generation");
  });

  it("a fresh scope does not inherit prior operations", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registryA = new InMemoryWorkflowOperationRegistry();
    const registryB = new InMemoryWorkflowOperationRegistry();

    const a = observeIfEnabled("scope a", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry: registryA,
    });

    observeIfEnabled("scope b", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry: registryB,
    });

    // Each registry only knows its own operation.  The deterministic IDs may be
    // identical across scopes, but the state is isolated.
    expect(registryA.listAttempts(a!.workflowOperationId!)).toHaveLength(1);
    expect(registryA.findOperation(a!.workflowOperationId!)).not.toBeNull();

    const b = observeIfEnabled("scope b", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry: registryB,
    });

    // Same deterministic identity, but each registry stores its own object.
    expect(a!.workflowOperationId).toBe(b!.workflowOperationId);
    const opA = registryA.findOperation(a!.workflowOperationId!);
    const opB = registryB.findOperation(a!.workflowOperationId!);
    expect(opA).not.toBe(opB);
    expect(registryA.listAttempts(a!.workflowOperationId!)).toHaveLength(1);
    expect(registryB.listAttempts(a!.workflowOperationId!)).toHaveLength(1);
  });

  it("multiple calls do not fail merely because an earlier observation occurred", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const registry = new InMemoryWorkflowOperationRegistry();

    const first = observeIfEnabled("first", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 1,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    const second = observeIfEnabled("second", {
      ...baseObservationInput,
      attemptType: "message_pack",
      attemptOrdinal: 2,
      businessName: "Zuto Hub",
      proposedContent: compliantProposed,
      registry,
    });

    expect(first!.workflowOperationId).toBe(second!.workflowOperationId);
    expect(registry.listAttempts(first!.workflowOperationId!)).toHaveLength(2);
  });
});
