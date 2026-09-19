export type PostLiveLifecycleState =
  | "campaign_live"
  | "engagement_active"
  | "leads_converting"
  | "optimisation_active"
  | "completed";

export type PostLiveLifecycleAction =
  | "start_engagement"
  | "start_lead_conversion"
  | "start_optimisation"
  | "complete_campaign";

export interface PostLiveLifecycleEvidence {
  workflowState: PostLiveLifecycleState;
  /**
   * Campaign end date. Campaign dates are inclusive, so autonomous completion
   * becomes eligible only when asOfDate is later than endDate.
   */
  endDate: string | Date | null;
  /**
   * Deterministic YYYY-MM-DD authority date supplied by the caller.
   * The database-backed driver owns the clock/timezone decision.
   */
  asOfDate: string;
  /**
   * Durable campaign-linked lead evidence for the current lifecycle.
   * The database-backed driver is responsible for filtering stale evidence.
   */
  hasLeadEvidence: boolean;
  /**
   * Durable campaign-linked Learning evidence for the current lifecycle.
   * The database-backed driver is responsible for filtering stale evidence.
   */
  hasLearningEvidence: boolean;
}

export interface PostLiveLifecycleDecision {
  action: PostLiveLifecycleAction | null;
  reason:
    | "campaign_ended"
    | "engagement_phase_start"
    | "lead_evidence_present"
    | "learning_evidence_present"
    | "awaiting_lead_or_learning_evidence"
    | "awaiting_learning_evidence"
    | "awaiting_campaign_end"
    | "already_completed";
}

function toIsoDate(value: string | Date | null): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? null;
  }

  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("asOfDate must be YYYY-MM-DD");
  }
}

/**
 * Decides at most one governed post-live workflow transition.
 *
 * This function is intentionally pure:
 * - no database access;
 * - no timers;
 * - no workflow mutation;
 * - no inferred engagement/lead/performance facts.
 *
 * Priority:
 * 1. An explicitly ended campaign may complete from any active post-live state.
 * 2. A genuinely live campaign enters engagement monitoring.
 * 3. Durable lead evidence opens lead conversion.
 * 4. Durable Learning evidence opens optimisation.
 * 5. Otherwise the campaign remains in its current state.
 */
export function decidePostLiveLifecycleAction(
  evidence: PostLiveLifecycleEvidence
): PostLiveLifecycleDecision {
  assertIsoDate(evidence.asOfDate);

  if (evidence.workflowState === "completed") {
    return {
      action: null,
      reason: "already_completed",
    };
  }

  const endDate = toIsoDate(evidence.endDate);

  // endDate is inclusive. Complete only on a later calendar date.
  if (endDate && endDate < evidence.asOfDate) {
    return {
      action: "complete_campaign",
      reason: "campaign_ended",
    };
  }

  if (evidence.workflowState === "campaign_live") {
    return {
      action: "start_engagement",
      reason: "engagement_phase_start",
    };
  }

  if (evidence.workflowState === "engagement_active") {
    // When both exist, preserve the legitimate lead-conversion stage first.
    // A subsequent reconciliation may then advance to optimisation.
    if (evidence.hasLeadEvidence) {
      return {
        action: "start_lead_conversion",
        reason: "lead_evidence_present",
      };
    }

    // No lead evidence is required for optimisation: performance Learning may
    // legitimately exist for campaigns that generated no leads.
    if (evidence.hasLearningEvidence) {
      return {
        action: "start_optimisation",
        reason: "learning_evidence_present",
      };
    }

    return {
      action: null,
      reason: "awaiting_lead_or_learning_evidence",
    };
  }

  if (evidence.workflowState === "leads_converting") {
    if (evidence.hasLearningEvidence) {
      return {
        action: "start_optimisation",
        reason: "learning_evidence_present",
      };
    }

    return {
      action: null,
      reason: "awaiting_learning_evidence",
    };
  }

  return {
    action: null,
    reason: "awaiting_campaign_end",
  };
}