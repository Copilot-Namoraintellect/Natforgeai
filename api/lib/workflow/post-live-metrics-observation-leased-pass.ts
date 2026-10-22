/**
 * Lease-protected post-live metrics observation pass (WBS-R1.5).
 *
 * Distributed singleton layer for the observation pass: a Redis lease,
 * SEPARATE from the post-live lifecycle lease, guards every pass. The lease
 * is acquired with SET NX + PX, renewed on a heartbeat, revalidated before
 * every candidate observation, and released in a finally block — a stale
 * owner can neither observe candidates nor delete another owner's lease.
 *
 * This module owns no scheduler or startup hook.
 */

import { randomUUID } from "node:crypto";

import {
  createRedisPostLiveLifecycleLeaseStore,
  type PostLiveLifecycleLeaseStore,
} from "./post-live-lifecycle-lease";

import {
  createDefaultPostLiveMetricsObservationPassDeps,
  runPostLiveMetricsObservationPass,
  type PostLiveMetricsObservationPassDeps,
  type PostLiveMetricsObservationPassReport,
} from "./post-live-metrics-observation-pass";

/** Dedicated lease key — never shared with the post-live lifecycle lease. */
export const POST_LIVE_METRICS_OBSERVATION_LEASE_KEY =
  "natforge:p1:post-live-metrics-observation";

export const POST_LIVE_METRICS_OBSERVATION_LEASE_TTL_MS = 120_000;

export const POST_LIVE_METRICS_OBSERVATION_HEARTBEAT_MS = 30_000;

export const POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR =
  "Post-live metrics observation distributed lease ownership lost";

type IntervalHandle = ReturnType<typeof setInterval>;

export interface PostLiveMetricsObservationLeasedPassDeps {
  leaseStore: PostLiveLifecycleLeaseStore;
  passDeps: PostLiveMetricsObservationPassDeps;

  createOwnerToken(): string;

  startInterval(callback: () => void, intervalMs: number): IntervalHandle;

  stopInterval(handle: IntervalHandle): void;
}

export type PostLiveMetricsObservationLeasedPassResult =
  | { status: "lease_contended"; ran: false; leaseKey: string }
  | {
      status: "completed" | "lease_lost";
      ran: true;
      leaseKey: string;
      report: PostLiveMetricsObservationPassReport;
      releaseSucceeded: boolean;
    };

function assertLeaseTiming(input: { ttlMs: number; heartbeatMs: number }): void {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("ttlMs must be a positive integer");
  }
  if (!Number.isInteger(input.heartbeatMs) || input.heartbeatMs <= 0) {
    throw new Error("heartbeatMs must be a positive integer");
  }
  if (input.heartbeatMs >= input.ttlMs) {
    throw new Error("heartbeatMs must be less than ttlMs");
  }
}

async function createDefaultDeps(): Promise<PostLiveMetricsObservationLeasedPassDeps> {
  return {
    leaseStore: await createRedisPostLiveLifecycleLeaseStore(),
    passDeps: createDefaultPostLiveMetricsObservationPassDeps(),
    createOwnerToken: () => randomUUID(),
    startInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    stopInterval: handle => clearInterval(handle),
  };
}

/**
 * Executes one due-only metrics observation pass while holding the
 * dedicated distributed lease. Ownership is revalidated before EVERY
 * candidate observation; once lost, no further candidate is observed.
 */
export async function runLeaseProtectedPostLiveMetricsObservationPass(input: {
  asOfDate: string;
  deps?: PostLiveMetricsObservationLeasedPassDeps;
  leaseKey?: string;
  ttlMs?: number;
  heartbeatMs?: number;
}): Promise<PostLiveMetricsObservationLeasedPassResult> {
  const leaseKey = input.leaseKey ?? POST_LIVE_METRICS_OBSERVATION_LEASE_KEY;
  const ttlMs = input.ttlMs ?? POST_LIVE_METRICS_OBSERVATION_LEASE_TTL_MS;
  const heartbeatMs = input.heartbeatMs ?? POST_LIVE_METRICS_OBSERVATION_HEARTBEAT_MS;

  assertLeaseTiming({ ttlMs, heartbeatMs });

  const deps = input.deps ?? (await createDefaultDeps());

  const ownerToken = deps.createOwnerToken();
  if (!ownerToken.trim()) {
    throw new Error("Lease owner token must not be empty");
  }

  const acquired = await deps.leaseStore.acquire({ key: leaseKey, ownerToken, ttlMs });
  if (!acquired) {
    return { status: "lease_contended", ran: false, leaseKey };
  }

  let leaseLost = false;
  let renewInFlight: Promise<boolean> | null = null;

  const renewOwnership = async (): Promise<boolean> => {
    if (leaseLost) return false;
    if (renewInFlight) return renewInFlight;

    renewInFlight = (async () => {
      try {
        const renewed = await deps.leaseStore.renew({ key: leaseKey, ownerToken, ttlMs });
        if (!renewed) leaseLost = true;
        return renewed;
      } catch {
        leaseLost = true;
        return false;
      }
    })();

    try {
      return await renewInFlight;
    } finally {
      renewInFlight = null;
    }
  };

  const heartbeatHandle = deps.startInterval(() => {
    void renewOwnership();
  }, heartbeatMs);

  // Revalidate ownership immediately before every candidate observation.
  const guardedPassDeps: PostLiveMetricsObservationPassDeps = {
    listPublishedCandidates: () => deps.passDeps.listPublishedCandidates(),
    loadLastObservedAt: candidate => deps.passDeps.loadLastObservedAt(candidate),
    resolveBinding: platform => deps.passDeps.resolveBinding(platform),
    persistObservations: async persistInput => {
      const stillOwnsLease = await renewOwnership();
      if (!stillOwnsLease) {
        throw new Error(POST_LIVE_METRICS_OBSERVATION_LEASE_LOST_ERROR);
      }
      return deps.passDeps.persistObservations(persistInput);
    },
  };

  let report: PostLiveMetricsObservationPassReport | null = null;
  let passError: unknown = null;
  let releaseSucceeded = false;

  try {
    report = await runPostLiveMetricsObservationPass({
      asOfDate: input.asOfDate,
      deps: guardedPassDeps,
    });
  } catch (error) {
    passError = error;
  } finally {
    deps.stopInterval(heartbeatHandle);

    if (renewInFlight) {
      try {
        await renewInFlight;
      } catch {
        leaseLost = true;
      }
    }

    try {
      releaseSucceeded = await deps.leaseStore.release({ key: leaseKey, ownerToken });
    } catch {
      releaseSucceeded = false;
    }
  }

  if (passError) throw passError;
  if (!report) {
    throw new Error("Post-live metrics observation pass completed without a report");
  }

  return {
    status: leaseLost ? "lease_lost" : "completed",
    ran: true,
    leaseKey,
    report,
    releaseSucceeded,
  };
}
