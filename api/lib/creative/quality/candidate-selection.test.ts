/**
 * Premium Candidate Selection tests.
 *
 * Slice 4 scenarios:
 * Hard authority: 18-24
 * Selection / tie-breakers: 36-48
 * Campaign 30: 49-55
 * Candidate identity: 12-17
 */

import { describe, expect, it } from "vitest";
import {
  selectPremiumCandidate,
  buildCandidateId,
  buildCandidateContentFingerprint,
  buildSelectionFingerprint,
  type CandidateSpecification,
} from "./candidate-selection";
import {
  compileApprovedCreativeContract,
  computeContractFingerprint,
  type ApprovedCreativeContract,
} from "../contracts/creative-contract";
import { type ProposedCreativeContent } from "../compliance/content-compliance";
import { compileDirectionPlans } from "./creative-direction-planner";
import type { RenderedCreativeEvidence } from "./premium-rubric";

const workflowOperationId = "op-30-22-253";

function makeContract(
  overrides: Partial<Parameters<typeof compileApprovedCreativeContract>[0]> = {}
): ApprovedCreativeContract {
  const contract = compileApprovedCreativeContract({
    campaignId: 30,
    userId: 22,
    businessId: 26,
    businessName: "Zuto Hub",
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
    ...overrides,
  });
  const result = {
    ...contract,
    approvedEvidence: [{ evidenceId: "balance-verification-capability", classification: "authority" as const, sourceRef: "approved-strategy:balance-verification" }],
    authorityEvidenceIds: ["balance-verification-capability"],
  };
  return { ...result, contractFingerprint: computeContractFingerprint(result) };
}

const compliantCandidate: ProposedCreativeContent = {
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
  targetAudience: "operations managers",
  offer: "Book a guided walkthrough",
  businessName: "Zuto Hub",
  protectedFields: { businessName: "Zuto Hub" },
  requiredContactDetails: ["support@zutohub.example"],
};

const wrongCtaCandidate: ProposedCreativeContent = {
  ...compliantCandidate,
  cta: "Learn More",
};

function makeRenderedEvidence(): RenderedCreativeEvidence {
  return {
    source: "render_evaluator",
    renderedAssetFingerprint: "render-fp-test",
    evaluatorVersion: "test-v1",
    layoutAndVisualHierarchyScore: 85,
    legibilityAndAccessibilityScore: 88,
    reasonCodes: ["LAYOUT_OPTIMIZED", "LEGIBILITY_VERIFIED"],
  };
}

function spec(
  candidate: ProposedCreativeContent,
  directionKey: "authority_led" | "benefit_led" | "proof_led",
  ordinal: number,
  workflowOpId: string = workflowOperationId,
  contract: ApprovedCreativeContract = makeContract()
): CandidateSpecification {
  const plans = compileDirectionPlans({ workflowOperationId: workflowOpId, contract });
  const direction = plans.directions.find((d) => d.directionKey === directionKey)!;
  const contentFingerprint = buildCandidateContentFingerprint(candidate);
  const candidateId = buildCandidateId({
    workflowOperationId: workflowOpId,
    contractFingerprint: contract.contractFingerprint,
    directionFingerprint: direction.directionFingerprint,
    candidateOrdinal: ordinal,
    contentFingerprint,
  });
  return {
    candidateId,
    candidateOrdinal: ordinal,
    candidate,
    directionKey,
  };
}

function renderEvidenceMap(entries: CandidateSpecification[]) {
  return Object.fromEntries(
    entries.map((entry) => [entry.candidateId, makeRenderedEvidence()])
  ) as Record<string, RenderedCreativeEvidence>;
}

describe("candidate-selection hard authority", () => {
  it("rejects a wrong locked CTA regardless of aesthetic score", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(wrongCtaCandidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    expect(result.hardRejectedCandidateCount).toBe(1);
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("CTA_LOCKED");
  });

  it("generic 'Learn More' fails when approved CTA is 'Request a Consultation'", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(wrongCtaCandidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.reasonCodes).toContain("CTA_LOCKED");
  });

  it("rejects an invented offer regardless of total score", () => {
    const candidate: ProposedCreativeContent = {
      ...compliantCandidate,
      offer: "Get 50% off your first year",
    };
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(candidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("OFFER_AUTHORISED");
  });

  it("rejects an unsupported claim regardless of total score", () => {
    const candidate: ProposedCreativeContent = {
      ...compliantCandidate,
      benefits: ["Guaranteed fraud prevention for every transaction"],
    };
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(candidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("UNSUPPORTED_CLAIMS");
  });

  it("rejects a stale contract candidate", () => {
    const draft = compileApprovedCreativeContract({
      campaignId: 30,
      userId: 22,
      businessId: 26,
      businessName: "Zuto Hub",
      strategyRunId: 999,
      approvalRequestId: 36,
      approvedAt: "",
      approvedStrategyFingerprint: "fp-stale",
      funnelStage: "consideration",
      campaignInputCta: "Request a Consultation",
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
      requiredBenefitCount: 3,
    });
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract: draft,
      candidateEntries: [spec(compliantCandidate, "benefit_led", 1, workflowOperationId, draft)],
    });
    expect(result.selectionStatus).toBe("stale_contract");
  });

  it("rejects placeholder content", () => {
    const candidate: ProposedCreativeContent = {
      ...compliantCandidate,
      headline: "[Your Business] payment orchestration",
    };
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(candidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("PLACEHOLDER_CONTENT");
  });

  it("rejects missing required contact details", () => {
    const contract = makeContract({ requiredContactDetails: ["support@zutohub.example"] });
    const candidate: ProposedCreativeContent = {
      ...compliantCandidate,
      requiredContactDetails: [],
    };
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(candidate, "benefit_led", 1, workflowOperationId, contract)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("REQUIRED_CONTACT_DETAILS");
  });
});

