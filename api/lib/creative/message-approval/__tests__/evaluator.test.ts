import { describe, expect, it } from "vitest";
import { createMessagePackCandidate } from "../candidate";
import { evaluateMessageCandidate } from "../evaluator";
import { campaign30BusinessDna, campaign30Policy, campaign30Strategy } from "../fixtures/campaign30";

function buildCandidate(overrides?: Partial<Parameters<typeof createMessagePackCandidate>[0]>) {
  return createMessagePackCandidate({
    candidateId: "cand-eval-1",
    campaignId: 30,
    createdAtIso: "2026-07-01T08:00:00.000Z",
    source: "ai_refined",
    copy: {
      copySchemaVersion: campaign30Policy.copySchemaVersion,
      headline: "Reduce payout delays for operations managers",
      subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
      benefitBulletsOrdered: [
        "Payout automation cuts manual reconciliation by 2 hours per day.",
        "Supplier settlement tracking keeps audit records clear.",
        "Restaurant team payouts process faster with automated disbursements.",
      ],
      cta: "Learn More",
      footer: null,
    },
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    campaignStrategySnapshotId: campaign30Strategy.snapshotId,
    qualityPolicyId: campaign30Policy.policyId,
    qualityPolicyVersion: campaign30Policy.policyVersion,
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
    ...overrides,
  });
}

describe("evaluateMessageCandidate", () => {
  it("approves specific grounded copy", () => {
    const assessment = evaluateMessageCandidate({
      assessmentId: "assess-1",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate(),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(assessment.decision).toBe("approved");
  });

  it("rejects generic copy and placeholder language", () => {
    const candidate = buildCandidate({
      copy: {
        copySchemaVersion: campaign30Policy.copySchemaVersion,
        headline: "Transform your business",
        subheadline: "Unlock success for your business.",
        benefitBulletsOrdered: ["Best outcomes", "Great solutions", "Any company can use this"],
        cta: "Learn More",
        footer: null,
      },
    });

    const assessment = evaluateMessageCandidate({
      assessmentId: "assess-2",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(assessment.decision).toBe("rejected");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("GENERIC_LANGUAGE_DETECTED");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("PLACEHOLDER_LANGUAGE_DETECTED");
  });

  it("rejects missing product grounding and prohibited claims", () => {
    const candidate = buildCandidate({
      copy: {
        copySchemaVersion: campaign30Policy.copySchemaVersion,
        headline: "Guaranteed instant wealth for teams",
        subheadline: "The best in the world option for growth.",
        benefitBulletsOrdered: ["Great outcomes", "Fast results", "Amazing support"],
        cta: "Learn More",
        footer: null,
      },
    });

    const assessment = evaluateMessageCandidate({
      assessmentId: "assess-3",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(assessment.decision).toBe("rejected");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("PRODUCT_GROUNDING_MISSING");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("PROHIBITED_CLAIM_PRESENT");
  });

  it("supports exact CTA policy pass and mismatch rejection", () => {
    const approved = evaluateMessageCandidate({
      assessmentId: "assess-4",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate(),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });
    expect(approved.decision).toBe("approved");

    const rejected = evaluateMessageCandidate({
      assessmentId: "assess-5",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate({
        copy: {
          copySchemaVersion: campaign30Policy.copySchemaVersion,
          headline: "Reduce payout delays for operations managers",
          subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
          benefitBulletsOrdered: [
            "Payout automation cuts manual reconciliation by 2 hours per day.",
            "Supplier settlement tracking keeps audit records clear.",
            "Restaurant team payouts process faster with automated disbursements.",
          ],
          cta: "Schedule a Consultation",
          footer: null,
        },
      }),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(rejected.decision).toBe("rejected");
    expect(rejected.hardIssues.map((i) => i.code)).toContain("CTA_POLICY_MISMATCH");
  });

  it("supports allowed-set and semantic-intent CTA behavior", () => {
    const allowedPolicy = {
      ...campaign30Strategy,
      ctaPolicy: { mode: "allowed_set", allowedCtas: ["Learn More", "Book a Demo"] } as const,
    };

    const allowed = evaluateMessageCandidate({
      assessmentId: "assess-6",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate({
        copy: {
          copySchemaVersion: campaign30Policy.copySchemaVersion,
          headline: "Reduce payout delays for operations managers",
          subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
          benefitBulletsOrdered: [
            "Payout automation cuts manual reconciliation by 2 hours per day.",
            "Supplier settlement tracking keeps audit records clear.",
            "Restaurant team payouts process faster with automated disbursements.",
          ],
          cta: "Book a Demo",
          footer: null,
        },
      }),
      businessDna: campaign30BusinessDna,
      campaignStrategy: allowedPolicy,
      policy: campaign30Policy,
    });
    expect(allowed.decision).toBe("approved");

    const semanticPolicy = {
      ...campaign30Strategy,
      ctaPolicy: {
        mode: "semantic_intent",
        requiredIntent: "discovery",
        intentKeywords: ["learn", "discover"],
      } as const,
    };

    const semantic = evaluateMessageCandidate({
      assessmentId: "assess-7",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate(),
      businessDna: campaign30BusinessDna,
      campaignStrategy: semanticPolicy,
      policy: campaign30Policy,
    });
    expect(semantic.decision).toBe("approved");
  });

  it("caps score below threshold when hard issue exists", () => {
    const assessment = evaluateMessageCandidate({
      assessmentId: "assess-8",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate({
        copy: {
          copySchemaVersion: campaign30Policy.copySchemaVersion,
          headline: "Great solutions for everyone",
          subheadline: "Generic words only",
          benefitBulletsOrdered: ["Great", "Amazing", "Best"],
          cta: "Learn More",
          footer: null,
        },
      }),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(assessment.decision).toBe("rejected");
    expect(assessment.score).toBeLessThan(campaign30Policy.minScoreForApproval);
  });

  it("is source-neutral across ai_refined and deterministic_fallback", () => {
    const aiAssessment = evaluateMessageCandidate({
      assessmentId: "assess-9",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate({ source: "ai_refined" }),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    const fallbackAssessment = evaluateMessageCandidate({
      assessmentId: "assess-10",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: buildCandidate({ source: "deterministic_fallback" }),
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(aiAssessment.decision).toBe(fallbackAssessment.decision);
    expect(aiAssessment.score).toBe(fallbackAssessment.score);
  });
});
