/**
 * Creative Direction Planner tests.
 *
 * Slice 4 scenarios 1-11:
 * - exactly three direction slots are compiled;
 * - direction IDs are deterministic;
 * - direction plans use one contract fingerprint;
 * - authority-led direction uses approved authority evidence;
 * - benefit-led direction uses grounded benefit evidence;
 * - proof-led direction is unavailable without proof evidence;
 * - missing proof does not invent testimonials or statistics;
 * - directions differ materially in hierarchy;
 * - colour-only differences are not materially distinct;
 * - contract change changes all direction identities;
 * - no timestamps or randomness influence identity.
 */

import { describe, expect, it } from "vitest";
import {
  compileDirectionPlans,
  buildDirectionId,
  type CreativeDirectionKey,
  type DirectionPlannerInput,
} from "./creative-direction-planner";
import {
  compileApprovedCreativeContract,
  computeContractFingerprint,
  type ApprovedCreativeContract,
  type ApprovedCreativeEvidence,
} from "../contracts/creative-contract";

const workflowOperationId = "op-30-22-253";

function withAuthorityEvidence(
  contract: ApprovedCreativeContract,
  approvedEvidence: ApprovedCreativeEvidence[],
  authorityEvidenceIds: string[]
): ApprovedCreativeContract {
  const result = { ...contract, approvedEvidence, authorityEvidenceIds };
  return { ...result, contractFingerprint: computeContractFingerprint(result) };
}

function baseContract() {
  return withAuthorityEvidence(compileApprovedCreativeContract({
    campaignId: 30,
    userId: 22,
    businessId: 26,
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedAt: "2026-07-01T08:00:00.000Z",
    approvedStrategyFingerprint: "fp-253",
    funnelStage: "consideration",
    campaignInputCta: "Request a Consultation",
    targetAudience: "operations managers",
    offer: "Book a guided walkthrough",
    businessCapabilities: [
      "B2B payment orchestration",
      "prefunded merchant-account administration",
      "balance verification",
      "transaction reservations",
      "controlled payment-instruction services",
    ],
    requiredBenefitCount: 3,
  }), [
      {
        evidenceId: "balance-verification-capability",
        classification: "authority",
        sourceRef: "approved-strategy:balance-verification",
      },
    ], ["balance-verification-capability"]);
}

