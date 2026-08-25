/**
 * Pre-render Content Compliance Engine.
 *
 * Slice 2 scope:
 * - consumes an ApprovedCreativeContract, a proposed creative/message pack,
 *   and a grounded evidence set;
 * - returns structured deterministic compliance results;
 * - never calls providers, writes to the database, charges, publishes,
 *   or changes workflow state;
 * - never repairs content autonomously.
 */

import type { ApprovedCreativeContract, CreativeContract } from "../contracts/creative-contract";
import type {
  CompiledGroundedEvidence,
  EvidenceSet,
  GroundedBenefit,
  GroundedClaim,
} from "../contracts/grounded-evidence";
import {
  compileEvidenceSet,
  compileGroundedEvidence,
  isDistinctBenefit,
  isUnsupportedClaim,
  validateAudience,
  validateClaim,
  validateOffer,
} from "../contracts/grounded-evidence";
import { normalizeCtaText } from "../cta-utils";

export type ComplianceRuleStatus = "pass" | "fail" | "warning" | "not_applicable";

export interface ContentComplianceRuleResult {
  ruleId: string;
  status: ComplianceRuleStatus;
  reasonCode: string;
  affectedField: string | null;
  evidenceIds: string[];
  explanation: string;
}

export interface ContentComplianceFailure {
  ruleId: string;
  reasonCode: string;
  affectedField: string | null;
  explanation: string;
}

export interface ContentComplianceWarning {
  ruleId: string;
  reasonCode: string;
  affectedField: string | null;
  explanation: string;
}

export interface ContentComplianceResult {
  passed: boolean;
  contractFingerprint: string;
  evidenceSetFingerprint: string;
  evaluatedRules: ContentComplianceRuleResult[];
  failures: ContentComplianceFailure[];
  failedRuleIds: string[];
  warnings: ContentComplianceWarning[];
  groundedClaimCount: number;
  partiallyGroundedClaimCount: number;
  ungroundedClaimCount: number;
  groundedBenefitCount: number;
  distinctGroundedBenefitCount: number;
  requiredBenefitCount: number;
  evaluatorVersion: string;
}

export interface ProposedCreativeContent {
  headline: string;
  primaryText: string;
  benefits: string[];
  cta: string;
  funnelStage: string;
  targetAudience: string;
  offer: string | null;
  businessName: string;
  protectedFields: Record<string, string | null>;
  requiredContactDetails?: string[];
}

export interface EvaluateContentComplianceInput {
  contract: CreativeContract;
  proposed: ProposedCreativeContent;
  evaluatorVersion?: string;
}

const EVALUATOR_VERSION = "slice2.content-compliance.v1";

function normalize(text: string): string {
  return normalizeCtaText(text);
}

function ruleResult(
  ruleId: string,
  status: ComplianceRuleStatus,
  reasonCode: string,
  affectedField: string | null,
  explanation: string,
  evidenceIds: string[] = []
): ContentComplianceRuleResult {
  return {
    ruleId,
    status,
    reasonCode,
    affectedField,
    evidenceIds: [...evidenceIds],
    explanation,
  };
}

function evaluateLineageRule(
  contract: CreativeContract
): ContentComplianceRuleResult {
  const ok = contract.kind === "approved";
  if (ok) {
    return ruleResult(
      "CONTRACT_LINEAGE",
      "pass",
      "LINEAGE_AUTHORITATIVE",
      null,
      `ApprovedCreativeContract is authoritative for strategyRunId ${contract.strategyRunId}.`
    );
  }
  return ruleResult(
    "CONTRACT_LINEAGE",
    "fail",
    "LINEAGE_NOT_AUTHORITATIVE",
    null,
    `Contract is a ${contract.kind}; approved lineage is missing or invalid.`,
    []
  );
}

