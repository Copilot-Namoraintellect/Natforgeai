import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  MessageAssessment,
  MessagePackCandidate,
  MessageQualityIssue,
  MessageQualityPolicy,
} from "./contracts";
import { computeCopyHashSha256 } from "./hash";
import { computeAssessmentHashSha256 } from "./hash";
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

  if (
    input.candidate.evidenceHashSha256 &&
    input.candidate.evidenceHashSha256 !== input.businessDna.evidenceHashSha256
  ) {
    hardIssues.push(issue("IDENTITY_MISMATCH_EVIDENCE_HASH", "Evidence hash mismatch."));
  }

  if (
    input.candidate.strategyHashSha256 &&
    input.candidate.strategyHashSha256 !== input.campaignStrategy.strategyHashSha256
  ) {
    hardIssues.push(issue("IDENTITY_MISMATCH_STRATEGY_HASH", "Strategy hash mismatch."));
  }

  if (input.candidate.policyHashSha256 && input.candidate.policyHashSha256 !== input.policy.policyHashSha256) {
    hardIssues.push(issue("IDENTITY_MISMATCH_POLICY_HASH", "Policy hash mismatch."));
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

  for (const caption of input.candidate.copy.platformCaptionsOrdered) {
    const ctaIssues = checkCtaPolicy(caption.cta, input.campaignStrategy);
    hardIssues.push(
      ...ctaIssues.map((ctaIssue) =>
        issue("PLATFORM_CAPTION_CTA_POLICY_MISMATCH", `${caption.platform || "unknown"}: ${ctaIssue.message}`)
      )
    );
  }

  const score = scoreAssessment(input.policy, hardIssues, warnings);
  const decision = hardIssues.length === 0 && score >= input.policy.minScoreForApproval ? "approved" : "rejected";

  const draft = {
    assessmentId: input.assessmentId,
    candidateId: input.candidate.candidateId,
    copyHashSha256: input.candidate.copyHashSha256,
    businessDnaSnapshotId: input.businessDna.snapshotId,
    evidenceHashSha256: input.businessDna.evidenceHashSha256,
    campaignStrategySnapshotId: input.campaignStrategy.snapshotId,
    strategyHashSha256: input.campaignStrategy.strategyHashSha256,
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    policyHashSha256: input.policy.policyHashSha256,
    decision,
    hardIssues: Object.freeze(hardIssues),
    warnings: Object.freeze(warnings),
    score,
    evaluatedAtIso: input.evaluatedAtIso,
  } as const;

  const assessmentHashSha256 = computeAssessmentHashSha256(draft);
  return Object.freeze({
    ...draft,
    assessmentHashSha256,
  });
}
