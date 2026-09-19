import {
  and,
  eq,
  gte,
} from "drizzle-orm";

import {
  campaigns,
  leads,
  leadScores,
  learningRecords,
} from "@db/schema";

import {
  getDb,
} from "../../queries/connection";

import {
  transitionCampaignState,
} from "./engine";

import {
  readCampaignLiveAtFromWorkflowContext,
} from "./post-live-lifecycle-anchor";

import {
  reconcilePostLiveCampaign,
  type PostLiveLifecycleReconcileDeps,
  type PostLiveLifecycleReconcileResult,
  type PostLiveLifecycleSnapshot,
} from "./post-live-lifecycle-driver";

import type {
  PostLiveLifecycleState,
} from "./post-live-lifecycle-authority";

const POST_LIVE_STATES:
readonly PostLiveLifecycleState[] = [
  "campaign_live",
  "engagement_active",
  "leads_converting",
  "optimisation_active",
  "completed",
];

function isPostLiveLifecycleState(
  value: string
): value is PostLiveLifecycleState {
  return (
    POST_LIVE_STATES as
    readonly string[]
  ).includes(value);
}

export interface PostLiveCampaignRow {
  id: number;
  userId: number;
  workflowState: string;
  endDate:
    | string
    | Date
    | null;
  workflowContext: unknown;
}

export interface PostLiveLifecycleEvidenceStore {
  getCampaign(
    campaignId: number
  ): Promise<
    PostLiveCampaignRow |
    null
  >;

  hasLeadCreatedSince(
    campaignId: number,
    userId: number,
    since: Date
  ): Promise<boolean>;

  hasLeadScoreSince(
    campaignId: number,
    userId: number,
    since: Date
  ): Promise<boolean>;

  hasLearningSince(
    campaignId: number,
    userId: number,
    since: Date
  ): Promise<boolean>;
}

/**
 * Durable evidence reader.
 *
 * Lifecycle evidence is anchored to the immutable governed campaignLiveAt
 * stored in workflowContext, not to mutable publication timestamps.
 *
 * This prevents republishing, retries or later publication activity from
 * moving the post-live evidence boundary forward.
 */
export function createDrizzlePostLiveLifecycleEvidenceStore():
PostLiveLifecycleEvidenceStore {
  const db = getDb();

  return {
    async getCampaign(
      campaignId
    ) {
      const rows =
        await db
          .select({
            id:
              campaigns.id,
            userId:
              campaigns.userId,
            workflowState:
              campaigns.workflowState,
            endDate:
              campaigns.endDate,
            workflowContext:
              campaigns.workflowContext,
          })
          .from(campaigns)
          .where(
            eq(
              campaigns.id,
              campaignId
            )
          )
          .limit(1);

      const campaign =
        rows[0];

      if (!campaign) {
        return null;
      }

      return {
        id:
          campaign.id,
        userId:
          campaign.userId,
        workflowState:
          campaign.workflowState,
        endDate:
          campaign.endDate,
        workflowContext:
          campaign.workflowContext,
      };
    },

    async hasLeadCreatedSince(
      campaignId,
      userId,
      since
    ) {
      const rows =
        await db
          .select({
            id: leads.id,
          })
          .from(leads)
          .where(
            and(
              eq(
                leads.campaignId,
                campaignId
              ),
              eq(
                leads.userId,
                userId
              ),
              gte(
                leads.createdAt,
                since
              )
            )
          )
          .limit(1);

      return rows.length > 0;
    },

    async hasLeadScoreSince(
      campaignId,
      userId,
      since
    ) {
      const rows =
        await db
          .select({
            id:
              leadScores.id,
          })
          .from(leadScores)
          .where(
            and(
              eq(
                leadScores.campaignId,
                campaignId
              ),
              eq(
                leadScores.userId,
                userId
              ),
              gte(
                leadScores.scoredAt,
                since
              )
            )
          )
          .limit(1);

      return rows.length > 0;
    },

    async hasLearningSince(
      campaignId,
      userId,
      since
    ) {
      const rows =
        await db
          .select({
            id:
              learningRecords.id,
          })
          .from(
            learningRecords
          )
          .where(
            and(
              eq(
                learningRecords.campaignId,
                campaignId
              ),
              eq(
                learningRecords.userId,
                userId
              ),
              gte(
                learningRecords.evaluatedAt,
                since
              )
            )
          )
          .limit(1);

      return rows.length > 0;
    },
  };
}

