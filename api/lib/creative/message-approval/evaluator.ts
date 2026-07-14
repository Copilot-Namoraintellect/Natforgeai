import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  MessageAssessment,
  MessagePackCandidate,
  MessageQualityIssue,
  MessageQualityPolicy,
} from "./contracts";
import { computeCopyHashSha256 } from "./hash";
import { checkCtaPolicy } from "./rules/cta-policy";
import { checkGenericLanguage } from "./rules/generic-language";
import { checkGrounding } from "./rules/grounding";
import { checkPlaceholderLanguage } from "./rules/placeholders";
import { scoreAssessment } from "./rules/scoring";
import { checkProhibitedClaims } from "./rules/prohibited-claims";
import { checkBrandLanguageConstraints } from "./rules/brand-language";

export interface EvaluateMessageCandidateInput {
  readonly assessmentId: string;
  readonly evaluatedAtIso: string;
  readonly candidate: MessagePackCandidate;
  readonly businessDna: BusinessDNASnapshot;
  readonly campaignStrategy: CampaignStrategySnapshot;
  readonly policy: MessageQualityPolicy;
}

function issue(code: string, message: string): MessageQualityIssue {
  return { code, message };
}

export function evaluateMessageCandidate(input: EvaluateMessageCandidateInput): MessageAssessment {
  const hardIssues: MessageQualityIssue[] = [];
  const warnings: MessageQualityIssue[] = [];

  if (input.candidate.businessDnaSnapshotId !== input.businessDna.snapshotId) {
    hardIssues.push(issue("IDENTITY_MISMATCH_BUSINESS_DNA", "Business DNA snapshot ID mismatch."));
  }

  if (input.candidate.campaignStrategySnapshotId !== input.campaignStrategy.snapshotId) {
    hardIssues.push(issue("IDENTITY_MISMATCH_CAMPAIGN_STRATEGY", "Campaign strategy snapshot ID mismatch."));
  }

  if (input.candidate.qualityPolicyId !== input.policy.policyId) {
    hardIssues.push(issue("IDENTITY_MISMATCH_POLICY_ID", "Quality policy ID mismatch."));
  }

  if (input.candidate.qualityPolicyVersion !== input.policy.policyVersion) {
    hardIssues.push(issue("IDENTITY_MISMATCH_POLICY_VERSION", "Quality policy version mismatch."));
  }

  const recomputedHash = computeCopyHashSha256(input.candidate.copy);
  if (recomputedHash !== input.candidate.copyHashSha256) {
    hardIssues.push(issue("IDENTITY_MISMATCH_COPY_HASH", "Candidate hash does not match canonical copy."));
  }

  const grounding = checkGrounding(input.candidate.copy, input.businessDna, input.campaignStrategy);
  hardIssues.push(...grounding.hardIssues);
  warnings.push(...grounding.warnings);

  hardIssues.push(...checkProhibitedClaims(input.candidate.copy, input.businessDna, input.campaignStrategy));
  hardIssues.push(...checkBrandLanguageConstraints(input.candidate.copy, input.businessDna));
  hardIssues.push(...checkGenericLanguage(input.candidate.copy));
  hardIssues.push(...checkPlaceholderLanguage(input.candidate.copy));
  hardIssues.push(...checkCtaPolicy(input.candidate.copy.cta, input.campaignStrategy));

  const score = scoreAssessment(input.policy, hardIssues, warnings);
  const decision = hardIssues.length === 0 && score >= input.policy.minScoreForApproval ? "approved" : "rejected";

  return Object.freeze({
    assessmentId: input.assessmentId,
    candidateId: input.candidate.candidateId,
    copyHashSha256: input.candidate.copyHashSha256,
    businessDnaSnapshotId: input.businessDna.snapshotId,
    campaignStrategySnapshotId: input.campaignStrategy.snapshotId,
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    decision,
    hardIssues: Object.freeze(hardIssues),
    warnings: Object.freeze(warnings),
    score,
    evaluatedAtIso: input.evaluatedAtIso,
  });
}
