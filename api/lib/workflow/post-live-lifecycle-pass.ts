import {
  asc,
  eq,
  or,
} from "drizzle-orm";

import {
  campaigns,
} from "@db/schema";

import {
  getDb,
} from "../../queries/connection";

import {
  reconcilePostLiveCampaignBatch,
  type PostLiveLifecycleBatchDeps,
  type PostLiveLifecycleBatchReport,
} from "./post-live-lifecycle-batch";

import {
  reconcilePostLiveCampaignFromDb,
} from "./post-live-lifecycle-db";

export interface PostLiveLifecycleCandidateStore {
  listCandidateCampaignIds(): Promise<number[]>;
}

/**
 * Durable candidate selection for one post-live reconciliation pass.
 *
 * Only states that may legitimately advance are returned.
 * Completed campaigns are terminal and therefore excluded.
 */
export function createDrizzlePostLiveLifecycleCandidateStore():
PostLiveLifecycleCandidateStore {
  const db = getDb();

  return {
    async listCandidateCampaignIds() {
      const rows = await db
        .select({
          id: campaigns.id,
        })
        .from(campaigns)
        .where(
          or(
            eq(
              campaigns.workflowState,
              "campaign_live"
            ),
            eq(
              campaigns.workflowState,
              "engagement_active"
            ),
            eq(
              campaigns.workflowState,
              "leads_converting"
            ),
            eq(
              campaigns.workflowState,
              "optimisation_active"
            )
          )
        )
        .orderBy(asc(campaigns.id));

      return rows.map((row) => row.id);
    },
  };
}

export function createDefaultPostLiveLifecycleBatchDeps():
PostLiveLifecycleBatchDeps {
  const candidateStore =
    createDrizzlePostLiveLifecycleCandidateStore();

  return {
    listCandidateCampaignIds: () =>
      candidateStore.listCandidateCampaignIds(),

    reconcileCampaign: ({
      campaignId,
      asOfDate,
    }) =>
      reconcilePostLiveCampaignFromDb({
        campaignId,
        asOfDate,
      }),
  };
}

/**
 * Executes exactly one database-backed post-live lifecycle reconciliation pass.
 *
 * This function deliberately owns no timer, interval, cron expression or
 * process startup behaviour. A runtime scheduler may call it later, but
 * scheduler ownership remains outside this module.
 */
export async function runPostLiveLifecycleReconciliationPass(input: {
  asOfDate: string;
  deps?: PostLiveLifecycleBatchDeps;
}): Promise<PostLiveLifecycleBatchReport> {
  return reconcilePostLiveCampaignBatch({
    asOfDate: input.asOfDate,
    deps:
      input.deps ??
      createDefaultPostLiveLifecycleBatchDeps(),
  });
}