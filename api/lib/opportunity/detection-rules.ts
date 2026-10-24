// ─── R5-D Opportunity Detection — rule-first detection (contract §8, D2) ───
//
// PURE deterministic rule table "opportunity-detector/v1". Consumes R5-B
// controlled labels ONLY — never raw social text, never broad keyword
// matching for sales intent. Non-billable: no model, no runAgent call.
// Explainable: every outcome carries the matched rule id.

import type { CanonicalInterpretation } from "./canonical-intelligence";
import { hasIndicator } from "./canonical-intelligence";
import type { OpportunityType, SuppressionReason } from "./opportunity-contract";

export const RULE_TABLE_VERSION = "opportunity-detector/v1" as const;

/** Thread-history facts needed by the aggregation rules (R9/R10). */
export interface ThreadHistoryContext {
  /** Suppressions on the same thread coordinates within the evidence window. */
  readonly priorSuppressionIntents: readonly string[];
  readonly hasPriorComplaintClassSuppression: boolean;
  readonly hasPriorPraiseClassSuppression: boolean;
}

export const EMPTY_THREAD_HISTORY: ThreadHistoryContext = Object.freeze({
  priorSuppressionIntents: [],
  hasPriorComplaintClassSuppression: false,
  hasPriorPraiseClassSuppression: false,
});

export type RuleOutcome =
  | { readonly kind: "candidate"; readonly opportunityType: OpportunityType; readonly ruleId: string }
  | { readonly kind: "suppression"; readonly reason: SuppressionReason; readonly ruleId: string; readonly detail: string };

export interface RuleEvaluation {
  readonly outcome: RuleOutcome;
}

const COMPLAINT_CLASS_INTENTS = new Set(["complaint", "support_request"]);

/**
 * Deterministic rule table (contract §8, first match wins). Gates in §9 are
 * applied by the orchestrator BEFORE this table is consulted.
 */
export function evaluateDetectionRules(
  interpretation: CanonicalInterpretation,
  history: ThreadHistoryContext
): RuleEvaluation {
  const intent = interpretation.intent;
  const relevance = interpretation.relevance;

  // R1–R3: purchase interest (controlled intent from R5-B; no keyword matching).
  if (intent === "purchase_interest") {
    if (relevance === "not_relevant") {
      return suppression("LOW_RELEVANCE", "R2", "purchase_interest with not_relevant relevance");
    }
    if (relevance === "unknown") {
      return candidate("purchase_interest", "R3");
    }
    return candidate("purchase_interest", "R1");
  }

  // R4: service / product questions are service enquiries (pre-lead).
  if (intent === "service_question" || intent === "product_question") {
    return candidate("service_enquiry", "R4");
  }

  // R5: information request qualifies only with an explicit purchase indicator.
  if (intent === "information_request") {
    if (hasIndicator(interpretation, "purchase_intent_detected")) {
      return candidate("purchase_interest", "R5");
    }
    return suppression(
      "NO_OPPORTUNITY_CLASSIFICATION",
      "R12",
      "information_request without qualifying opportunity indicator"
    );
  }

  // R6–R7: partnership interest.
  if (intent === "partnership_interest") {
    if (relevance === "not_relevant") {
      return suppression("LOW_RELEVANCE", "R7", "partnership_interest with not_relevant relevance");
    }
    return candidate("partnership_interest", "R6");
  }

  // R8: cancellation / churn signal → retention risk (never a sales action).
  if (intent === "cancellation_or_churn_signal") {
    return candidate("retention_risk", "R8");
  }

  // R9: recovery evidence on a thread with a prior complaint-class suppression
  // → unresolved-complaint opportunity (relationship recovery, still pre-lead).
  if (hasIndicator(interpretation, "support_recovery_moment")) {
    if (history.hasPriorComplaintClassSuppression) {
      return candidate("unresolved_complaint_opportunity", "R9");
    }
    return suppression(
      "NO_OPPORTUNITY_CLASSIFICATION",
      "R12",
      "support_recovery_moment without prior complaint thread evidence"
    );
  }

  // R10: repeated evidenced high-value praise → advocacy (praise alone never
  // becomes a sales opportunity — case 4).
  if (hasIndicator(interpretation, "high_value_praise") || intent === "praise") {
    if (history.hasPriorPraiseClassSuppression) {
      return candidate("referral_or_advocacy", "R10");
    }
    return suppression(
      "NO_OPPORTUNITY_CLASSIFICATION",
      "R12",
      "praise without prior praise thread evidence"
    );
  }

  // R11: support request with an explicit purchase indicator → sales transition.
  if (intent === "support_request") {
    if (hasIndicator(interpretation, "purchase_intent_detected")) {
      return candidate("support_to_sales_transition", "R11");
    }
    return suppression(
      "NO_OPPORTUNITY_CLASSIFICATION",
      "R12",
      "support_request without qualifying opportunity indicator"
    );
  }

  // R13: unknown intent — honest insufficient classification.
  if (intent === "unknown") {
    return suppression("INSUFFICIENT_CLASSIFICATION", "R13", "intent unknown");
  }

  // R14: spam / abuse / irrelevant — never an opportunity.
  if (intent === "spam" || intent === "abuse" || intent === "irrelevant") {
    return suppression("NOT_OPPORTUNITY_SIGNAL", "R14", `intent ${intent}`);
  }

  // R12 catch-all for remaining non-opportunity intents.
  return suppression(
    "NO_OPPORTUNITY_CLASSIFICATION",
    "R12",
    `intent ${intent} carries no opportunity classification`
  );
}

function candidate(opportunityType: OpportunityType, ruleId: string): RuleEvaluation {
  return { outcome: { kind: "candidate", opportunityType, ruleId } };
}

function suppression(reason: SuppressionReason, ruleId: string, detail: string): RuleEvaluation {
  return { outcome: { kind: "suppression", reason, ruleId, detail } };
}

/** True when an intent belongs to the complaint class for R9 thread history. */
export function isComplaintClassIntent(intent: string): boolean {
  return COMPLAINT_CLASS_INTENTS.has(intent);
}

/** True when an intent belongs to the praise class for R10 thread history. */
export function isPraiseClassIntent(intent: string): boolean {
  return intent === "praise";
}
