import {
  randomUUID,
} from "node:crypto";

import type {
  PostLiveLifecycleBatchDeps,
  PostLiveLifecycleBatchReport,
} from "./post-live-lifecycle-batch";

import {
  createDefaultPostLiveLifecycleBatchDeps,
  runPostLiveLifecycleReconciliationPass,
} from "./post-live-lifecycle-pass";

import {
  createRedisPostLiveLifecycleLeaseStore,
  type PostLiveLifecycleLeaseStore,
} from "./post-live-lifecycle-lease";

export const POST_LIVE_LIFECYCLE_LEASE_KEY =
  "natforge:p1:post-live-lifecycle";

export const POST_LIVE_LIFECYCLE_LEASE_TTL_MS =
  120_000;

export const POST_LIVE_LIFECYCLE_HEARTBEAT_MS =
  30_000;

export const POST_LIVE_LIFECYCLE_LEASE_LOST_ERROR =
  "Post-live lifecycle distributed lease ownership lost";

type IntervalHandle =
  ReturnType<typeof setInterval>;

export interface PostLiveLifecycleLeasedPassDeps {
  leaseStore: PostLiveLifecycleLeaseStore;
  batchDeps: PostLiveLifecycleBatchDeps;

  createOwnerToken(): string;

  startInterval(
    callback: () => void,
    intervalMs: number
  ): IntervalHandle;

  stopInterval(
    handle: IntervalHandle
  ): void;
}

export type PostLiveLifecycleLeasedPassResult =
  | {
      status: "lease_contended";
      ran: false;
      leaseKey: string;
    }
  | {
      status:
        | "completed"
        | "lease_lost";
      ran: true;
      leaseKey: string;
      report: PostLiveLifecycleBatchReport;
      releaseSucceeded: boolean;
    };

function assertIsoDate(
  value: string
): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new Error(
      "asOfDate must be YYYY-MM-DD"
    );
  }
}

function assertLeaseTiming(input: {
  ttlMs: number;
  heartbeatMs: number;
}): void {
  if (
    !Number.isInteger(input.ttlMs) ||
    input.ttlMs <= 0
  ) {
    throw new Error(
      "ttlMs must be a positive integer"
    );
  }

  if (
    !Number.isInteger(
      input.heartbeatMs
    ) ||
    input.heartbeatMs <= 0
  ) {
    throw new Error(
      "heartbeatMs must be a positive integer"
    );
  }

  if (
    input.heartbeatMs >= input.ttlMs
  ) {
    throw new Error(
      "heartbeatMs must be less than ttlMs"
    );
  }
}

async function createDefaultDeps():
Promise<PostLiveLifecycleLeasedPassDeps> {
  return {
    leaseStore:
      await createRedisPostLiveLifecycleLeaseStore(),

    batchDeps:
      createDefaultPostLiveLifecycleBatchDeps(),

    createOwnerToken: () =>
      randomUUID(),

    startInterval: (
      callback,
      intervalMs
    ) =>
      setInterval(
        callback,
        intervalMs
      ),

    stopInterval: (handle) =>
      clearInterval(handle),
  };
}

/**
 * Executes one post-live reconciliation pass while holding a distributed lease.
 *
 * Safety properties:
 * - only one owner can acquire the pass lease;
 * - ownership is renewed periodically;
 * - ownership is revalidated immediately before every campaign reconciliation;
 * - if ownership is lost, no subsequent campaign reconciliation is invoked;
 * - a stale owner cannot delete another owner's lease;
 * - one invocation performs only one batch pass;
 * - this function owns no scheduler or startup hook.
 */
export async function runLeaseProtectedPostLiveLifecyclePass(input: {
  asOfDate: string;

  deps?: PostLiveLifecycleLeasedPassDeps;

  leaseKey?: string;
  ttlMs?: number;
  heartbeatMs?: number;
}): Promise<PostLiveLifecycleLeasedPassResult> {
  assertIsoDate(input.asOfDate);

  const leaseKey =
    input.leaseKey ??
    POST_LIVE_LIFECYCLE_LEASE_KEY;

  const ttlMs =
    input.ttlMs ??
    POST_LIVE_LIFECYCLE_LEASE_TTL_MS;

  const heartbeatMs =
    input.heartbeatMs ??
    POST_LIVE_LIFECYCLE_HEARTBEAT_MS;

  assertLeaseTiming({
    ttlMs,
    heartbeatMs,
  });

  const deps =
    input.deps ??
    await createDefaultDeps();

  const ownerToken =
    deps.createOwnerToken();

  if (!ownerToken.trim()) {
    throw new Error(
      "Lease owner token must not be empty"
    );
  }

  const acquired =
    await deps.leaseStore.acquire({
      key: leaseKey,
      ownerToken,
      ttlMs,
    });

  if (!acquired) {
    return {
      status: "lease_contended",
      ran: false,
      leaseKey,
    };
  }

  let leaseLost = false;

  let renewInFlight:
    Promise<boolean> | null = null;

  const renewOwnership =
    async (): Promise<boolean> => {
      if (leaseLost) {
        return false;
      }

      if (renewInFlight) {
        return renewInFlight;
      }

      renewInFlight = (
        async () => {
          try {
            const renewed =
              await deps.leaseStore.renew({
                key: leaseKey,
                ownerToken,
                ttlMs,
              });

            if (!renewed) {
              leaseLost = true;
            }

            return renewed;
          } catch {
            leaseLost = true;
            return false;
          }
        }
      )();

      try {
        return await renewInFlight;
      } finally {
        renewInFlight = null;
      }
    };

  const heartbeatHandle =
    deps.startInterval(
      () => {
        void renewOwnership();
      },
      heartbeatMs
    );

  const guardedBatchDeps:
    PostLiveLifecycleBatchDeps = {
      listCandidateCampaignIds: () =>
        deps.batchDeps
          .listCandidateCampaignIds(),

      reconcileCampaign:
        async (campaignInput) => {
          const stillOwnsLease =
            await renewOwnership();

          if (!stillOwnsLease) {
            throw new Error(
              POST_LIVE_LIFECYCLE_LEASE_LOST_ERROR
            );
          }

          return deps.batchDeps
            .reconcileCampaign(
              campaignInput
            );
        },
    };

  let report:
    PostLiveLifecycleBatchReport |
    null = null;

  let passError: unknown = null;
  let releaseSucceeded = false;

  try {
    report =
      await runPostLiveLifecycleReconciliationPass({
        asOfDate: input.asOfDate,
        deps: guardedBatchDeps,
      });
  } catch (error) {
    passError = error;
  } finally {
    deps.stopInterval(
      heartbeatHandle
    );

    if (renewInFlight) {
      try {
        await renewInFlight;
      } catch {
        leaseLost = true;
      }
    }

    try {
      releaseSucceeded =
        await deps.leaseStore.release({
          key: leaseKey,
          ownerToken,
        });
    } catch {
      releaseSucceeded = false;
    }
  }

  if (passError) {
    throw passError;
  }

  if (!report) {
    throw new Error(
      "Post-live lifecycle pass completed without a report"
    );
  }

  return {
    status:
      leaseLost
        ? "lease_lost"
        : "completed",
    ran: true,
    leaseKey,
    report,
    releaseSucceeded,
  };
}