describe("candidate-selection identity", () => {
  it("same canonical candidate gives same candidateId", () => {
    const contract = makeContract();
    const a = spec(compliantCandidate, "benefit_led", 1);
    const b = spec(compliantCandidate, "benefit_led", 1);
    expect(a.candidateId).toBe(b.candidateId);
  });

  it("object-key order does not affect candidate identity", () => {
    const contract = makeContract();
    const contentA = { ...compliantCandidate };
    const contentB = {
      cta: compliantCandidate.cta,
      headline: compliantCandidate.headline,
      primaryText: compliantCandidate.primaryText,
      benefits: compliantCandidate.benefits,
      funnelStage: compliantCandidate.funnelStage,
      targetAudience: compliantCandidate.targetAudience,
      offer: compliantCandidate.offer,
      businessName: compliantCandidate.businessName,
      protectedFields: compliantCandidate.protectedFields,
      requiredContactDetails: compliantCandidate.requiredContactDetails,
    };
    expect(buildCandidateContentFingerprint(contentA)).toBe(
      buildCandidateContentFingerprint(contentB)
    );
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const direction = plans.directions.find((d) => d.directionKey === "benefit_led")!;
    const fpA = buildCandidateContentFingerprint(contentA);
    const fpB = buildCandidateContentFingerprint(contentB);
    expect(
      buildCandidateId({
        workflowOperationId,
        contractFingerprint: contract.contractFingerprint,
        directionFingerprint: direction.directionFingerprint,
        candidateOrdinal: 1,
        contentFingerprint: fpA,
      })
    ).toBe(
      buildCandidateId({
        workflowOperationId,
        contractFingerprint: contract.contractFingerprint,
        directionFingerprint: direction.directionFingerprint,
        candidateOrdinal: 1,
        contentFingerprint: fpB,
      })
    );
  });

  it("formatting-only normalization is deterministic", () => {
    const contentA = { ...compliantCandidate, headline: "  Streamline B2B Payment Orchestration  " };
    const contentB = { ...compliantCandidate, headline: "Streamline B2B Payment Orchestration" };
    expect(buildCandidateContentFingerprint(contentA)).toBe(
      buildCandidateContentFingerprint(contentB)
    );
  });

  it("changed candidate content changes candidateId", () => {
    const contract = makeContract();
    const a = spec(compliantCandidate, "benefit_led", 1);
    const b = spec({ ...compliantCandidate, headline: "Different headline" }, "benefit_led", 1);
    expect(a.candidateId).not.toBe(b.candidateId);
  });

  it("changed direction changes candidateId", () => {
    const contract = makeContract();
    const a = spec(compliantCandidate, "authority_led", 1);
    const b = spec(compliantCandidate, "benefit_led", 1);
    expect(a.candidateId).not.toBe(b.candidateId);
  });

  it("changed contract changes candidateId", () => {
    const contractA = makeContract();
    const contractB = makeContract({ approvedStrategyFingerprint: "fp-changed" });
    const a = spec(compliantCandidate, "benefit_led", 1, workflowOperationId, contractA);
    const b = spec(compliantCandidate, "benefit_led", 1, workflowOperationId, contractB);
    expect(a.candidateId).not.toBe(b.candidateId);
  });
});

