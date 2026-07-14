import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  CanonicalMessagePackCopy,
  MessageQualityIssue,
} from "../contracts";

export function checkProhibitedClaims(
  copy: CanonicalMessagePackCopy,
  business: BusinessDNASnapshot,
  strategy: CampaignStrategySnapshot
): MessageQualityIssue[] {
  const text = [copy.headline, copy.subheadline, ...copy.benefitBulletsOrdered, copy.cta]
    .join("\n")
    .toLowerCase();

  const prohibited = [...business.prohibitedClaims, ...strategy.prohibitedClaims].filter(Boolean);
  const hit = prohibited.find((claim) => text.includes(claim.toLowerCase()));
  if (!hit) return [];

  return [
    {
      code: "PROHIBITED_CLAIM_PRESENT",
      message: `Prohibited claim detected: ${hit}.`,
    },
  ];
}