function evaluateEvidenceAvailabilityRule(
  contract: CreativeContract,
  evidenceSet: EvidenceSet
): ContentComplianceRuleResult {
  if (contract.kind !== "approved") {
    return ruleResult(
      "EVIDENCE_AVAILABILITY",
      "not_applicable",
      "LINEAGE_NOT_AUTHORITATIVE",
      null,
      "Evidence availability is not evaluated because the contract is not authoritative."
    );
  }
  if (evidenceSet.items.length === 0) {
    return ruleResult(
      "EVIDENCE_AVAILABILITY",
      "fail",
      "NO_GROUNDED_EVIDENCE",
      null,
      "The approved contract contains no grounded business evidence."
    );
  }
  return ruleResult(
    "EVIDENCE_AVAILABILITY",
    "pass",
    "GROUNDED_EVIDENCE_PRESENT",
    null,
    `${evidenceSet.items.length} grounded evidence item(s) are available.`
  );
}

function evaluateCtaRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  if (!contract.cta.locked) {
    return ruleResult(
      "CTA_LOCKED",
      "not_applicable",
      "CTA_NOT_LOCKED",
      "cta",
      "CTA is not locked by the contract; legacy selection is permitted."
    );
  }
  const match = normalize(proposed.cta) === normalize(contract.cta.text);
  if (match) {
    return ruleResult(
      "CTA_LOCKED",
      "pass",
      "CTA_MATCHES_CONTRACT",
      "cta",
      `Proposed CTA "${proposed.cta}" matches the locked contract CTA.`,
      []
    );
  }
  return ruleResult(
    "CTA_LOCKED",
    "fail",
    "CTA_MISMATCH",
    "cta",
    `Proposed CTA "${proposed.cta}" does not match the locked contract CTA "${contract.cta.text}".`
  );
}

function evaluateOfferRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const proposedOffer = (proposed.offer ?? "").trim();
  const approvedOffer = contract.offer.text;

  if (!approvedOffer) {
    if (!proposedOffer) {
      return ruleResult(
        "OFFER_AUTHORISED",
        "pass",
        "NO_OFFER_APPROVED_NONE_PROPOSED",
        "offer",
        "No approved offer and none proposed."
      );
    }
    const validation = validateOffer(proposedOffer, contract);
    if (validation.valid) {
      return ruleResult(
        "OFFER_AUTHORISED",
        "pass",
        "NO_APPROVED_OFFER_PROPOSED_OK",
        "offer",
        "No approved offer; proposed offer contains no invented commercial terms."
      );
    }
    return ruleResult(
      "OFFER_AUTHORISED",
      "fail",
      validation.code ?? "INVENTED_OFFER",
      "offer",
      `Proposed offer "${proposedOffer}" contains invented commercial terms not present in an approved offer.`
    );
  }

  // Required approved offer may not be omitted.
  if (!proposedOffer) {
    if (contract.offer.required) {
      return ruleResult(
        "OFFER_AUTHORISED",
        "fail",
        "REQUIRED_OFFER_OMITTED",
        "offer",
        `Approved offer "${approvedOffer}" is required but was omitted.`
      );
    }
    return ruleResult(
      "OFFER_AUTHORISED",
      "pass",
      "APPROVED_OFFER_OMITTED",
      "offer",
      `Approved offer "${approvedOffer}" is optional and was omitted.`
    );
  }

  const validation = validateOffer(proposedOffer, contract);
  if (validation.valid) {
    return ruleResult(
      "OFFER_AUTHORISED",
      "pass",
      "OFFER_MATCHES_APPROVED",
      "offer",
      `Proposed offer is compatible with approved offer "${approvedOffer}".`
    );
  }
  return ruleResult(
    "OFFER_AUTHORISED",
    "fail",
    validation.code ?? "OFFER_MISMATCH",
    "offer",
    `Proposed offer "${proposedOffer}" is not compatible with approved offer "${approvedOffer}".`
  );
}

function evaluateFunnelStageRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const match = normalize(proposed.funnelStage) === normalize(contract.funnelStage);
  if (match) {
    return ruleResult(
      "FUNNEL_STAGE",
      "pass",
      "FUNNEL_STAGE_MATCHES",
      "funnelStage",
      `Proposed funnel stage "${proposed.funnelStage}" matches contract.`
    );
  }
  return ruleResult(
    "FUNNEL_STAGE",
    "fail",
    "FUNNEL_STAGE_MISMATCH",
    "funnelStage",
    `Proposed funnel stage "${proposed.funnelStage}" does not match contract "${contract.funnelStage}".`
  );
}

function evaluateAudienceRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const audienceText = [proposed.targetAudience, proposed.primaryText].join(" ").trim();
  const validation = validateAudience(audienceText, contract);
  if (!validation.consistent) {
    return ruleResult(
      "AUDIENCE_CONSISTENCY",
      "fail",
      validation.code ?? "AUDIENCE_CONFLICT",
      "targetAudience",
      `Proposed audience "${proposed.targetAudience}" conflicts with contract audience "${contract.targetAudience}".`
    );
  }

  // Literal phrase presence is not required, but exact contradiction was checked above.
  return ruleResult(
    "AUDIENCE_CONSISTENCY",
    "pass",
    "AUDIENCE_COMPATIBLE",
    "targetAudience",
    `Proposed audience is compatible with contract audience "${contract.targetAudience}".`
  );
}

function evaluateProtectedFactsRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const protectedFields = proposed.protectedFields ?? {};
  const failures: string[] = [];

  if (protectedFields.businessName && normalize(protectedFields.businessName) !== normalize(contract.businessName)) {
    failures.push(`businessName changed from "${contract.businessName}" to "${protectedFields.businessName}"`);
  }

  // Funnel stage and audience are protected by separate rules.
  if (failures.length > 0) {
    return ruleResult(
      "PROTECTED_FACTS",
      "fail",
      "PROTECTED_FACT_CHANGED",
      "protectedFields",
      `Protected business facts were altered: ${failures.join("; ")}.`
    );
  }

  return ruleResult(
    "PROTECTED_FACTS",
    "pass",
    "PROTECTED_FACTS_PRESERVED",
    "protectedFields",
    "Protected business facts are preserved."
  );
}

function evaluateClaimsRule(
  _contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent,
  evidenceSet: EvidenceSet
): { result: ContentComplianceRuleResult; claims: GroundedClaim[] } {
  const claimTexts = uniqueStrings([
    proposed.headline,
    proposed.primaryText,
    ...proposed.benefits,
  ]);

  const claims = claimTexts.map((text) => validateClaim(text, evidenceSet));
  const grounded = claims.filter((c) => c.validationStatus === "grounded").length;
  const ungrounded = claims.filter((c) => c.validationStatus === "ungrounded").length;
  const partially = claims.filter((c) => c.validationStatus === "partially_grounded").length;

  if (ungrounded > 0) {
    return {
      result: ruleResult(
        "CLAIM_GROUNDING",
        "fail",
        "UNGROUNDED_CLAIM_PRESENT",
        "headline|primaryText|benefits",
        `${ungrounded} material claim(s) are ungrounded; ${grounded} grounded, ${partially} partially grounded.`,
        []
      ),
      claims,
    };
  }

  if (partially > 0) {
    return {
      result: ruleResult(
        "CLAIM_GROUNDING",
        "warning",
        "PARTIALLY_GROUNDED_CLAIM_PRESENT",
        "headline|primaryText|benefits",
        `${partially} claim(s) are only partially grounded.`,
        []
      ),
      claims,
    };
  }

  return {
    result: ruleResult(
      "CLAIM_GROUNDING",
      "pass",
      "ALL_CLAIMS_GROUNDED",
      "headline|primaryText|benefits",
      `All ${claims.length} material claim(s) are grounded.`,
      []
    ),
    claims,
  };
}

function evaluateBenefitsRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent,
  compiled: CompiledGroundedEvidence
): { result: ContentComplianceRuleResult; proposedBenefits: GroundedBenefit[] } {
  const proposedBenefits: GroundedBenefit[] = proposed.benefits.map((text, index) =>
    validateBenefit(text, index, compiled.evidenceSet)
  );

  const ungroundedCount = proposedBenefits.filter((b) => b.validationStatus === "ungrounded").length;
  const groundedCount = proposedBenefits.filter((b) => b.validationStatus === "grounded").length;
  const distinctGrounded = countDistinctBenefits(proposedBenefits);
  const required = contract.minimumBenefitCount;

  if (ungroundedCount > 0) {
    return {
      result: ruleResult(
        "BENEFIT_GROUNDING",
        "fail",
        "UNGROUNDED_BENEFIT_PRESENT",
        "benefits",
        `${ungroundedCount} proposed benefit(s) lack traceable evidence.`,
        []
      ),
      proposedBenefits,
    };
  }

  if (distinctGrounded < required) {
    return {
      result: ruleResult(
        "BENEFIT_GROUNDING",
        "fail",
        "INSUFFICIENT_DISTINCT_GROUNDED_BENEFITS",
        "benefits",
        `${distinctGrounded} distinct grounded benefit(s) found; ${required} required.`,
        []
      ),
      proposedBenefits,
    };
  }

  return {
    result: ruleResult(
      "BENEFIT_GROUNDING",
      "pass",
      "BENEFITS_GROUNDED_AND_DISTINCT",
      "benefits",
      `${groundedCount} grounded benefit(s), ${distinctGrounded} distinct, meet the required ${required}.`,
      []
    ),
    proposedBenefits,
  };
}

function validateBenefit(
  text: string,
  index: number,
  evidenceSet: EvidenceSet
): GroundedBenefit {
  const claim = validateClaim(text, evidenceSet);
  const sortedEvidenceIds = [...claim.evidenceIds].sort();
  return {
    benefitId: `proposed-benefit-${index}`,
    text,
    evidenceIds: sortedEvidenceIds,
    originatingCapabilities: sortedEvidenceIds
      .map((id) => evidenceSet.evidenceById.get(id)?.displayText ?? "")
      .sort(),
    validationStatus: claim.validationStatus,
  };
}

function countDistinctBenefits(benefits: readonly GroundedBenefit[]): number {
  const distinct: GroundedBenefit[] = [];
  for (const benefit of benefits) {
    if (benefit.validationStatus !== "grounded") continue;
    if (isDistinctBenefit(benefit, distinct)) {
      distinct.push(benefit);
    }
  }
  return distinct.length;
}

function evaluateUnsupportedClaimsRule(
  _contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent,
  evidenceSet: EvidenceSet
): ContentComplianceRuleResult {
  const allText = [
    proposed.headline,
    proposed.primaryText,
    ...proposed.benefits,
    proposed.offer ?? "",
  ].join(" ").trim();

  const unsupportedCodes = collectUnsupportedClaimCodes(allText, evidenceSet);
  const prohibitedHits = _contract.prohibitedClaims.filter((claim) =>
    normalize(allText).includes(normalize(claim))
  );

  if (unsupportedCodes.length > 0 || prohibitedHits.length > 0) {
    const codes = [...unsupportedCodes, ...prohibitedHits.map(() => "PROHIBITED_CLAIM_PRESENT")];
    return ruleResult(
      "UNSUPPORTED_CLAIMS",
      "fail",
      codes[0] ?? "UNSUPPORTED_CLAIM_PRESENT",
      "headline|primaryText|benefits|offer",
      `Unsupported or prohibited claims detected: ${codes.join(", ")}.`
    );
  }

  return ruleResult(
    "UNSUPPORTED_CLAIMS",
    "pass",
    "NO_UNSUPPORTED_CLAIMS",
    "headline|primaryText|benefits|offer",
    "No unsupported or prohibited claims detected."
  );
}

function collectUnsupportedClaimCodes(
  text: string,
  evidenceSet: EvidenceSet
): string[] {
  const codes: string[] = [];
  // Check the full text and also each sentence for localized unsupported claims.
  const segments = text.split(/[.!?]/).map((s) => s.trim()).filter(Boolean);
  for (const segment of [text, ...segments]) {
    if (isUnsupportedClaim(segment, evidenceSet)) {
      codes.push("UNSUPPORTED_CLAIM_PRESENT");
    }
  }
  return [...new Set(codes)];
}

