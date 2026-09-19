import type {
  PostLiveLifecycleReconcileResult,
} from "./post-live-lifecycle-driver";

export interface PostLiveLifecycleBatchDeps {
  /**
   * Returns candidate campaign IDs for one reconciliation pass.
   * The DB-backed candidate selector is intentionally wired separately.
   */
  listCandidateCampaignIds(): Promise<number[]>;

  /**
   * Reconciles one campaign once.
   * The implementation must not retry internally.
   */
  reconcileCampaign(input: {
    campaignId: number;
    asOfDate: string;
  }): Promise<PostLiveLifecycleReconcileResult>;
}

export type PostLiveLifecycleBatchItemResult =
  | {
      campaignId: number;
      status: "transitioned";
      previousState: string;
      nextState: string;
    }
  | {
      campaignId: number;
      status: "no_transition";
      previousState: string;
    }
  | {
      campaignId: number;
      status: "not_found";
    }
  | {
      campaignId: number;
      status: "failed";
      error: string;
    };

export interface PostLiveLifecycleBatchReport {
  asOfDate: string;
  candidateCount: number;
  attempted: number;
  transitioned: number;
  noTransition: number;
  notFound: number;
  failed: number;
  results: PostLiveLifecycleBatchItemResult[];
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("asOfDate must be YYYY-MM-DD");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Executes one controlled post-live reconciliation pass.
 *
 * Guarantees:
 * - each unique campaign ID is attempted at most once per pass;
 * - campaigns are processed sequentially;
 * - one campaign failure does not stop later candidates;
 * - no internal retries;
 * - no scheduler/timer ownership;
 * - no hidden clock access: authority date is supplied by the caller.
 */
export async function reconcilePostLiveCampaignBatch(input: {
  asOfDate: string;
  deps: PostLiveLifecycleBatchDeps;
}): Promise<PostLiveLifecycleBatchReport> {
  assertIsoDate(input.asOfDate);

  const listedIds =
    await input.deps.listCandidateCampaignIds();

  const candidateIds = Array.from(
    new Set(
      listedIds.filter(
        (campaignId) =>
          Number.isInteger(campaignId) &&
          campaignId > 0
      )
    )
  );

  const report: PostLiveLifecycleBatchReport = {
    asOfDate: input.asOfDate,
    candidateCount: candidateIds.length,
    attempted: 0,
    transitioned: 0,
    noTransition: 0,
    notFound: 0,
    failed: 0,
    results: [],
  };

  for (const campaignId of candidateIds) {
    report.attempted += 1;

    try {
      const result =
        await input.deps.reconcileCampaign({
          campaignId,
          asOfDate: input.asOfDate,
        });

      if (result.status === "transitioned") {
        report.transitioned += 1;
        report.results.push({
          campaignId,
          status: "transitioned",
          previousState: result.previousState,
          nextState: result.nextState,
        });

        continue;
      }

      if (result.status === "no_transition") {
        report.noTransition += 1;
        report.results.push({
          campaignId,
          status: "no_transition",
          previousState: result.previousState,
        });

        continue;
      }

      report.notFound += 1;
      report.results.push({
        campaignId,
        status: "not_found",
      });
    } catch (error) {
      report.failed += 1;
      report.results.push({
        campaignId,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  return report;
}