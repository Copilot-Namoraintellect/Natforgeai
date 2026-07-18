import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  CanonicalMessagePackCopy,
  MessageQualityIssue,
} from "../contracts";

function hasTerm(text: string, term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (!normalized) return false;
  return text.includes(normalized);
}

function anyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

export interface GroundingCheckResult {
  readonly hardIssues: readonly MessageQualityIssue[];
  readonly warnings: readonly MessageQualityIssue[];
}

export function checkGrounding(
  copy: CanonicalMessagePackCopy,
  business: BusinessDNASnapshot,
  strategy: CampaignStrategySnapshot
): GroundingCheckResult {
  const text = [
    copy.headline,
    copy.subheadline,
    ...copy.benefitBulletsOrdered,
    copy.cta,
    ...copy.proofPointsOrdered,
    ...copy.platformCaptionsOrdered.flatMap((caption) => [
      caption.platform,
      caption.caption,
      caption.cta,
      ...caption.hashtagsOrdered,
    ]),
  ]
    .join("\n")
    .toLowerCase();

  const hardIssues: MessageQualityIssue[] = [];
  const warnings: MessageQualityIssue[] = [];

  if (!anyTerm(text, business.productsAndServices) && !hasTerm(text, business.primaryOffering)) {
    hardIssues.push({
      code: "PRODUCT_GROUNDING_MISSING",
      message: "Copy does not ground claims in products/services.",
    });
  }

  if (!anyTerm(text, business.verifiedUseCases)) {
    hardIssues.push({
      code: "USE_CASE_GROUNDING_MISSING",
      message: "Copy does not include a verified use case.",
    });
  }

  const audienceTerms = [strategy.primaryAudience, ...business.targetCustomerSegments].filter(Boolean);
  if (!anyTerm(text, audienceTerms)) {
    hardIssues.push({
      code: "TARGET_AUDIENCE_ALIGNMENT_MISSING",
      message: "Copy is not aligned to target audience terms.",
    });
  }

  const painTerms = business.customerPainPoints;
  if (painTerms.length > 0 && !anyTerm(text, painTerms)) {
    hardIssues.push({
      code: "CUSTOMER_PROBLEM_ALIGNMENT_MISSING",
      message: "Copy does not reference customer pain points.",
    });
  }

  const hasSpecificBenefit = copy.benefitBulletsOrdered.some((benefit) => /\b\d+|hours|minutes|reduce|faster|save|increase|improve\b/i.test(benefit));
  if (!hasSpecificBenefit) {
    warnings.push({
      code: "BENEFIT_SPECIFICITY_WEAK",
      message: "Benefits appear generic and non-specific.",
    });
  }

  return { hardIssues, warnings };
}