function evaluatePlaceholderRule(
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const allText = [
    proposed.headline,
    proposed.primaryText,
    ...proposed.benefits,
    proposed.cta,
    proposed.offer ?? "",
    ...Object.values(proposed.protectedFields ?? {}),
  ].join(" ").toLowerCase();

  const placeholderPatterns = [
    /\[your business\]/,
    /\[your brand\]/,
    /\[your company\]/,
    /\[company\]/,
    /\[product\]/,
    /\[service\]/,
    /\[phone\]/,
    /\[email\]/,
    /\[website\]/,
    /\[location\]/,
    /your business here/,
    /placeholder/,
  ];

  const found = placeholderPatterns.filter((pattern) => pattern.test(allText));
  if (found.length > 0) {
    return ruleResult(
      "PLACEHOLDER_CONTENT",
      "fail",
      "PLACEHOLDER_OR_UNRESOLVED_TEMPLATE",
      "content",
      `Placeholder or unresolved template content detected.`
    );
  }

  return ruleResult(
    "PLACEHOLDER_CONTENT",
    "pass",
    "NO_PLACEHOLDERS",
    "content",
    "No placeholder or unresolved template content detected."
  );
}

function evaluateSchemaRule(
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const requiredFields = ["headline", "primaryText", "cta", "funnelStage", "targetAudience", "businessName"];
  const missing = requiredFields.filter((field) => {
    const value = (proposed as any)[field];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    return ruleResult(
      "STRUCTURED_SCHEMA",
      "fail",
      "MISSING_REQUIRED_FIELD",
      missing[0],
      `Missing required content field(s): ${missing.join(", ")}.`
    );
  }

  return ruleResult(
    "STRUCTURED_SCHEMA",
    "pass",
    "REQUIRED_FIELDS_PRESENT",
    "schema",
    "All required structured fields are present."
  );
}

function evaluateRequiredContactDetailsRule(
  contract: ApprovedCreativeContract,
  proposed: ProposedCreativeContent
): ContentComplianceRuleResult {
  const required = contract.requiredContactDetails ?? [];
  if (required.length === 0) {
    return ruleResult(
      "REQUIRED_CONTACT_DETAILS",
      "not_applicable",
      "NO_CONTACT_DETAILS_REQUIRED",
      "contactDetails",
      "No contact details are required by the contract."
    );
  }

  const provided = proposed.requiredContactDetails ?? [];
  const missing = required.filter((detail) => !provided.includes(detail));
  if (missing.length > 0) {
    return ruleResult(
      "REQUIRED_CONTACT_DETAILS",
      "fail",
      "MISSING_REQUIRED_CONTACT_DETAIL",
      "contactDetails",
      `Missing required contact detail(s): ${missing.join(", ")}.`
    );
  }

  return ruleResult(
    "REQUIRED_CONTACT_DETAILS",
    "pass",
    "REQUIRED_CONTACT_DETAILS_PRESENT",
    "contactDetails",
    "All required contact details are present."
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * Evaluate pre-render content compliance deterministically.
 */
export function evaluateContentCompliance(
  input: EvaluateContentComplianceInput
): ContentComplianceResult {
  const { contract, proposed } = input;
  const evaluatorVersion = input.evaluatorVersion ?? EVALUATOR_VERSION;

  const evidenceSet = compileEvidenceSet(contract, contract.contractFingerprint);
  const compiled = compileGroundedEvidence(contract);

  const evaluatedRules: ContentComplianceRuleResult[] = [];

  evaluatedRules.push(evaluateLineageRule(contract));
  evaluatedRules.push(evaluateEvidenceAvailabilityRule(contract, evidenceSet));

  if (contract.kind !== "approved") {
    // If the contract is not approved, all other rules are not applicable.
    evaluatedRules.push(
      ...[
        "CTA_LOCKED",
        "OFFER_AUTHORISED",
        "FUNNEL_STAGE",
        "AUDIENCE_CONSISTENCY",
        "PROTECTED_FACTS",
        "CLAIM_GROUNDING",
        "BENEFIT_GROUNDING",
        "UNSUPPORTED_CLAIMS",
        "PLACEHOLDER_CONTENT",
        "STRUCTURED_SCHEMA",
        "REQUIRED_CONTACT_DETAILS",
      ].map((ruleId) =>
        ruleResult(
          ruleId,
          "not_applicable",
          "LINEAGE_NOT_AUTHORITATIVE",
          null,
          "Rule skipped because the contract is not authoritative."
        )
      )
    );

    return buildResult(
      contract,
      evidenceSet,
      evaluatedRules,
      compiled,
      evaluatorVersion
    );
  }

  const approvedContract = contract as ApprovedCreativeContract;

  evaluatedRules.push(evaluateCtaRule(approvedContract, proposed));
  evaluatedRules.push(evaluateOfferRule(approvedContract, proposed));
  evaluatedRules.push(evaluateFunnelStageRule(approvedContract, proposed));
  evaluatedRules.push(evaluateAudienceRule(approvedContract, proposed));
  evaluatedRules.push(evaluateProtectedFactsRule(approvedContract, proposed));

  const claimsEvaluation = evaluateClaimsRule(approvedContract, proposed, evidenceSet);
  evaluatedRules.push(claimsEvaluation.result);

  const benefitsEvaluation = evaluateBenefitsRule(approvedContract, proposed, compiled);
  evaluatedRules.push(benefitsEvaluation.result);

  evaluatedRules.push(evaluateUnsupportedClaimsRule(approvedContract, proposed, evidenceSet));
  evaluatedRules.push(evaluatePlaceholderRule(proposed));
  evaluatedRules.push(evaluateSchemaRule(proposed));
  evaluatedRules.push(evaluateRequiredContactDetailsRule(approvedContract, proposed));

  return buildResult(
    contract,
    evidenceSet,
    evaluatedRules,
    compiled,
    evaluatorVersion
  );
}

function buildResult(
  contract: CreativeContract,
  evidenceSet: EvidenceSet,
  evaluatedRules: ContentComplianceRuleResult[],
  compiled: CompiledGroundedEvidence,
  evaluatorVersion: string
): ContentComplianceResult {
  const failures = evaluatedRules
    .filter((r) => r.status === "fail")
    .map((r) => ({
      ruleId: r.ruleId,
      reasonCode: r.reasonCode,
      affectedField: r.affectedField,
      explanation: r.explanation,
    }));

  const warnings = evaluatedRules
    .filter((r) => r.status === "warning")
    .map((r) => ({
      ruleId: r.ruleId,
      reasonCode: r.reasonCode,
      affectedField: r.affectedField,
      explanation: r.explanation,
    }));

  const failedRuleIds = evaluatedRules
    .filter((r) => r.status === "fail")
    .map((r) => r.ruleId);

  const passed = failures.length === 0;

  const groundedBenefits = compiled.benefits.filter(
    (b) => b.validationStatus === "grounded"
  );

  return {
    passed,
    contractFingerprint: contract.contractFingerprint,
    evidenceSetFingerprint: evidenceSet.evidenceSetFingerprint,
    evaluatedRules,
    failures,
    failedRuleIds,
    warnings,
    groundedClaimCount: compiled.claims.filter((c) => c.validationStatus === "grounded").length,
    partiallyGroundedClaimCount: compiled.claims.filter((c) => c.validationStatus === "partially_grounded").length,
    ungroundedClaimCount: compiled.claims.filter((c) => c.validationStatus === "ungrounded").length,
    groundedBenefitCount: groundedBenefits.length,
    distinctGroundedBenefitCount: compiled.distinctBenefitCount,
    requiredBenefitCount: contract.minimumBenefitCount,
    evaluatorVersion,
  };
}
