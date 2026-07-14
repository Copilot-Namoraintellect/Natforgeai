import type { CampaignStrategySnapshot, MessageQualityIssue } from "../contracts";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function checkCtaPolicy(
  cta: string,
  strategy: CampaignStrategySnapshot
): MessageQualityIssue[] {
  const ctaNorm = normalize(cta);
  const policy = strategy.ctaPolicy;

  if (policy.mode === "exact") {
    if (ctaNorm === normalize(policy.requiredCta)) return [];
    return [
      {
        code: "CTA_POLICY_MISMATCH",
        message: `CTA must exactly match: ${policy.requiredCta}.`,
      },
    ];
  }

  if (policy.mode === "allowed_set") {
    const allowed = policy.allowedCtas.map((item) => normalize(item));
    if (allowed.includes(ctaNorm)) return [];
    return [
      {
        code: "CTA_POLICY_MISMATCH",
        message: "CTA is not in the allowed set.",
      },
    ];
  }

  const keywordHit = policy.intentKeywords.some((keyword) => ctaNorm.includes(normalize(keyword)));
  if (keywordHit) return [];
  return [
    {
      code: "CTA_POLICY_MISMATCH",
      message: `CTA does not satisfy semantic intent: ${policy.requiredIntent}.`,
    },
  ];
}
