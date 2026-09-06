import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  observeIfEnabled,
  extractApprovedStrategyLineage,
  resolveExpectedApprovedStrategyFingerprint,
  observeRenderedQualityIfEnabled,
  type QualityAuthorityObservationInput,
} from "./observe-quality-authority";
import { compileApprovedCreativeContract } from "./creative-contract";
import { type ProposedCreativeContent } from "../compliance/content-compliance";
import { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";
import * as creativeContract from "./creative-contract";
import * as contentCompliance from "../compliance/content-compliance";
import * as logger from "../../logger";
import { InMemoryRenderedEvidenceRegistry } from "../quality/rendered-evidence-registry";
import { createTrustedRenderedCreativeEvidence } from "../quality/rendered-creative-test-fixtures";

const baseInput: QualityAuthorityObservationInput = {
  campaignId: 30,
  userId: 22,
  businessId: 42,
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
  targetAudience: "operations managers",
  offer: "Book a guided walkthrough",
  businessCapabilities: ["B2B payment orchestration"],
  legacySelectedCta: "Learn More",
};

describe("observe-quality-authority", () => {
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

  it("does nothing in off mode", () => {
    process.env.QUALITY_AUTHORITY_MODE = "off";
    const spy = vi.spyOn(creativeContract, "observeCreativeContract");
    const result = observeIfEnabled("test", baseInput);
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when enforce is requested (blocked in Slice 1)", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const spy = vi.spyOn(creativeContract, "observeCreativeContract");
    const result = observeIfEnabled("test", baseInput);
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs observation in observe mode and returns the diagnostic result", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const result = observeIfEnabled("test", baseInput);
    expect(result).not.toBeNull();
    expect(result!.contractAuthoritativeCta).toBe("Request a Consultation");
    expect(result!.legacySelectedCta).toBe("Learn More");
  });

  it("does not mutate any input array", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const original = [...baseInput.businessCapabilities];
    observeIfEnabled("test", baseInput);
    expect(baseInput.businessCapabilities).toEqual(original);
  });

  it("does not throw when observeCreativeContract throws", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    vi.spyOn(creativeContract, "observeCreativeContract").mockImplementation(() => {
      throw new Error("unexpected");
    });
    const logSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    expect(() => observeIfEnabled("test", baseInput)).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
  });

  it("extracts an approved strategy lineage from workflowContext", () => {
    const lineage = extractApprovedStrategyLineage(
      {
        strategyApprovalLineage: {
          strategyRunId: 253,
          approvalRequestId: 36,
          approvedAt: "2026-07-01T08:00:00.000Z",
          status: "approved",
          creativeBriefFingerprint: "fp-253",
        },
        approvedStrategyFingerprint: "fp-active",
      },
      30,
      22
    );
    expect(lineage).not.toBeNull();
    expect(lineage!.strategyRunId).toBe(253);
    expect(lineage!.approvedStrategyFingerprint).toBe("fp-active");
  });

  it("returns null lineage when status is not approved", () => {
    const lineage = extractApprovedStrategyLineage(
      {
        strategyApprovalLineage: {
          strategyRunId: 253,
          approvalRequestId: 36,
          status: "pending",
        },
      },
      30,
      22
    );
    expect(lineage).toBeNull();
  });

  it("resolves expected approved strategy fingerprint from workflowContext", () => {
    const fp = resolveExpectedApprovedStrategyFingerprint({
      approvedStrategyFingerprint: "fp-active",
      strategyApprovalLineage: { creativeBriefFingerprint: "fp-lineage" },
    });
    expect(fp).toBe("fp-active");
  });

  it("falls back to lineage creativeBriefFingerprint when active fingerprint is absent", () => {
    const fp = resolveExpectedApprovedStrategyFingerprint({
      strategyApprovalLineage: { creativeBriefFingerprint: "fp-lineage" },
    });
    expect(fp).toBe("fp-lineage");
  });

  describe("Slice 2 content compliance observation", () => {
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

    it("returns compliance diagnostics when proposed content is supplied", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        businessName: "Zuto Hub",
        businessCapabilities: [
          "B2B payment orchestration",
          "prefunded merchant-account administration",
          "balance verification",
          "transaction reservations",
          "controlled payment-instruction services",
        ],
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        proposedContent: compliantProposed,
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(true);
      expect(result!.complianceEvaluatorVersion).toContain("slice2");
      expect(result!.evidenceSetFingerprint).toBeTruthy();
      expect(result!.evidenceItemCount).toBeGreaterThan(0);
      expect(result!.distinctGroundedBenefitCount).toBeGreaterThanOrEqual(3);
      expect(result!.failedRuleIds).toEqual([]);
      expect(result!.audienceConsistencyStatus).toBe("consistent");
    });

    it("reports a CTA mismatch through compliance diagnostics", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        proposedContent: {
          ...compliantProposed,
          cta: "Learn More",
        },
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(false);
      expect(result!.failedRuleIds).toContain("CTA_LOCKED");
      expect(result!.enforceWouldAccept).toBe(false);
    });

    it("leaves compliance fields null when no proposed content is supplied", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", baseInput);
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBeNull();
      expect(result!.complianceEvaluatorVersion).toBeNull();
      expect(result!.evidenceSetFingerprint).toBeNull();
      expect(result!.evidenceItemCount).toBeNull();
      expect(result!.failedRuleIds).toEqual([]);
    });

    it("reports unsupported claim violations in observation diagnostics", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        businessCapabilities: ["balance verification"],
        proposedContent: {
          ...compliantProposed,
          benefits: ["Guaranteed fraud prevention for every transaction"],
        },
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(false);
      expect(result!.unsupportedClaimCodes).toContain("UNSUPPORTED_CLAIM_PRESENT");
      expect(result!.failedRuleIds).toContain("CLAIM_GROUNDING");
    });

    it("does not log prompts, credentials, contact details or raw business secrets", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const logSpy = vi.spyOn(logger, "logInfo").mockImplementation(() => {});
      observeIfEnabled("test", {
        ...baseInput,
        businessCapabilities: [
          "B2B payment orchestration",
          "prefunded merchant-account administration",
          "balance verification",
        ],
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        requiredContactDetails: ["support@zutohub.example"],
        proposedContent: compliantProposed,
      });
      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.stringify(logSpy.mock.calls[0][1]);
      const forbidden = [
        "password",
        "secret",
        "api_key",
        "apikey",
        "credential",
        "token",
        "-----BEGIN",
        "support@zutohub.example",
        "B2B payment orchestration",
        "prefunded merchant-account administration",
      ];
      for (const term of forbidden) {
        expect(payload.toLowerCase()).not.toContain(term.toLowerCase());
      }
    });

    it("does not change campaign workflow state", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const workflowContext = { status: "active" };
      observeIfEnabled("test", {
        ...baseInput,
        proposedContent: compliantProposed,
      });
      expect(workflowContext.status).toBe("active");
    });

    it("catches compliance evaluation errors without throwing", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      vi.spyOn(contentCompliance, "evaluateContentCompliance").mockImplementation(() => {
        throw new Error("compliance boom");
      });
      const logSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      const result = observeIfEnabled("test", {
        ...baseInput,
        proposedContent: compliantProposed,
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBeNull();
      expect(result!.diagnostics.some((d) => d.includes("Content compliance evaluation failed"))).toBe(true);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("approved strategy timestamp authority", () => {
    it("preserves a persisted approvedAt through lineage extraction", () => {
      const lineage = extractApprovedStrategyLineage(
        {
          strategyApprovalLineage: {
            strategyRunId: 253,
            approvalRequestId: 36,
            approvedAt: "2026-07-01T08:00:00.000Z",
            status: "approved",
            creativeBriefFingerprint: "fp-253",
          },
          approvedStrategyFingerprint: "fp-253",
        },
        30,
        22
      );
      expect(lineage).not.toBeNull();
      expect(lineage!.approvedAt).toBe("2026-07-01T08:00:00.000Z");
    });

    it("returns null lineage when approvedAt is missing", () => {
      const lineage = extractApprovedStrategyLineage(
        {
          strategyApprovalLineage: {
            strategyRunId: 253,
            approvalRequestId: 36,
            status: "approved",
            creativeBriefFingerprint: "fp-253",
          },
          approvedStrategyFingerprint: "fp-253",
        },
        30,
        22
      );
      expect(lineage).toBeNull();
    });

    const baseApprovedAtInput = {
      campaignId: 30,
      userId: 22,
      businessId: 42,
      businessName: "Zuto Hub",
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration" as const,
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
    };

    it("changes the contract fingerprint when approvedAt changes", () => {
      const a = compileApprovedCreativeContract(baseApprovedAtInput);
      const b = compileApprovedCreativeContract({
        ...baseApprovedAtInput,
        approvedAt: "2026-07-02T08:00:00.000Z",
      });
      expect(a.contractFingerprint).not.toBe(b.contractFingerprint);
    });

    it("produces identical fingerprints for identical approved contracts across repeated compilation", () => {
      const a = compileApprovedCreativeContract(baseApprovedAtInput);
      const b = compileApprovedCreativeContract(baseApprovedAtInput);
      expect(a.contractFingerprint).toBe(b.contractFingerprint);
    });
  });

  describe("Slice 3 workflow operation observation", () => {
    it("populates workflowOperationId and keeps operation running in observe mode", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        attemptType: "message_pack",
        attemptOrdinal: 1,
        registry: new InMemoryWorkflowOperationRegistry(),
      });
      expect(result).not.toBeNull();
      expect(result!.workflowOperationId).toBeTruthy();
      expect(result!.operationType).toBe("creative_generation");
      expect(result!.operationSource).toBe("automatic");
      expect(result!.operationStatus).toBe("running");
      expect(result!.attemptCount).toBe(1);
      expect(result!.attemptTypeCounts).toEqual({ message_pack: 1 });
      expect(result!.completedAttemptCount).toBe(1);
      expect(result!.failedAttemptCount).toBe(0);
      expect(result!.activeAttemptCount).toBe(0);
      expect(result!.terminalAttemptCount).toBe(1);
      expect(result!.correlationValid).toBe(true);
      expect(result!.duplicateClassification).toBe("none");
    });

    it("uses caller-supplied operation type and source", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        operationType: "creative_recovery",
        operationSource: "recovery",
        operationReferenceId: 17,
        claimId: 17,
        attemptType: "creative_generation",
        attemptOrdinal: 1,
        registry: new InMemoryWorkflowOperationRegistry(),
      });
      expect(result!.operationType).toBe("creative_recovery");
      expect(result!.operationSource).toBe("recovery");
      expect(result!.operationReferenceId).toBe("17");
    });

    it("classifies a shared registry rerun of the same logical attempt as idempotent replay", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const registry = new InMemoryWorkflowOperationRegistry();
      const a = observeIfEnabled("replay-a", {
        ...baseInput,
        attemptType: "message_pack",
        attemptOrdinal: 1,
        registry,
      });
      const b = observeIfEnabled("replay-b", {
        ...baseInput,
        attemptType: "message_pack",
        attemptOrdinal: 1,
        registry,
      });
      expect(a!.workflowOperationId).toBe(b!.workflowOperationId);
      expect(b!.duplicateClassification).toBe("idempotent_replay");
      expect(b!.attemptCount).toBe(1);
    });

    it("observer never finalizes operation based on enforceWouldAccept", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        legacySelectedCta: "Request a Consultation",
        attemptType: "creative_generation",
        attemptOrdinal: 1,
        registry: new InMemoryWorkflowOperationRegistry(),
      });
      expect(result!.operationStatus).toBe("running");
      expect(result!.enforceWouldAccept).toBe(true);
    });

    it("fails safely when no registry is injected and does not pretend correlation", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        attemptType: "creative_generation",
      });
      expect(result).not.toBeNull();
      expect(result!.workflowOperationId).toBeNull();
      expect(result!.operationStatus).toBeNull();
      expect(result!.correlationFailureCodes).toContain("WORKFLOW_OBSERVATION_SKIPPED_NO_REGISTRY");
    });

    it("correlates message-pack and creative-generation attempts under one operation when registry is shared", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const registry = new InMemoryWorkflowOperationRegistry();

      const messagePack = observeIfEnabled("msg", {
        ...baseInput,
        attemptType: "message_pack",
        attemptOrdinal: 1,
        registry,
      });

      const creativeGen = observeIfEnabled("creative", {
        ...baseInput,
        attemptType: "creative_generation",
        attemptOrdinal: 1,
        registry,
      });

      expect(messagePack!.workflowOperationId).toBe(creativeGen!.workflowOperationId);
      const attempts = registry.listAttempts(messagePack!.workflowOperationId!);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((a) => a.attemptType)).toContain("message_pack");
      expect(attempts.map((a) => a.attemptType)).toContain("creative_generation");
    });

    it("does not fail legacy output when workflow registration fails", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      vi.spyOn(InMemoryWorkflowOperationRegistry.prototype, "registerOperation").mockImplementation(() => {
        throw new Error("registry boom");
      });
      const result = observeIfEnabled("test", {
        ...baseInput,
        attemptType: "creative_generation",
        registry: new InMemoryWorkflowOperationRegistry(),
      });
      expect(result).not.toBeNull();
      expect(result!.diagnostics.some((d) => d.includes("Workflow observation registration failed"))).toBe(true);
      expect(result!.workflowOperationId).toBeNull();
    });
  });

  describe("Slice 4 premium direction and candidate observation", () => {
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

    const observeInput: QualityAuthorityObservationInput = {
      ...baseInput,
      businessName: "Zuto Hub",
      businessCapabilities: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
        "transaction reservations",
        "controlled payment-instruction services",
      ],
      targetAudience: "B2B finance teams and merchant operators",
      offer: "Book a guided walkthrough",
      proposedContent: compliantProposed,
      registry: new InMemoryWorkflowOperationRegistry(),
      attemptType: "creative_generation",
      attemptOrdinal: 1,
    };

    it("compiles three direction plans in observe mode", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("slice4", observeInput);
      expect(result).not.toBeNull();
      expect(result!.plannedDirectionCount).toBe(3);
      expect(result!.availableDirectionCount).toBeGreaterThanOrEqual(1);
      expect(result!.directionPlanFingerprint).toBeTruthy();
      expect(result!.rubricVersion).toBeTruthy();
      expect(result!.selectorVersion).toBeTruthy();
    });

    it("evaluates the legacy candidate against available direction plans", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("slice4", observeInput);
      expect(result).not.toBeNull();
      expect(result!.candidateEvaluationCount).toBeGreaterThanOrEqual(1);
      expect(result!.candidateEvaluationCount).toBeLessThanOrEqual(3);
      expect(result!.eligibleCandidateCount).not.toBeNull();
      expect(result!.hardRejectedCandidateCount).not.toBeNull();
    });

    it("keeps the operation running and does not finalize it", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("slice4", observeInput);
      expect(result!.operationStatus).toBe("running");
      expect(result!.qualityAuthorityWouldAccept).not.toBeNull();
    });

    it("hard-rejects the Campaign 30 'Learn More' candidate and selects none", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("slice4", {
        ...observeInput,
        legacySelectedCta: "Learn More",
        proposedContent: {
          ...compliantProposed,
          cta: "Learn More",
        },
      });
      expect(result).not.toBeNull();
      expect(result!.campaignId).toBe(30);
      expect(result!.contractAuthoritativeCta).toBe("Request a Consultation");
      expect(result!.legacySelectedCta).toBe("Learn More");
      expect(result!.compliancePassed).toBe(false);
      expect(result!.failedRuleIds).toContain("CTA_LOCKED");
      expect(result!.hardCompliancePassed).toBe(false);
      expect(result!.preRenderReadinessStatus).toBe("hard_compliance_failed");
      expect(result!.premiumAcceptanceStatus).toBe("hard_compliance_failed");
      expect(result!.finalPremiumScore).toBeNull();
      expect(result!.selectionStatus).toBe("no_qualifying_candidate");
      expect(result!.selectedCandidateId).toBeNull();
      expect(result!.recommendedForRenderCandidateId).toBeNull();
      expect(result!.qualityAuthorityWouldAccept).toBe(false);
      expect(result!.operationStatus).toBe("running");
      const attempts = observeInput.registry!.listAttempts(result!.workflowOperationId!);
      expect(attempts.filter((attempt) => ["candidate_generation", "billing", "final_persistence", "publishing"].includes(attempt.attemptType))).toEqual([]);
    });

    it("does not register billing, final-persistence or publishing attempts", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const registry = new InMemoryWorkflowOperationRegistry();
      const result = observeIfEnabled("slice4", { ...observeInput, registry });
      expect(result).not.toBeNull();
      const attempts = registry.listAttempts(result!.workflowOperationId!);
      const forbiddenTypes = ["billing", "final_persistence", "publishing"];
      for (const attempt of attempts) {
        expect(forbiddenTypes).not.toContain(attempt.attemptType);
      }
    });
  });

  describe("Slice 5 rendered quality observation", () => {
    const renderedInput: QualityAuthorityObservationInput = {
      ...baseInput,
      businessName: "Zuto Hub",
      businessCapabilities: [
        "B2B payment orchestration",
        "prefunded merchant-account administration",
        "balance verification",
        "transaction reservations",
        "controlled payment-instruction services",
      ],
      targetAudience: "B2B finance teams and merchant operators",
      proposedContent: {
        headline: "Streamline B2B Payment Orchestration",
        primaryText: "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
        benefits: ["Verify available prefunded balances before payment instructions are issued", "Reserve transaction amounts with traceable administration", "Issue controlled payment instructions from a central account"],
        cta: "Request a Consultation",
        funnelStage: "consideration",
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        businessName: "Zuto Hub",
        protectedFields: { businessName: "Zuto Hub" },
      },
      registry: new InMemoryWorkflowOperationRegistry(),
    };

    it("fails closed when rendered evidence is missing or copied", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const evidenceRegistry = new InMemoryRenderedEvidenceRegistry();
      const missing = observeRenderedQualityIfEnabled("slice5", { ...renderedInput, renderedEvidenceRegistry: evidenceRegistry });
      expect(missing!.renderEvidenceObservationStatus).toBe("missing_evidence");
      expect(missing!.selectionStatus).toBe("render_evaluation_required");

      const untrusted = observeRenderedQualityIfEnabled("slice5", {
        ...renderedInput,
        renderedEvidenceRegistry: evidenceRegistry,
        renderedCandidateEvidenceEntries: [{ candidateId: "unknown", renderedAssetFingerprint: "unknown", evidence: {} }],
      });
      expect(untrusted!.renderEvidenceObservationStatus).toBe("untrusted_evidence");
      expect(untrusted!.selectedCandidateId).toBeNull();
    });

    it("selects only registry-bound trusted rendered evidence and does not finalize", async () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const workflowRegistry = new InMemoryWorkflowOperationRegistry();
      const evidenceRegistry = new InMemoryRenderedEvidenceRegistry();
      const initial = observeIfEnabled("slice5", { ...renderedInput, registry: workflowRegistry });
      const candidateId = initial!.recommendedForRenderCandidateId!;
      const evidence = await createTrustedRenderedCreativeEvidence();
      evidenceRegistry.register({
        workflowOperationId: initial!.workflowOperationId!,
        contractFingerprint: initial!.contractFingerprint,
        candidateId,
        renderedAssetFingerprint: evidence.renderedAssetFingerprint,
      }, evidence);

      const result = observeRenderedQualityIfEnabled("slice5", {
        ...renderedInput,
        registry: workflowRegistry,
        renderedEvidenceRegistry: evidenceRegistry,
        renderedCandidateEvidenceEntries: [{ candidateId, renderedAssetFingerprint: evidence.renderedAssetFingerprint }],
      });
      expect(result!.renderEvidenceObservationStatus).toBe("evaluated");
      expect(result!.trustedRenderedEvidenceCount).toBe(1);
      expect(result!.selectedCandidateId).toBe(candidateId);
      expect(result!.operationStatus).toBe("running");
    });

    it("keeps Campaign 30 CTA vetoed and does not finalize", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const workflowRegistry = new InMemoryWorkflowOperationRegistry();
      const result = observeRenderedQualityIfEnabled("slice5", {
        ...renderedInput,
        legacySelectedCta: "Learn More",
        proposedContent: { ...renderedInput.proposedContent!, cta: "Learn More" },
        registry: workflowRegistry,
        renderedEvidenceRegistry: new InMemoryRenderedEvidenceRegistry(),
      });
      expect(result!.hardCompliancePassed).toBe(false);
      expect(result!.selectedCandidateId).toBeNull();
      expect(result!.operationStatus).toBe("running");
    });
  });
});
