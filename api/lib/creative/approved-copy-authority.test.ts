import { describe, expect, it } from "vitest";

import type { CampaignMessagePack } from "./campaign-message-architect";
import {
  assertApprovedCopyMatchesEnvelope,
  assertApprovedCopyMatchesStrategyAuthority,
  assertApprovedRenderCopyUnchanged,
  captureApprovedCopyAuthority,
  computeCampaignMessagePackCopyHash,
  verifyApprovedCopyIntegrity,
  type ApprovedCopyAuthority,
} from "./approved-copy-authority";
import { buildCreativeStrategyAuthority } from "./strategy-authority";
import type { MessageApprovalContextLock } from "./message-approval/contracts";
import { createMessagePackCandidate } from "./message-approval/candidate";
import { evaluateMessageCandidate } from "./message-approval/evaluator";
import { createApprovedMessagePack } from "./message-approval/approve";
import { adaptApprovedToCampaignMessagePack } from "./message-approval/compatibility-adapter";
import {
  campaign30BusinessDna,
  campaign30Policy,
  campaign30ReplayCases,
  campaign30Strategy,
} from "./message-approval/fixtures/campaign30";
import { specificityScore } from "./campaign-message-architect";

function sha256Hex(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash.toString(16).padStart(8, "0")).repeat(8).slice(0, 64);
}

function buildContextLock(): MessageApprovalContextLock {
  return {
    contextLockId: "ctx-copy-authority-1",
    mode: "canary",
    campaignId: 30,
    businessDna: campaign30BusinessDna,
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    evidenceHashSha256: campaign30BusinessDna.evidenceHashSha256,
    campaignStrategy: campaign30Strategy,
    campaignStrategySnapshotId: campaign30Strategy.snapshotId,
    strategyHashSha256: campaign30Strategy.strategyHashSha256,
    policy: campaign30Policy,
    policyId: campaign30Policy.policyId,
    policyVersion: campaign30Policy.policyVersion,
    policyHashSha256: campaign30Policy.policyHashSha256,
    diagnostics: {
      contextSource: "legacy_loaded_context",
      contextReadyForComparison: true,
      missingContextFields: [],
    },
  };
}

function buildApprovedCanaryPack(): {
  pack: CampaignMessagePack;
  authority: ApprovedCopyAuthority;
} {
  const replay = campaign30ReplayCases.find((item) => item.caseId === "C");
  if (!replay) throw new Error("Missing approved replay fixture");

  const lock = buildContextLock();
  const candidate = createMessagePackCandidate({
    candidateId: "cand-copy-authority-1",
    campaignId: 30,
    createdAtIso: "2026-07-01T08:01:00.000Z",
    source: "ai_initial",
    copy: {
      copySchemaVersion: campaign30Policy.copySchemaVersion,
      headline: replay.copy.headline,
      subheadline: replay.copy.subheadline,
      benefitBulletsOrdered: replay.copy.benefitBullets,
      cta: replay.copy.cta,
      footer: { ...replay.copy.footerContact },
      proofPointsOrdered: ["Built for operations managers who need faster settlements"],
      platformCaptionsOrdered: [
        {
          platform: "instagram",
          caption: "Reduce payout delays for operations managers.",
          cta: "Learn More",
          hashtagsOrdered: ["#operations", "#payouts"],
        },
      ],
    },
    businessDnaSnapshotId: lock.businessDnaSnapshotId,
    evidenceHashSha256: lock.evidenceHashSha256,
    campaignStrategySnapshotId: lock.campaignStrategySnapshotId,
    strategyHashSha256: lock.strategyHashSha256,
    qualityPolicyId: lock.policyId,
    qualityPolicyVersion: lock.policyVersion,
    policyHashSha256: lock.policyHashSha256,
    provenance: {
      adaptedFromLegacy: true,
      originSource: "latest_message_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: false,
        legacyValidationPassed: true,
        legacyValidationScore: 95,
        legacyValidationRejections: [],
      },
    },
  });

  const assessment = evaluateMessageCandidate({
    assessmentId: "assess-copy-authority-1",
    evaluatedAtIso: "2026-07-01T08:02:00.000Z",
    candidate,
    businessDna: campaign30BusinessDna,
    campaignStrategy: campaign30Strategy,
    policy: campaign30Policy,
  });
  if (assessment.decision !== "approved") {
    throw new Error(
      `Fixture candidate must be approved, got ${assessment.decision}: ${JSON.stringify(assessment.hardIssues)}`
    );
  }

  const approved = createApprovedMessagePack({
    approvedRevisionId: "rev-copy-authority-1",
    approvedAtIso: "2026-07-01T08:03:00.000Z",
    candidate,
    assessment,
    policy: campaign30Policy,
  });

  const { pack } = adaptApprovedToCampaignMessagePack({
    approved,
    assessment,
    contextLock: lock,
    candidateSource: "ai_initial",
    specificityScore,
  });

  return { pack, authority: captureApprovedCopyAuthority(pack) };
}

