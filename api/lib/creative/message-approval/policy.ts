import type { MessageQualityPolicy } from "./contracts";

export const DEFAULT_V2_MESSAGE_QUALITY_POLICY: MessageQualityPolicy = Object.freeze({
  policyId: "natforgeai-v2-message-quality",
  policyVersion: 1,
  copySchemaVersion: "v2.1",
  minScoreForApproval: 80,
  ruleClassifications: Object.freeze({
    PRODUCT_GROUNDING_MISSING: "hard",
    USE_CASE_GROUNDING_MISSING: "hard",
    TARGET_AUDIENCE_ALIGNMENT_MISSING: "hard",
    CUSTOMER_PROBLEM_ALIGNMENT_MISSING: "hard",
    BENEFIT_SPECIFICITY_WEAK: "warning",
    PROHIBITED_CLAIM_PRESENT: "hard",
    BRAND_LANGUAGE_VIOLATION: "hard",
    GENERIC_LANGUAGE_DETECTED: "hard",
    PLACEHOLDER_LANGUAGE_DETECTED: "hard",
    CTA_POLICY_MISMATCH: "hard",
  }),
  scoreWeights: Object.freeze({
    PRODUCT_GROUNDING_MISSING: 30,
    USE_CASE_GROUNDING_MISSING: 20,
    TARGET_AUDIENCE_ALIGNMENT_MISSING: 15,
    CUSTOMER_PROBLEM_ALIGNMENT_MISSING: 15,
    BENEFIT_SPECIFICITY_WEAK: 10,
    PROHIBITED_CLAIM_PRESENT: 40,
    BRAND_LANGUAGE_VIOLATION: 25,
    GENERIC_LANGUAGE_DETECTED: 25,
    PLACEHOLDER_LANGUAGE_DETECTED: 25,
    CTA_POLICY_MISMATCH: 20,
  }),
  scoreMin: 0,
  scoreMax: 100,
});
