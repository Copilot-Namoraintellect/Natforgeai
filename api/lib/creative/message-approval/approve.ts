import type {
  ApprovedMessagePack,
  MessageAssessment,
  MessagePackCandidate,
  MessageQualityPolicy,
} from "./contracts";

export interface ApproveMessagePackInput {
  readonly approvedRevisionId: string;
  readonly approvedAtIso: string;
  readonly candidate: MessagePackCandidate;
  readonly assessment: MessageAssessment;
  readonly policy: MessageQualityPolicy;
}

export function createApprovedMessagePack(input: ApproveMessagePackInput): ApprovedMessagePack {
  if (input.assessment.decision !== "approved") {
    throw new Error("Cannot create approved message pack from rejected assessment.");
  }

  if (input.assessment.candidateId !== input.candidate.candidateId) {
    throw new Error("Candidate ID mismatch.");
  }

  if (input.assessment.copyHashSha256 !== input.candidate.copyHashSha256) {
    throw new Error("Copy hash mismatch.");
  }

  if (input.assessment.businessDnaSnapshotId !== input.candidate.businessDnaSnapshotId) {
    throw new Error("Business DNA snapshot mismatch.");
  }

  if (input.assessment.campaignStrategySnapshotId !== input.candidate.campaignStrategySnapshotId) {
    throw new Error("Campaign strategy snapshot mismatch.");
  }

  if (input.assessment.policyId !== input.candidate.qualityPolicyId) {
    throw new Error("Policy ID mismatch.");
  }

  if (input.assessment.policyVersion !== input.candidate.qualityPolicyVersion) {
    throw new Error("Policy version mismatch.");
  }

  if (input.assessment.hardIssues.length > 0) {
    throw new Error("Hard issues present; cannot approve.");
  }

  if (input.assessment.score < input.policy.minScoreForApproval) {
    throw new Error("Assessment score below approval threshold.");
  }

  return Object.freeze({
    approvedRevisionId: input.approvedRevisionId,
    candidateId: input.candidate.candidateId,
    assessmentId: input.assessment.assessmentId,
    assessmentHashSha256: input.assessment.assessmentHashSha256,
    copyHashSha256: input.candidate.copyHashSha256,
    businessDnaSnapshotId: input.candidate.businessDnaSnapshotId,
    evidenceHashSha256: input.candidate.evidenceHashSha256,
    campaignStrategySnapshotId: input.candidate.campaignStrategySnapshotId,
    strategyHashSha256: input.candidate.strategyHashSha256,
    policyId: input.candidate.qualityPolicyId,
    policyVersion: input.candidate.qualityPolicyVersion,
    policyHashSha256: input.candidate.policyHashSha256,
    approvedAtIso: input.approvedAtIso,
    copy: input.candidate.copy,
    sourceProvenance: input.candidate.provenance,
  });
}