describe("Approved Creative copy authority", () => {
  it("derives a deterministic pack hash equal to the approval envelope copy hash", () => {
    const { pack } = buildApprovedCanaryPack();

    const packHash = computeCampaignMessagePackCopyHash(pack);
    expect(packHash).toBe(pack.v2ApprovalEnvelope?.copyHashSha256);
    expect(packHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("captures every immutable approved-copy coordinate from the envelope", () => {
    const { pack, authority } = buildApprovedCanaryPack();
    const envelope = pack.v2ApprovalEnvelope!;

    expect(authority).toEqual({
      approvedRevisionId: envelope.approvedRevisionId,
      copyHashSha256: envelope.copyHashSha256,
      copySchemaVersion: envelope.copySchemaVersion,
      businessDnaSnapshotId: envelope.businessDnaSnapshotId,
      evidenceHashSha256: envelope.evidenceHashSha256,
      campaignStrategySnapshotId: envelope.campaignStrategySnapshotId,
      strategyHashSha256: envelope.strategyHashSha256,
      policyId: envelope.policyId,
      policyVersion: envelope.policyVersion,
      policyHashSha256: envelope.policyHashSha256,
      assessmentHashSha256: envelope.assessmentHashSha256,
      approvedAtIso: envelope.approvedAtIso,
      candidateSource: envelope.candidateSource,
    });

    expect(Object.isFrozen(authority)).toBe(true);
  });

  it("fails closed when capturing from a pack without an approval envelope", () => {
    const { pack } = buildApprovedCanaryPack();
    const legacyPack: CampaignMessagePack = { ...pack };
    delete legacyPack.v2ApprovalEnvelope;

    expect(() => captureApprovedCopyAuthority(legacyPack)).toThrow(/v2ApprovalEnvelope/);
    expect(() => assertApprovedCopyMatchesEnvelope(legacyPack)).toThrow(/v2ApprovalEnvelope/);
  });

  it("fails closed for malformed envelope authority coordinates", () => {
    const { pack } = buildApprovedCanaryPack();

    expect(() =>
      captureApprovedCopyAuthority({
        ...pack,
        v2ApprovalEnvelope: {
          ...pack.v2ApprovalEnvelope!,
          copyHashSha256: "stale",
        },
      })
    ).toThrow(/copyHashSha256/);

    expect(() =>
      captureApprovedCopyAuthority({
        ...pack,
        v2ApprovalEnvelope: {
          ...pack.v2ApprovalEnvelope!,
          approvedRevisionId: "",
        },
      })
    ).toThrow(/approvedRevisionId/);
  });

  it("verifies integrity for an unmodified approved pack", () => {
    const { pack, authority } = buildApprovedCanaryPack();

    expect(() => verifyApprovedCopyIntegrity(pack, authority)).not.toThrow();
    expect(computeCampaignMessagePackCopyHash(pack)).toBe(authority.copyHashSha256);
  });

  it.each([
    ["headline", (pack: CampaignMessagePack) => ({ ...pack, headline: "Rewritten headline" })],
    ["subheadline", (pack: CampaignMessagePack) => ({ ...pack, subheadline: "Rewritten subheadline" })],
    ["cta", (pack: CampaignMessagePack) => ({ ...pack, cta: "Buy Now" })],
    [
      "benefit bullets",
      (pack: CampaignMessagePack) => ({
        ...pack,
        benefitBullets: [...(pack.benefitBullets ?? []).slice(1)],
      }),
    ],
    [
      "proof points",
      (pack: CampaignMessagePack) => ({
        ...pack,
        proofPoints: ["Invented claim after approval"],
      }),
    ],
    [
      "platform caption",
      (pack: CampaignMessagePack) => ({
        ...pack,
        platformCaptions: (pack.platformCaptions ?? []).map((caption, index) =>
          index === 0
            ? { ...caption, caption: "Adapted caption that rewrites meaning" }
            : caption
        ),
      }),
    ],
    [
      "footer contact",
      (pack: CampaignMessagePack) => ({
        ...pack,
        footerContact: { ...pack.footerContact, phone: "011 555 0100" },
      }),
    ],
  ])("fails closed when approved %s changes after approval", (_label, mutate) => {
    const { pack, authority } = buildApprovedCanaryPack();
    const mutated = mutate(pack);

    expect(() => verifyApprovedCopyIntegrity(mutated, authority)).toThrow(/copyHashSha256/);
    expect(() => assertApprovedCopyMatchesEnvelope(mutated)).toThrow(/copyHashSha256/);
  });

  it("fails closed when envelope coordinates no longer match the authority", () => {
    const { pack, authority } = buildApprovedCanaryPack();
    const strategySwap = sha256Hex("different-strategy");

    const tampered: CampaignMessagePack = {
      ...pack,
      v2ApprovalEnvelope: {
        ...pack.v2ApprovalEnvelope!,
        strategyHashSha256: strategySwap,
      },
    };

    expect(() => verifyApprovedCopyIntegrity(tampered, authority)).toThrow(
      /envelope coordinates/
    );
  });

  it("binds approved-copy authority to the matching Strategy authority", () => {
    const { authority } = buildApprovedCanaryPack();

    const strategyAuthority = buildCreativeStrategyAuthority({
      status: "approved",
      strategySnapshotId: authority.campaignStrategySnapshotId,
      strategyVersion: 3,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
      strategyRunId: 501,
      approvalRequestId: 77,
      creativeBriefFingerprint: "brief-fingerprint-001",
    });

    expect(() =>
      assertApprovedCopyMatchesStrategyAuthority(authority, strategyAuthority)
    ).not.toThrow();
  });

  it("fails closed when Strategy authority does not match the approved copy", () => {
    const { authority } = buildApprovedCanaryPack();

    const alignedStrategy = {
      status: "approved",
      strategySnapshotId: authority.campaignStrategySnapshotId,
      strategyVersion: 3,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
      strategyRunId: 501,
      approvalRequestId: 77,
      creativeBriefFingerprint: "brief-fingerprint-001",
    };

    expect(() =>
      assertApprovedCopyMatchesStrategyAuthority(authority, {
        ...alignedStrategy,
        strategySnapshotId: "strategy-snapshot-other",
      } as any)
    ).toThrow(/strategy binding/);

    expect(() =>
      assertApprovedCopyMatchesStrategyAuthority(authority, {
        ...alignedStrategy,
        strategyHashSha256: sha256Hex("different-strategy"),
      } as any)
    ).toThrow(/strategy binding/);

    expect(() =>
      assertApprovedCopyMatchesStrategyAuthority(authority, {
        ...alignedStrategy,
        businessDnaSnapshotId: "bdna-other",
      } as any)
    ).toThrow(/strategy binding/);
  });

  it("allows render copy that exactly matches the approved pack", () => {
    const { pack, authority } = buildApprovedCanaryPack();

    expect(() =>
      assertApprovedRenderCopyUnchanged({
        renderCopy: {
          headline: pack.headline,
          subheadline: pack.subheadline,
          cta: pack.cta!,
          services: pack.benefitBullets ?? [],
        },
        pack,
        authority,
      })
    ).not.toThrow();
  });

  it("fails closed when render copy diverges from the approved pack", () => {
    const { pack, authority } = buildApprovedCanaryPack();
    const renderCopy = {
      headline: pack.headline,
      subheadline: pack.subheadline,
      cta: pack.cta!,
      services: pack.benefitBullets ?? [],
    };

    expect(() =>
      assertApprovedRenderCopyUnchanged({
        renderCopy: { ...renderCopy, headline: "LLM rewritten headline" },
        pack,
        authority,
      })
    ).toThrow(/headline changed after approval/);

    expect(() =>
      assertApprovedRenderCopyUnchanged({
        renderCopy: { ...renderCopy, cta: "Sign Up Today" },
        pack,
        authority,
      })
    ).toThrow(/cta changed after approval/);

    expect(() =>
      assertApprovedRenderCopyUnchanged({
        renderCopy: {
          ...renderCopy,
          services: ["Rewritten benefit"],
        },
        pack,
        authority,
      })
    ).toThrow(/benefit bullets changed after approval/);
  });

  it("permits legitimate fallbacks only where the approved pack supplies no value", () => {
    const { pack } = buildApprovedCanaryPack();
    const sparsePack: CampaignMessagePack = {
      ...pack,
      subheadline: "",
      cta: "",
      benefitBullets: [],
      v2ApprovalEnvelope: {
        ...pack.v2ApprovalEnvelope!,
        copyHashSha256: computeCampaignMessagePackCopyHash({
          ...pack,
          subheadline: "",
          cta: "",
          benefitBullets: [],
        }),
      },
    };
    const sparseAuthority = captureApprovedCopyAuthority(sparsePack);

    expect(() =>
      assertApprovedRenderCopyUnchanged({
        renderCopy: {
          headline: sparsePack.headline,
          subheadline: "Deterministic fallback subheadline",
          cta: "Learn More",
          services: ["Fallback bullet"],
        },
        pack: sparsePack,
        authority: sparseAuthority,
      })
    ).not.toThrow();
  });
});