/**
 * Builds one post-live snapshot entirely from durable persisted evidence.
 *
 * The immutable live boundary comes from workflowContext.campaignLiveAt.
 *
 * For P1.1 campaigns that are already campaign_live when this code is first
 * introduced, the original go_live lastTransition is accepted as the legacy
 * anchor. The first governed transition out of campaign_live then backfills
 * campaignLiveAt permanently.
 *
 * If neither durable authority exists, evidence reads fail closed.
 */
export async function loadPostLiveLifecycleSnapshot(
  input: {
    campaignId: number;
    store:
      PostLiveLifecycleEvidenceStore;
  }
): Promise<
  PostLiveLifecycleSnapshot |
  null
> {
  const campaign =
    await input.store
      .getCampaign(
        input.campaignId
      );

  if (!campaign) {
    return null;
  }

  if (
    !isPostLiveLifecycleState(
      campaign.workflowState
    )
  ) {
    return null;
  }

  const liveAnchorAt =
    readCampaignLiveAtFromWorkflowContext(
      campaign.workflowContext
    );

  let hasLeadEvidenceSinceLive =
    false;

  let hasLearningEvidenceSinceLive =
    false;

  if (liveAnchorAt) {
    const [
      hasLead,
      hasLeadScore,
      hasLearning,
    ] =
      await Promise.all([
        input.store
          .hasLeadCreatedSince(
            campaign.id,
            campaign.userId,
            liveAnchorAt
          ),

        input.store
          .hasLeadScoreSince(
            campaign.id,
            campaign.userId,
            liveAnchorAt
          ),

        input.store
          .hasLearningSince(
            campaign.id,
            campaign.userId,
            liveAnchorAt
          ),
      ]);

    hasLeadEvidenceSinceLive =
      hasLead ||
      hasLeadScore;

    hasLearningEvidenceSinceLive =
      hasLearning;
  }

  return {
    campaignId:
      campaign.id,
    userId:
      campaign.userId,
    workflowState:
      campaign.workflowState,
    endDate:
      campaign.endDate,
    liveAnchorAt,
    hasLeadEvidenceSinceLive,
    hasLearningEvidenceSinceLive,
  };
}

export function createDefaultPostLiveLifecycleReconcileDeps():
PostLiveLifecycleReconcileDeps {
  const store =
    createDrizzlePostLiveLifecycleEvidenceStore();

  return {
    loadSnapshot:
      (campaignId) =>
        loadPostLiveLifecycleSnapshot({
          campaignId,
          store,
        }),

    transition:
      async (
        campaignId,
        userId,
        action
      ) => {
        const nextState =
          await transitionCampaignState(
            campaignId,
            userId,
            action
          );

        if (
          !isPostLiveLifecycleState(
            nextState
          )
        ) {
          throw new Error(
            `Post-live lifecycle transition "${action}" returned unexpected state "${nextState}".`
          );
        }

        return nextState;
      },
  };
}

/**
 * Database-backed single-campaign entry point.
 *
 * Performs at most one governed lifecycle transition.
 * It does not schedule itself, loop through states, generate Learning,
 * create leads or retry a failed transition.
 */
export async function reconcilePostLiveCampaignFromDb(
  input: {
    campaignId: number;
    asOfDate: string;
    deps?:
      PostLiveLifecycleReconcileDeps;
  }
): Promise<
  PostLiveLifecycleReconcileResult
> {
  return reconcilePostLiveCampaign({
    campaignId:
      input.campaignId,
    asOfDate:
      input.asOfDate,
    deps:
      input.deps ??
      createDefaultPostLiveLifecycleReconcileDeps(),
  });
}