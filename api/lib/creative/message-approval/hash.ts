import { createHash } from "crypto";
import type { CanonicalMessagePackCopy, MessageAssessment, MessageQualityPolicy } from "./contracts";

function sha256(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function serializeCanonicalCopy(copy: CanonicalMessagePackCopy): string {
  const footer = copy.footer
    ? {
        phone: copy.footer.phone,
        whatsapp: copy.footer.whatsapp,
        email: copy.footer.email,
        website: copy.footer.website,
        location: copy.footer.location,
      }
    : null;

  return JSON.stringify({
    copySchemaVersion: copy.copySchemaVersion,
    headline: copy.headline,
    subheadline: copy.subheadline,
    benefitBulletsOrdered: copy.benefitBulletsOrdered,
    cta: copy.cta,
    footer,
    proofPointsOrdered: copy.proofPointsOrdered,
    platformCaptionsOrdered: copy.platformCaptionsOrdered.map((item) => ({
      platform: item.platform,
      caption: item.caption,
      cta: item.cta,
      hashtagsOrdered: item.hashtagsOrdered,
    })),
  });
}

export function computeCopyHashSha256(copy: CanonicalMessagePackCopy): string {
  const serialized = serializeCanonicalCopy(copy);
  return sha256(serialized);
}

export function computeSha256FromPayload(payload: string): string {
  return sha256(payload);
}

export function computePolicyHashSha256(policy: Omit<MessageQualityPolicy, "policyHashSha256">): string {
  return sha256(
    JSON.stringify({
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      copySchemaVersion: policy.copySchemaVersion,
      minScoreForApproval: policy.minScoreForApproval,
      ruleClassifications: policy.ruleClassifications,
      scoreWeights: policy.scoreWeights,
      scoreMin: policy.scoreMin,
      scoreMax: policy.scoreMax,
    })
  );
}

export function computeEvaluationKey(input: {
  copyHashSha256: string;
  evidenceHashSha256: string;
  strategyHashSha256: string;
  policyHashSha256: string;
}): string {
  return [
    input.copyHashSha256,
    input.evidenceHashSha256,
    input.strategyHashSha256,
    input.policyHashSha256,
  ].join("|");
}

export function computeAssessmentHashSha256(assessment: Omit<MessageAssessment, "assessmentHashSha256">): string {
  return sha256(
    JSON.stringify({
      assessmentSchemaVersion: "v2.1",
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
      score: assessment.score,
      hardIssues: [...assessment.hardIssues]
        .map((issue) => ({ code: issue.code, message: issue.message }))
        .sort((a, b) => (a.code === b.code ? a.message.localeCompare(b.message) : a.code.localeCompare(b.code))),
      warnings: [...assessment.warnings]
        .map((issue) => ({ code: issue.code, message: issue.message }))
        .sort((a, b) => (a.code === b.code ? a.message.localeCompare(b.message) : a.code.localeCompare(b.code))),
    })
  );
}
