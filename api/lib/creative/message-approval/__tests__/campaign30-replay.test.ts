import { describe, expect, it } from "vitest";
import { adaptLegacyMessagePack } from "../legacy-adapter";
import { evaluateMessageCandidate } from "../evaluator";
import { createApprovedMessagePack } from "../approve";
import {
  campaign30BusinessDna,
  campaign30Policy,
  campaign30ReplayCases,
  campaign30Strategy,
} from "../fixtures/campaign30";

function toLegacyFooter(footer: {
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly location: string | null;
}) {
  return {
    phone: footer.phone ?? undefined,
    whatsapp: footer.whatsapp ?? undefined,
    email: footer.email ?? undefined,
    website: footer.website ?? undefined,
    location: footer.location ?? undefined,
  };
}

describe("campaign30 replay", () => {
  it("replays all six deterministic fixture cases", () => {
    for (const replay of campaign30ReplayCases) {
      const candidate = adaptLegacyMessagePack({
        campaignId: 30,
        candidateId: `cand-${replay.caseId}`,
        createdAtIso: "2026-07-01T08:00:00.000Z",
        businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
        campaignStrategySnapshotId: campaign30Strategy.snapshotId,
        qualityPolicyId: campaign30Policy.policyId,
        qualityPolicyVersion: campaign30Policy.policyVersion,
        legacyPack: {
          headline: replay.copy.headline,
          subheadline: replay.copy.subheadline,
          benefitBullets: [...replay.copy.benefitBullets],
          cta: replay.copy.cta,
          footerContact: toLegacyFooter(replay.copy.footerContact),
          proofPoints: [],
          platformCaptions: [],
          validation: {
            passed: replay.legacyValidationPassed,
            score: replay.legacyValidationScore,
            rejections: [...replay.legacyValidationRejections],
            warnings: [],
          },
          messagePackSource: replay.source,
          isGeneric: replay.legacyIsGeneric,
        },
      });

      const assessment = evaluateMessageCandidate({
        assessmentId: `assess-${replay.caseId}`,
        evaluatedAtIso: "2026-07-01T08:01:00.000Z",
        candidate,
        businessDna: campaign30BusinessDna,
        campaignStrategy: campaign30Strategy,
        policy: campaign30Policy,
      });

      expect(assessment.decision, `case ${replay.caseId}`).toBe(replay.expectedDecision);
    }
  });

  it("CTA mutation changes hash and invalidates prior assessment approval", () => {
    const replay = campaign30ReplayCases.find((item) => item.caseId === "E");
    if (!replay) throw new Error("Missing case E");

    const baseCandidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-E-base",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
      campaignStrategySnapshotId: campaign30Strategy.snapshotId,
      qualityPolicyId: campaign30Policy.policyId,
      qualityPolicyVersion: campaign30Policy.policyVersion,
      legacyPack: {
        headline: replay.copy.headline,
        subheadline: replay.copy.subheadline,
        benefitBullets: [...replay.copy.benefitBullets],
        cta: "Learn More",
        footerContact: toLegacyFooter(replay.copy.footerContact),
        proofPoints: [],
        platformCaptions: [],
        validation: {
          passed: true,
          score: 90,
          rejections: [],
          warnings: [],
        },
        messagePackSource: replay.source,
        isGeneric: false,
      },
    });

    const mutatedCandidate = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-E-mutated",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
      campaignStrategySnapshotId: campaign30Strategy.snapshotId,
      qualityPolicyId: campaign30Policy.policyId,
      qualityPolicyVersion: campaign30Policy.policyVersion,
      legacyPack: {
        headline: replay.copy.headline,
        subheadline: replay.copy.subheadline,
        benefitBullets: [...replay.copy.benefitBullets],
        cta: "Schedule a Consultation",
        footerContact: toLegacyFooter(replay.copy.footerContact),
        proofPoints: [],
        platformCaptions: [],
        validation: {
          passed: true,
          score: 90,
          rejections: [],
          warnings: [],
        },
        messagePackSource: replay.source,
        isGeneric: false,
      },
    });

    expect(baseCandidate.copyHashSha256).not.toBe(mutatedCandidate.copyHashSha256);

    const approvedAssessment = evaluateMessageCandidate({
      assessmentId: "assess-E-base",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: baseCandidate,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-E",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: mutatedCandidate,
        assessment: approvedAssessment,
        policy: campaign30Policy,
      })
    ).toThrow(/Candidate ID mismatch|Copy hash mismatch/);
  });

  it("benefit mutation changes hash and guarded approval fails", () => {
    const replay = campaign30ReplayCases.find((item) => item.caseId === "F");
    if (!replay) throw new Error("Missing case F");

    const original = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-F-original",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
      campaignStrategySnapshotId: campaign30Strategy.snapshotId,
      qualityPolicyId: campaign30Policy.policyId,
      qualityPolicyVersion: campaign30Policy.policyVersion,
      legacyPack: {
        headline: replay.copy.headline,
        subheadline: replay.copy.subheadline,
        benefitBullets: [...replay.copy.benefitBullets],
        cta: replay.copy.cta,
        footerContact: toLegacyFooter(replay.copy.footerContact),
        proofPoints: [],
        platformCaptions: [],
        validation: {
          passed: true,
          score: 90,
          rejections: [],
          warnings: [],
        },
        messagePackSource: replay.source,
        isGeneric: false,
      },
    });

    const mutated = adaptLegacyMessagePack({
      campaignId: 30,
      candidateId: "cand-F-mutated",
      createdAtIso: "2026-07-01T08:00:00.000Z",
      businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
      campaignStrategySnapshotId: campaign30Strategy.snapshotId,
      qualityPolicyId: campaign30Policy.policyId,
      qualityPolicyVersion: campaign30Policy.policyVersion,
      legacyPack: {
        headline: replay.copy.headline,
        subheadline: replay.copy.subheadline,
        benefitBullets: [
          replay.copy.benefitBullets[0],
          "Supplier settlement tracking keeps records consistent every quarter.",
          replay.copy.benefitBullets[2],
        ],
        cta: replay.copy.cta,
        footerContact: toLegacyFooter(replay.copy.footerContact),
        proofPoints: [],
        platformCaptions: [],
        validation: {
          passed: true,
          score: 90,
          rejections: [],
          warnings: [],
        },
        messagePackSource: replay.source,
        isGeneric: false,
      },
    });

    expect(original.copyHashSha256).not.toBe(mutated.copyHashSha256);

    const originalAssessment = evaluateMessageCandidate({
      assessmentId: "assess-F-original",
      evaluatedAtIso: "2026-07-01T08:01:00.000Z",
      candidate: original,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
    });

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-F",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: mutated,
        assessment: originalAssessment,
        policy: campaign30Policy,
      })
    ).toThrow();
  });
});
