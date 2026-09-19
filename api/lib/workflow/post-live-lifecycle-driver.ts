import {
  decidePostLiveLifecycleAction,
  type PostLiveLifecycleAction,
  type PostLiveLifecycleDecision,
  type PostLiveLifecycleState,
} from "./post-live-lifecycle-authority";

export interface PostLiveLifecycleSnapshot {
  campaignId: number;
  userId: number;
  workflowState: PostLiveLifecycleState;
  endDate: string | Date | null;

  /**
   * Durable timestamp proving the beginning of the current live lifecycle.
   *
   * The DB-backed adapter will derive this from governed publication evidence.
   * Evidence-driven transitions must not use historical lead/Learning records
   * when this anchor is unavailable.
   */
  liveAnchorAt: Date | null;

  /** Current-lifecycle evidence only. */
  hasLeadEvidenceSinceLive: boolean;

  /** Current-lifecycle evidence only. */
  hasLearningEvidenceSinceLive: boolean;
}

export interface PostLiveLifecycleReconcileDeps {
  loadSnapshot(campaignId: number): Promise<PostLiveLifecycleSnapshot | null>;

  transition(
    campaignId: number,
    userId: number,
    action: PostLiveLifecycleAction
  ): Promise<PostLiveLifecycleState>;
}

export type PostLiveLifecycleReconcileResult =
  | {
      status: "not_found";
      campaignId: number;
      transitioned: false;
    }
  | {
      status: "no_transition";
      campaignId: number;
      previousState: PostLiveLifecycleState;
      transitioned: false;
      decision: PostLiveLifecycleDecision;
      evidenceAuthority:
        | "not_required"
        | "current_lifecycle_anchor_present"
        | "current_lifecycle_anchor_missing";
    }
  | {
      status: "transitioned";
      campaignId: number;
      previousState: PostLiveLifecycleState;
      nextState: PostLiveLifecycleState;
      transitioned: true;
      decision: PostLiveLifecycleDecision;
      evidenceAuthority:
        | "not_required"
        | "current_lifecycle_anchor_present";
    };

function actionNeedsLifecycleEvidence(action: PostLiveLifecycleAction | null): boolean {
  return action === "start_lead_conversion" || action === "start_optimisation";
}

/**
 * Reconciles at most one post-live transition for one campaign.
 *
 * Deliberately NOT responsible for:
 * - database queries;
 * - scheduling;
 * - retries;
 * - loops through multiple states;
 * - generating Learning;
 * - creating leads;
 * - inventing evidence.
 *
 * A caller may safely invoke this function repeatedly. Each invocation evaluates
 * the latest durable snapshot and can execute no more than one workflow action.
 */
export async function reconcilePostLiveCampaign(input: {
  campaignId: number;
  asOfDate: string;
  deps: PostLiveLifecycleReconcileDeps;
}): Promise<PostLiveLifecycleReconcileResult> {
  const snapshot = await input.deps.loadSnapshot(input.campaignId);

  if (!snapshot) {
    return {
      status: "not_found",
      campaignId: input.campaignId,
      transitioned: false,
    };
  }

  const evidenceAuthority = snapshot.liveAnchorAt
    ? "current_lifecycle_anchor_present"
    : "current_lifecycle_anchor_missing";

  const decision = decidePostLiveLifecycleAction({
    workflowState: snapshot.workflowState,
    endDate: snapshot.endDate,
    asOfDate: input.asOfDate,

    // Evidence-driven progression must fail closed if the current lifecycle
    // cannot be durably anchored.
    hasLeadEvidence:
      !!snapshot.liveAnchorAt && snapshot.hasLeadEvidenceSinceLive,

    hasLearningEvidence:
      !!snapshot.liveAnchorAt && snapshot.hasLearningEvidenceSinceLive,
  });

  if (!decision.action) {
    return {
      status: "no_transition",
      campaignId: snapshot.campaignId,
      previousState: snapshot.workflowState,
      transitioned: false,
      decision,
      evidenceAuthority:
        decision.reason === "already_completed" ||
        decision.reason === "awaiting_campaign_end"
          ? "not_required"
          : evidenceAuthority,
    };
  }

  if (actionNeedsLifecycleEvidence(decision.action) && !snapshot.liveAnchorAt) {
    return {
      status: "no_transition",
      campaignId: snapshot.campaignId,
      previousState: snapshot.workflowState,
      transitioned: false,
      decision: {
        action: null,
        reason:
          snapshot.workflowState === "leads_converting"
            ? "awaiting_learning_evidence"
            : "awaiting_lead_or_learning_evidence",
      },
      evidenceAuthority: "current_lifecycle_anchor_missing",
    };
  }

  const nextState = await input.deps.transition(
    snapshot.campaignId,
    snapshot.userId,
    decision.action
  );

  return {
    status: "transitioned",
    campaignId: snapshot.campaignId,
    previousState: snapshot.workflowState,
    nextState,
    transitioned: true,
    decision,
    evidenceAuthority: actionNeedsLifecycleEvidence(decision.action)
      ? "current_lifecycle_anchor_present"
      : "not_required",
  };
}