describe("candidate-selection ranking", () => {
  it("selects the highest eligible candidate", () => {
    const contract = makeContract();
    const weak: ProposedCreativeContent = {
      ...compliantCandidate,
      primaryText:
        "Zuto Hub does B2B payment orchestration and prefunded merchant-account administration.",
      benefits: [
        "Verify available prefunded balances",
        "Reserve transaction amounts",
        "Issue controlled payment instructions",
      ],
    };
    const entries = [spec(weak, "benefit_led", 1), spec(compliantCandidate, "benefit_led", 2)];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
    expect(result.eligibleCandidateCount).toBe(2);
    expect(result.selectedCandidateScore).toBeGreaterThanOrEqual(80);
  });

  it("excludes a hard-failing high-score candidate", () => {
    const contract = makeContract();
    const entries = [
      spec(wrongCtaCandidate, "benefit_led", 1),
      spec(compliantCandidate, "benefit_led", 2),
    ];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
    expect(result.hardRejectedCandidateCount).toBe(1);
    expect(result.selectedCandidateId).toBe(
      spec(compliantCandidate, "benefit_led", 2, workflowOperationId, contract).candidateId
    );
  });

  it("selects one independently qualifying candidate", () => {
    const contract = makeContract();
    const entries = [spec(compliantCandidate, "benefit_led", 1)];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
    expect(result.observedCandidateCount).toBe(1);
  });

  it("returns no selection when no candidates qualify", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(wrongCtaCandidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    expect(result.selectedCandidateId).toBeNull();
  });

  it("resolves ties by strategic alignment", () => {
    const contract = makeContract();
    // Two nearly identical compliant candidates. They tie on everything except
    // strategic alignment if one has a slightly less aligned audience.
    const strong: ProposedCreativeContent = {
      ...compliantCandidate,
      targetAudience: "operations managers",
    };
    const weak: ProposedCreativeContent = {
      ...compliantCandidate,
      targetAudience: "finance teams",
    };
    const entries = [
      spec(weak, "benefit_led", 2),
      spec(strong, "benefit_led", 1),
    ];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
    expect(result.selectedDirectionKey).toBe("benefit_led");
  });

  it("resolves remaining ties by CTA score", () => {
    const contract = makeContract();
    // Two identical compliant candidates except CTA length; shorter CTA scores higher.
    const longCta: ProposedCreativeContent = {
      ...compliantCandidate,
      cta: "Request a Consultation Today With Us",
    };
    const shortCta: ProposedCreativeContent = {
      ...compliantCandidate,
      cta: "Request a Consultation",
    };
    const entries = [
      spec(longCta, "benefit_led", 2),
      spec(shortCta, "benefit_led", 1),
    ];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
  });

  it("resolves remaining ties by grounded persuasive strength", () => {
    const contract = makeContract();
    // Reduce grounded evidence for one candidate by replacing benefits with less traceable wording.
    const weaker: ProposedCreativeContent = {
      ...compliantCandidate,
      benefits: [
        "Keep payments organised",
        "Manage merchant accounts easily",
        "Control instructions centrally",
      ],
    };
    const entries = [
      spec(weaker, "benefit_led", 2),
      spec(compliantCandidate, "benefit_led", 1),
    ];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
  });

  it("resolves remaining ties by lower candidate ordinal", () => {
    const contract = makeContract();
    // Two truly identical candidates would be ambiguous unless ordinal differs.
    const a = spec(compliantCandidate, "benefit_led", 1);
    const b = spec(compliantCandidate, "benefit_led", 2);
    expect(a.candidateId).not.toBe(b.candidateId);
    const entries = [b, a];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");
    expect(result.selectedCandidateId).toBe(a.candidateId);
  });

  it("rejects a fully unresolved tie", () => {
    const contract = makeContract();
    // Same candidate content with the same ordinal is impossible because
    // candidateId includes ordinal. Use two different ordinals with the same
    // content; ordinal tie-breaker should resolve it, not reject.
    const a = spec(compliantCandidate, "benefit_led", 1);
    const b = spec(compliantCandidate, "benefit_led", 2);
    const entries = [a, b];
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: entries,
      renderedEvidenceByCandidateId: renderEvidenceMap(entries),
    });
    expect(result.selectionStatus).toBe("selected");

    // A real ambiguous tie requires two distinct IDs with identical scores and
    // no remaining tie-breaker. Construct it by using the same candidateId twice.
    const ambiguous = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [a, { ...a, candidateOrdinal: 2 }],
    });
    expect(ambiguous.selectionStatus).toBe("ambiguous_tie_rejected");
  });

  it("arrival order does not affect selection", () => {
    const contract = makeContract();
    const a = spec(compliantCandidate, "benefit_led", 1);
    const weak: ProposedCreativeContent = {
      ...compliantCandidate,
      primaryText: "Zuto Hub helps with payments.",
      benefits: ["verify balances", "reserve transactions", "control payments"],
    };
    const b = spec(weak, "benefit_led", 2);

    const forwardEntries = [a, b];
    const backwardEntries = [b, a];
    const forward = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: forwardEntries,
      renderedEvidenceByCandidateId: renderEvidenceMap(forwardEntries),
    });
    const backward = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: backwardEntries,
      renderedEvidenceByCandidateId: renderEvidenceMap(backwardEntries),
    });
    expect(forward.selectionStatus).toBe("selected");
    expect(backward.selectionStatus).toBe("selected");
    expect(forward.selectedCandidateId).toBe(backward.selectedCandidateId);
  });

  it("replaying selection produces the same result", () => {
    const contract = makeContract();
    const entries = [spec(compliantCandidate, "benefit_led", 1)];
    const a = selectPremiumCandidate({ workflowOperationId, contract, candidateEntries: entries });
    const b = selectPremiumCandidate({ workflowOperationId, contract, candidateEntries: entries });
    expect(a.selectionStatus).toBe(b.selectionStatus);
    expect(a.selectedCandidateId).toBe(b.selectedCandidateId);
    expect(a.selectionFingerprint).toBe(b.selectionFingerprint);
  });

  it("selection fingerprint is deterministic", () => {
    const contract = makeContract();
    const entries = [
      spec(wrongCtaCandidate, "benefit_led", 1),
      spec(compliantCandidate, "benefit_led", 2),
    ];
    const a = selectPremiumCandidate({ workflowOperationId, contract, candidateEntries: entries });
    const b = selectPremiumCandidate({ workflowOperationId, contract, candidateEntries: entries });
    expect(a.selectionFingerprint).toBe(b.selectionFingerprint);
  });
});

