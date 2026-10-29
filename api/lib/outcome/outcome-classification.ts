// ─── R7-A Conversion Outcome Intelligence — deterministic classification ───
//
// PURE module: rule-first outcome classification. The outcome type is a
// deterministic function of the canonical conversion type and the optional,
// closed-vocabulary client proposal. No LLM or model is outcome authority; a
// model-produced proposal is untrusted input that must pass this same strict
// classifier and can never invent value, currency, or a commercial event.
// Protected or irrelevant personal traits are not classifier inputs — none
// exist in the schema and none influence the outcome. No I/O, no clock.

import { ConversionTypeEnum } from "../conversion/conversion-contract";
import { OutcomeInputError, OUTCOME_REVERSAL_TYPE_SET, type OutcomeType } from "./outcome-contract";

/**
 * Deterministic derivation map: R6-E conversion type → R7-A outcome type.
 * `unknown` is the R6-E reserved aggregation fallback and is never fabricated
 * into a business outcome — it fails closed.
 */
export const CONVERSION_TYPE_TO_OUTCOME_TYPE: Readonly<
  Record<string, OutcomeType | "UNSUPPORTED">
> = {
  purchase: "PURCHASE",
  subscription: "SUBSCRIPTION",
  booking: "BOOKING",
  contract_signed: "CONTRACT",
  renewal: "RENEWAL",
  consultation: "NON_MONETARY_SUCCESS",
  demo_completed: "NON_MONETARY_SUCCESS",
  application_submitted: "NON_MONETARY_SUCCESS",
  retained_customer: "OTHER_VERIFIED_OUTCOME",
  qualified_offline_outcome: "OTHER_VERIFIED_OUTCOME",
  refund: "REFUND",
  cancellation: "CANCELLATION",
  reversal: "REVERSAL",
  unknown: "UNSUPPORTED",
};

function isConversionType(value: string): boolean {
  return (ConversionTypeEnum.options as readonly string[]).includes(value);
}

/**
 * Classify the business outcome type from the canonical conversion type and an
 * optional client proposal (closed vocabulary). Rules (contract §5):
 *
 * 1. Reversal conversions force the matching reversal outcome type; a
 *    positive-type proposal on a reversal conversion fails closed.
 * 2. NON_MONETARY_SUCCESS conversions cannot be reclassified as monetary.
 * 3. PURCHASE / BOOKING / CONTRACT accept only their derived type.
 * 4. subscription / renewal conversions accept UPGRADE / DOWNGRADE proposals.
 * 5. OTHER_VERIFIED_OUTCOME conversions accept any positive or non-monetary
 *    outcome type (ambiguous offline outcome narrowed by evidenced proposal).
 *
 * Throws OutcomeInputError (fail closed) on unknown conversion types or
 * conflicting proposals.
 */
export function classifyOutcomeType(
  conversionType: string,
  proposal?: OutcomeType
): OutcomeType {
  if (!isConversionType(conversionType)) {
    throw new OutcomeInputError(
      "OUTCOME_CLASSIFICATION_UNSUPPORTED",
      `conversion type ${JSON.stringify(conversionType)} is outside the closed R6-E vocabulary; outcome classification refused.`
    );
  }
  const derived = CONVERSION_TYPE_TO_OUTCOME_TYPE[conversionType];
  if (derived === "UNSUPPORTED") {
    throw new OutcomeInputError(
      "OUTCOME_CLASSIFICATION_UNSUPPORTED",
      "conversion type \"unknown\" is a reserved aggregation fallback and can never be classified as a business outcome."
    );
  }
  if (proposal === undefined || proposal === derived) {
    return derived;
  }

  const derivedIsReversal = OUTCOME_REVERSAL_TYPE_SET.has(derived);
  const proposalIsReversal = OUTCOME_REVERSAL_TYPE_SET.has(proposal);

  // Rule 1: reversal conversions only ever produce their reversal type.
  if (derivedIsReversal) {
    throw new OutcomeInputError(
      "OUTCOME_TYPE_CONFLICT",
      `conversion type "${conversionType}" derives outcome type ${derived}; proposal ${proposal} rejected.`
    );
  }
  if (proposalIsReversal) {
    throw new OutcomeInputError(
      "OUTCOME_TYPE_CONFLICT",
      `outcome type ${proposal} requires reversal lineage (reversesOutcomeId) and cannot be proposed on conversion type "${conversionType}".`
    );
  }

  // Rule 2: demonstrably non-commercial conversion events cannot be reclassified.
  if (derived === "NON_MONETARY_SUCCESS") {
    throw new OutcomeInputError(
      "OUTCOME_TYPE_CONFLICT",
      `conversion type "${conversionType}" derives NON_MONETARY_SUCCESS; monetary reclassification to ${proposal} rejected.`
    );
  }

  // Rule 4: plan-change refinements of subscription/renewal conversions.
  if (
    (conversionType === "subscription" || conversionType === "renewal") &&
    (proposal === "UPGRADE" || proposal === "DOWNGRADE")
  ) {
    return proposal;
  }

  // Rule 3: fixed-type conversions accept only their derived type.
  if (derived !== "OTHER_VERIFIED_OUTCOME") {
    throw new OutcomeInputError(
      "OUTCOME_TYPE_CONFLICT",
      `conversion type "${conversionType}" derives outcome type ${derived}; proposal ${proposal} rejected.`
    );
  }

  // Rule 5: OTHER_VERIFIED_OUTCOME accepts any positive / non-monetary label.
  return proposal;
}