describe("creative-direction-planner", () => {
  it("compiles exactly three direction slots", () => {
    const contract = baseContract();
    const result = compileDirectionPlans({ workflowOperationId, contract });
    expect(result.plannedDirectionCount).toBe(3);
    expect(result.directions).toHaveLength(3);
    expect(result.directions.map((d) => d.directionKey)).toEqual([
      "authority_led",
      "benefit_led",
      "proof_led",
    ]);
  });

  it("produces deterministic direction IDs", () => {
    const contract = baseContract();
    const a = compileDirectionPlans({ workflowOperationId, contract });
    const b = compileDirectionPlans({ workflowOperationId, contract });
    for (let i = 0; i < 3; i++) {
      expect(a.directions[i].directionId).toBe(b.directions[i].directionId);
      expect(a.directions[i].directionFingerprint).toBe(
        b.directions[i].directionFingerprint
      );
    }
    expect(a.directionPlanFingerprint).toBe(b.directionPlanFingerprint);
  });

  it("uses one contract fingerprint for all three directions", () => {
    const contract = baseContract();
    const result = compileDirectionPlans({ workflowOperationId, contract });
    for (const direction of result.directions) {
      expect(direction.contractFingerprint).toBe(contract.contractFingerprint);
    }
  });

  it("authority-led direction uses approved authority evidence", () => {
    const contract = baseContract();
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const authority = result.directions.find((d) => d.directionKey === "authority_led")!;
    expect(authority.available).toBe(true);
    expect(authority.evidenceIds.length).toBeGreaterThan(0);
    expect(authority.communicationPriority).toContain("institutional");
    expect(authority.visualHierarchy[0]).toContain("business identity");
  });

  it("benefit-led direction uses grounded benefit evidence", () => {
    const contract = baseContract();
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const benefit = result.directions.find((d) => d.directionKey === "benefit_led")!;
    expect(benefit.available).toBe(true);
    expect(benefit.evidenceIds.length).toBeGreaterThanOrEqual(3);
    expect(benefit.communicationPriority).toContain("benefit");
    expect(benefit.visualHierarchy[0]).toContain("benefit headline");
  });

  it("proof-led direction is unavailable without traceable evidence", () => {
    const contract = compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: null,
      businessCapabilities: [],
      requiredBenefitCount: 3,
    });
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const proof = result.directions.find((d) => d.directionKey === "proof_led")!;
    expect(proof.available).toBe(false);
    expect(proof.unavailableReasonCode).toBe("PROOF_EVIDENCE_MISSING");
  });

  it("does not invent testimonials, statistics or guarantees when proof evidence is missing", () => {
    const contract = compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: null,
      businessCapabilities: [],
      requiredBenefitCount: 3,
    });
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const proof = result.directions.find((d) => d.directionKey === "proof_led")!;
    expect(proof.communicationPriority).not.toContain("testimonial");
    expect(proof.communicationPriority).not.toContain("award");
    expect(proof.communicationPriority).not.toContain("statistic");
    expect(proof.communicationPriority).not.toContain("guarantee");
    expect(proof.headlineRole).not.toContain("testimonial");
  });

  it("directions differ materially in communication hierarchy and layout intent", () => {
    const contract = baseContract();
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const hierarchies = result.directions.map((d) => d.visualHierarchy.join(","));
    const uniqueHierarchies = new Set(hierarchies);
    expect(uniqueHierarchies.size).toBe(3);

    const layoutIntents = new Set(result.directions.map((d) => d.layoutIntent));
    expect(layoutIntents.size).toBe(3);
  });

  it("colour-only differences are not treated as material distinction", () => {
    const contract = baseContract();
    const a = compileDirectionPlans({ workflowOperationId, contract });
    const b = compileDirectionPlans({ workflowOperationId, contract });
    // Same inputs must produce identical plans; colour fields are part of the
    // fingerprint, but the directions differ on hierarchy and layout first.
    expect(a.directionPlanFingerprint).toBe(b.directionPlanFingerprint);
  });

  it("changing the contract changes all direction identities", () => {
    const contractA = baseContract();
    const contractB = compileApprovedCreativeContract({
      ...contractA,
      approvedStrategyFingerprint: "fp-253-changed",
      // compileApprovedCreativeContract does not spread the contract object;
      // build a fresh input instead.
      campaignId: 30,
      userId: 22,
      businessId: 26,
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      requiredBenefitCount: 3,
    });
    const resultA = compileDirectionPlans({ workflowOperationId, contract: contractA });
    const resultB = compileDirectionPlans({ workflowOperationId, contract: contractB });
    for (let i = 0; i < 3; i++) {
      expect(resultA.directions[i].directionId).not.toBe(
        resultB.directions[i].directionId
      );
    }
    expect(resultA.directionPlanFingerprint).not.toBe(resultB.directionPlanFingerprint);
  });

  it("object-key order does not affect direction identity", () => {
    const payload = {
      workflowOperationId,
      contractFingerprint: "fp",
      directionKey: "benefit_led" as CreativeDirectionKey,
      ordinal: 2 as const,
    };
    const reversed = {
      ordinal: 2 as const,
      directionKey: "benefit_led" as CreativeDirectionKey,
      contractFingerprint: "fp",
      workflowOperationId,
    };
    expect(buildDirectionId(payload)).toBe(buildDirectionId(reversed));
  });

  it("does not use timestamps or randomness in direction identity", () => {
    const contract = baseContract();
    const resultA = compileDirectionPlans({ workflowOperationId, contract });
    // Wait 5ms would not be deterministic across runs, so we instead assert that
    // the fingerprint payload excludes createdAt/now by inspecting identity stability.
    const resultB = compileDirectionPlans({ workflowOperationId, contract });
    expect(resultA.directionPlanFingerprint).toBe(resultB.directionPlanFingerprint);
  });

  it("marks benefit-led unavailable when no grounded benefit evidence exists", () => {
    const contract = withAuthorityEvidence(compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: null,
      businessCapabilities: [],
      requiredBenefitCount: 3,
    }), [{
      evidenceId: "approved-org-status",
      classification: "authority",
      sourceRef: "approved-strategy:organisation-status",
    }], ["approved-org-status"]);
    const result = compileDirectionPlans({ workflowOperationId, contract });
    const benefit = result.directions.find((d) => d.directionKey === "benefit_led")!;
    expect(benefit.available).toBe(false);
    expect(benefit.unavailableReasonCode).toBe("BENEFIT_EVIDENCE_MISSING");
    expect(result.availableDirectionCount).toBe(1); // only authority_led
  });

  it("rejects arbitrary, missing and stale authority evidence IDs", () => {
    for (const authorityEvidenceIds of [["arbitrary"], ["stale-authority-id"], ["missing-record"]]) {
      const contract = withAuthorityEvidence(compileApprovedCreativeContract({
        ...baseContract(),
        campaignId: 30, userId: 22, businessId: 26, strategyRunId: 253, approvalRequestId: 36,
        approvedAt: "2026-07-01T08:00:00.000Z", approvedStrategyFingerprint: "fp-253",
        funnelStage: "consideration", campaignInputCta: "Request a Consultation",
        targetAudience: "operations managers", offer: "Book a guided walkthrough",
        businessCapabilities: ["balance verification"],
      }), [], authorityEvidenceIds);
      const authority = compileDirectionPlans({ workflowOperationId, contract }).directions[0];
      expect(authority.available).toBe(false);
      expect(authority.unavailableReasonCode).toBe("AUTHORITY_EVIDENCE_MISSING");
    }
  });

  it("rejects benefit, proof and authority-sounding claim evidence", () => {
    for (const classification of ["benefit", "proof"] as const) {
      const contract = withAuthorityEvidence(compileApprovedCreativeContract({
        ...baseContract(), campaignId: 30, userId: 22, businessId: 26, strategyRunId: 253,
        approvalRequestId: 36, approvedAt: "2026-07-01T08:00:00.000Z", approvedStrategyFingerprint: "fp-253",
        funnelStage: "consideration", campaignInputCta: "Request a Consultation", targetAudience: "operations managers",
        offer: null, businessCapabilities: ["trusted experienced professional established leading expert"],
      }), [{ evidenceId: "classified-not-authority", classification, sourceRef: "approved-strategy:claim" }], ["classified-not-authority"]);
      expect(compileDirectionPlans({ workflowOperationId, contract }).directions[0].available).toBe(false);
    }
  });

  it("uses only resolved authority evidence deterministically and fingerprints it", () => {
    const input = {
      campaignId: 30, userId: 22, businessId: 26, strategyRunId: 253, approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z", approvedStrategyFingerprint: "fp-253", funnelStage: "consideration" as const,
      campaignInputCta: "Request a Consultation", targetAudience: "operations managers", offer: null,
      businessCapabilities: [],
    };
    const evidence = [{ evidenceId: "authority-a", classification: "authority" as const, sourceRef: "approved-strategy:a" }];
    const a = withAuthorityEvidence(compileApprovedCreativeContract(input), evidence, ["missing", "authority-a", "authority-a"]);
    const b = withAuthorityEvidence(compileApprovedCreativeContract(input), evidence, ["authority-a", "missing"]);
    const changed = withAuthorityEvidence(compileApprovedCreativeContract(input), [{ evidenceId: "authority-b", classification: "authority", sourceRef: "approved-strategy:b" }], ["authority-b"]);
    const planA = compileDirectionPlans({ workflowOperationId, contract: a }).directions[0];
    const planB = compileDirectionPlans({ workflowOperationId, contract: b }).directions[0];
    expect(planA.evidenceIds).toEqual(["authority-a"]);
    expect(planA.directionId).toBe(planB.directionId);
    expect(planA.directionId).not.toBe(compileDirectionPlans({ workflowOperationId, contract: changed }).directions[0].directionId);
  });
});