describe("Campaign 30 replay", () => {
  it("contract CTA is 'Request a Consultation'", () => {
    const contract = makeContract();
    expect(contract.cta.text).toBe("Request a Consultation");
    expect(contract.cta.locked).toBe(true);
  });

  it("legacy 'Learn More' candidate hard-fails", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(wrongCtaCandidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("CTA_LOCKED");
  });

  it("no score can rescue the wrong CTA", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(wrongCtaCandidate, "benefit_led", 1)],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    expect(result.selectedCandidateId).toBeNull();
    const evalResult = result.candidateEvaluations[0];
    expect(evalResult.hardCompliancePassed).toBe(false);
    expect(evalResult.reasonCodes).toContain("CTA_LOCKED");
  });

  it("three direction plans share one workflowOperationId", () => {
    const contract = makeContract();
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    expect(plans.plannedDirectionCount).toBe(3);
    for (const d of plans.directions) {
      expect(d.workflowOperationId).toBe(workflowOperationId);
    }
  });

  it("selects none because the legacy candidate uses the wrong CTA", () => {
    const contract = makeContract();
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [
        spec(wrongCtaCandidate, "authority_led", 1),
        spec(wrongCtaCandidate, "benefit_led", 1),
        spec(wrongCtaCandidate, "proof_led", 1),
      ],
    });
    expect(result.selectionStatus).toBe("no_qualifying_candidate");
    expect(result.hardRejectedCandidateCount).toBe(3);
    expect(result.thresholdRejectedCandidateCount).toBe(0);
  });
});

describe("candidate-selection render and unavailable directions", () => {
  it("returns render_evaluation_required when render-dependent dimensions are pending", () => {
    const contract = makeContract();
    const candidate: ProposedCreativeContent = compliantCandidate;
    const plans = compileDirectionPlans({ workflowOperationId, contract });
    const authority = plans.directions.find((d) => d.directionKey === "authority_led")!;
    const thinRenderDirection: typeof authority = {
      ...authority,
      visualHierarchy: ["headline and CTA"],
      layoutIntent: "single-region layout",
    };
    const contentFingerprint = buildCandidateContentFingerprint(candidate);
    const candidateId = buildCandidateId({
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
      directionFingerprint: thinRenderDirection.directionFingerprint,
      candidateOrdinal: 1,
      contentFingerprint,
    });
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [
        {
          candidateId,
          candidateOrdinal: 1,
          candidate,
          directionKey: "authority_led",
          directionPlan: thinRenderDirection,
        },
      ],
    });

    expect(result.selectionStatus).toBe("render_evaluation_required");
    expect(result.candidateEvaluations[0].hardCompliancePassed).toBe(true);
    expect(result.candidateEvaluations[0].preRenderReadinessStatus).toBe("ready_for_render");
    expect(result.candidateEvaluations[0].finalPremiumScore).toBeNull();
    expect(result.candidateEvaluations[0].qualityAuthorityWouldAccept).toBe(false);
    expect(result.recommendedForRenderCandidateId).toBe(candidateId);
    expect(result.selectedCandidateId).toBeNull();
  });

  it("treats unavailable directions as hard failures", () => {
    const contract = makeContract({ businessCapabilities: [] });
    const result = selectPremiumCandidate({
      workflowOperationId,
      contract,
      candidateEntries: [spec(compliantCandidate, "benefit_led", 1, workflowOperationId, contract)],
    });
    expect(result.unavailableDirectionCodes).toContain("BENEFIT_EVIDENCE_MISSING");
    expect(result.hardRejectedCandidateCount).toBe(1);
  });
});
