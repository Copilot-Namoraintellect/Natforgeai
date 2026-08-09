import { TRPCError } from "@trpc/server";
import type { CampaignMessagePack } from "../campaign-message-architect";
import type { CanaryApprovalProof } from "./contracts";
import {
  computeAssessmentHashSha256,
  computeSha256FromPayload,
  serializeCanonicalCopy,
} from "./hash";

export function verifyCanaryApprovalProof(
  pack: CampaignMessagePack,
  proof: CanaryApprovalProof
): void {
  if (!proof || !proof.candidate || !proof.assessment || !proof.contextLock || !proof.approvedMessagePack || !proof.envelope) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Canary approval proof is incomplete." });
  }

  const approved = proof.approvedMessagePack;
  const candidate = proof.candidate;
  const assessment = proof.assessment;
  const envelope = proof.envelope;

  const compatibilityCopy = {
    copySchemaVersion: approved.copy.copySchemaVersion,
    headline: pack.headline,
    subheadline: pack.subheadline,
    benefitBulletsOrdered: [...pack.benefitBullets],
    cta: pack.cta,
    footer: {
      phone: pack.footerContact?.phone ?? null,
      whatsapp: pack.footerContact?.whatsapp ?? null,
      email: pack.footerContact?.email ?? null,
      website: pack.footerContact?.website ?? null,
      location: pack.footerContact?.location ?? null,
    },
    proofPointsOrdered: Array.isArray(pack.proofPoints) ? [...pack.proofPoints] : [],
    platformCaptionsOrdered: Array.isArray(pack.platformCaptions)
      ? pack.platformCaptions.map((caption) => ({
          platform: caption.platform,
          caption: caption.caption,
          cta: caption.cta,
          hashtagsOrdered: Array.isArray(caption.hashtags) ? [...caption.hashtags] : [],
        }))
      : [],
  };

  const semanticMismatch =
    compatibilityCopy.copySchemaVersion !== approved.copy.copySchemaVersion ||
    compatibilityCopy.headline !== approved.copy.headline ||
    compatibilityCopy.subheadline !== approved.copy.subheadline ||
    compatibilityCopy.cta !== approved.copy.cta ||
    JSON.stringify(compatibilityCopy.benefitBulletsOrdered) !== JSON.stringify(approved.copy.benefitBulletsOrdered) ||
    JSON.stringify(compatibilityCopy.proofPointsOrdered) !== JSON.stringify(approved.copy.proofPointsOrdered) ||
    JSON.stringify(compatibilityCopy.platformCaptionsOrdered) !== JSON.stringify(approved.copy.platformCaptionsOrdered) ||
    JSON.stringify(compatibilityCopy.footer) !== JSON.stringify(approved.copy.footer);

  if (semanticMismatch) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Canary approval proof semantic mismatch." });
  }

  const compatibilityPayload = serializeCanonicalCopy(compatibilityCopy);
  const recomputedHash = computeSha256FromPayload(compatibilityPayload);
  if (
    recomputedHash !== candidate.copyHashSha256 ||
    recomputedHash !== approved.copyHashSha256 ||
    recomputedHash !== envelope.copyHashSha256
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Canary approval proof copy hash mismatch." });
  }

  const recomputedAssessmentHash = computeAssessmentHashSha256({
    assessmentId: assessment.assessmentId,
    candidateId: assessment.candidateId,
    copyHashSha256: assessment.copyHashSha256,
    businessDnaSnapshotId: assessment.businessDnaSnapshotId,
    evidenceHashSha256: assessment.evidenceHashSha256,
    campaignStrategySnapshotId: assessment.campaignStrategySnapshotId,
    strategyHashSha256: assessment.strategyHashSha256,
    policyId: assessment.policyId,
    policyVersion: assessment.policyVersion,
    policyHashSha256: assessment.policyHashSha256,
    decision: assessment.decision,
    hardIssues: assessment.hardIssues,
    warnings: assessment.warnings,
    score: assessment.score,
    evaluatedAtIso: assessment.evaluatedAtIso,
  });

  if (
    recomputedAssessmentHash !== assessment.assessmentHashSha256 ||
    recomputedAssessmentHash !== envelope.assessmentHashSha256
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Canary approval proof assessment hash mismatch." });
  }

  if (
    envelope.candidateId !== candidate.candidateId ||
    envelope.assessmentId !== assessment.assessmentId ||
    envelope.approvedRevisionId !== approved.approvedRevisionId ||
    envelope.businessDnaSnapshotId !== proof.contextLock.businessDnaSnapshotId ||
    envelope.evidenceHashSha256 !== proof.contextLock.evidenceHashSha256 ||
    envelope.campaignStrategySnapshotId !== proof.contextLock.campaignStrategySnapshotId ||
    envelope.strategyHashSha256 !== proof.contextLock.strategyHashSha256 ||
    envelope.policyId !== proof.contextLock.policyId ||
    envelope.policyVersion !== proof.contextLock.policyVersion ||
    envelope.policyHashSha256 !== proof.contextLock.policyHashSha256 ||
    assessment.decision !== "approved" ||
    assessment.hardIssues.length > 0 ||
    assessment.score < proof.contextLock.policy.minScoreForApproval
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Canary approval proof identity mismatch." });
  }
}
