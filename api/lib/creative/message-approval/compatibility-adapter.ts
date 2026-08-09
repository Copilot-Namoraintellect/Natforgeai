import type { CampaignMessagePack, MessagePackSource, PlatformCaption } from "../campaign-message-architect";
import type {
  ApprovedMessagePack,
  CanaryApprovalProof,
  MessageApprovalContextLock,
  MessageAssessment,
  V2ApprovalEnvelope,
} from "./contracts";

function toLegacySource(candidateSource: V2ApprovalEnvelope["candidateSource"]): MessagePackSource {
  switch (candidateSource) {
    case "ai_initial":
    case "ai_refined":
      return "ai_refined_pack";
    case "deterministic_fallback":
      return "fallback_deterministic";
    case "user_structured":
      return "user_structured_copy";
    case "existing_approved":
      return "latest_message_pack";
    case "diagnostic_fixture":
      // Diagnostic fixtures are in-memory only. Map to the nearest truthful
      // legacy source for type completeness; they must never be persisted.
      return "user_structured_copy";
    default:
      return "latest_message_pack";
  }
}

export function buildV2ApprovalEnvelope(input: {
  contextLock: MessageApprovalContextLock;
  approved: ApprovedMessagePack;
  candidateSource: V2ApprovalEnvelope["candidateSource"];
  assessment: MessageAssessment;
}): V2ApprovalEnvelope {
  return Object.freeze({
    schemaVersion: "v2.1",
    approvalMode: input.contextLock.mode,
    contextLockId: input.contextLock.contextLockId,
    approvedRevisionId: input.approved.approvedRevisionId,
    candidateId: input.approved.candidateId,
    assessmentId: input.approved.assessmentId,
    assessmentHashSha256: input.approved.assessmentHashSha256,
    copyHashSha256: input.approved.copyHashSha256,
    copySchemaVersion: input.approved.copy.copySchemaVersion,
    businessDnaSnapshotId: input.approved.businessDnaSnapshotId,
    evidenceHashSha256: input.approved.evidenceHashSha256,
    campaignStrategySnapshotId: input.approved.campaignStrategySnapshotId,
    strategyHashSha256: input.approved.strategyHashSha256,
    policyId: input.approved.policyId,
    policyVersion: input.approved.policyVersion,
    policyHashSha256: input.approved.policyHashSha256,
    approvedAtIso: input.approved.approvedAtIso,
    candidateSource: input.candidateSource,
    sourceProvenance: input.approved.sourceProvenance,
    decision: input.assessment.decision,
    score: input.assessment.score,
    hardIssueCodes: Object.freeze(input.assessment.hardIssues.map((issue) => issue.code)),
    warningCodes: Object.freeze(input.assessment.warnings.map((issue) => issue.code)),
  });
}

export function adaptApprovedToCampaignMessagePack(input: {
  approved: ApprovedMessagePack;
  assessment: MessageAssessment;
  contextLock: MessageApprovalContextLock;
  candidateSource: V2ApprovalEnvelope["candidateSource"];
  specificityScore: (pack: CampaignMessagePack) => number;
}): { pack: CampaignMessagePack; envelope: V2ApprovalEnvelope; proof: CanaryApprovalProof } {
  const platformCaptions: PlatformCaption[] = input.approved.copy.platformCaptionsOrdered.map((caption) => ({
    platform: caption.platform,
    caption: caption.caption,
    cta: caption.cta,
    hashtags: [...caption.hashtagsOrdered],
  }));

  const envelope = buildV2ApprovalEnvelope({
    contextLock: input.contextLock,
    approved: input.approved,
    candidateSource: input.candidateSource,
    assessment: input.assessment,
  });

  const basePack: CampaignMessagePack = {
    headline: input.approved.copy.headline,
    subheadline: input.approved.copy.subheadline,
    benefitBullets: [...input.approved.copy.benefitBulletsOrdered],
    cta: input.approved.copy.cta,
    footerContact: {
      phone: input.approved.copy.footer?.phone ?? undefined,
      whatsapp: input.approved.copy.footer?.whatsapp ?? undefined,
      email: input.approved.copy.footer?.email ?? undefined,
      website: input.approved.copy.footer?.website ?? undefined,
      location: input.approved.copy.footer?.location ?? undefined,
    },
    proofPoints: [...input.approved.copy.proofPointsOrdered],
    platformCaptions,
    validation: {
      passed: input.assessment.decision === "approved",
      score: input.assessment.score,
      rejections: input.assessment.hardIssues.map((issue) => issue.message),
      warnings: input.assessment.warnings.map((issue) => issue.message),
    },
    messagePackSource: toLegacySource(input.candidateSource),
    isGeneric: input.assessment.hardIssues.some((issue) =>
      issue.code.includes("GENERIC") || issue.code.includes("PLACEHOLDER")
    ),
  };

  const pack: CampaignMessagePack = {
    ...basePack,
    specificityScore: input.specificityScore(basePack),
    v2ApprovalEnvelope: envelope,
  };

  const proof: CanaryApprovalProof = Object.freeze({
    contextLock: input.contextLock,
    candidate: {
      candidateId: input.approved.candidateId,
      campaignId: input.contextLock.campaignId,
      createdAtIso: input.approved.approvedAtIso,
      source: input.candidateSource,
      copy: input.approved.copy,
      copyHashSha256: input.approved.copyHashSha256,
      businessDnaSnapshotId: input.approved.businessDnaSnapshotId,
      evidenceHashSha256: input.approved.evidenceHashSha256,
      campaignStrategySnapshotId: input.approved.campaignStrategySnapshotId,
      strategyHashSha256: input.approved.strategyHashSha256,
      qualityPolicyId: input.approved.policyId,
      qualityPolicyVersion: input.approved.policyVersion,
      policyHashSha256: input.approved.policyHashSha256,
      provenance: input.approved.sourceProvenance,
    },
    assessment: input.assessment,
    approvedMessagePack: input.approved,
    envelope,
  });

  return { pack, envelope, proof };
}
