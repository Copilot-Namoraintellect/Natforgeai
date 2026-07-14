import type {
  MessageQualityIssue,
  MessageQualityPolicy,
} from "../contracts";

export function scoreAssessment(
  policy: MessageQualityPolicy,
  hardIssues: readonly MessageQualityIssue[],
  warnings: readonly MessageQualityIssue[]
): number {
  let score = policy.scoreMax;

  for (const issue of [...hardIssues, ...warnings]) {
    score -= policy.scoreWeights[issue.code] ?? 0;
  }

  score = Math.min(policy.scoreMax, Math.max(policy.scoreMin, score));

  if (hardIssues.length > 0) {
    score = Math.min(score, policy.minScoreForApproval - 1);
  }

  return score;
}
