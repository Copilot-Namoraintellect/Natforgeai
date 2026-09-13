import { TRPCError } from "@trpc/server";
import {
  renewImageRenderClaimLease,
  type ImageRenderLeaseRenewalResult,
} from "./image-render-claim";

// ─── Dormant image-render claim heartbeat (Slice C1) ───
//
// Owns periodic lease renewal ONLY, for a claim the caller already owns. It
// never acquires, rearms, fails, finalizes, renders, stores, or bills, and it
// performs no stale takeover or recovery — Slice C2+ owns those. Safety
// contract:
//   - a renewal result of { renewed: false } (expired lease, wrong owner,
//     terminal state) marks ownership as lost;
//   - a thrown renewal error (database/liveness failure) also marks ownership
//     as lost — the controller fails closed;
//   - once ownership is lost, no further heartbeats are scheduled and
//     assertStillOwned() rejects with the sanitized B2B-4 machine code;
//   - stop() clears future scheduling, awaits any in-flight renewal, and is
//     safe to call repeatedly;
//   - heartbeat failures can never surface as unhandled promise rejections;
//   - the owner token is never logged.
//
// An expired lease is NEVER revived: renewal uses database NOW() inside the
// primitive, so an expired lease stays expired and remains trustworthy
// evidence for later Slice C recovery.

export const IMAGE_RENDER_CLAIM_HEARTBEAT_INTERVAL_MS = 2 * 60_000;
export const IMAGE_RENDER_CLAIM_HEARTBEAT_LEASE_SECONDS = 10 * 60;

export interface ImageRenderClaimHeartbeatHandle {
  readonly lostOwnership: boolean;
  assertStillOwned(): Promise<void>;
  stop(): Promise<void>;
}

export interface ImageRenderClaimHeartbeatDeps {
  claimId: number;
  ownerToken: string;
  renew?: (args: {
    claimId: number;
    ownerToken: string;
    leaseSeconds: number;
  }) => Promise<ImageRenderLeaseRenewalResult>;
  intervalMs?: number;
  leaseSeconds?: number;
  setTimeoutFn?: (handler: () => void, timeout: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

function assertValidPositiveId(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid ${name}: ${String(value)}` });
  }
}

export function createImageRenderClaimHeartbeat(
  deps: ImageRenderClaimHeartbeatDeps
): ImageRenderClaimHeartbeatHandle {
  assertValidPositiveId(deps.claimId, "claimId");
  if (
    typeof deps.ownerToken !== "string" ||
    deps.ownerToken.length === 0 ||
    deps.ownerToken.length > 64
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid ownerToken: must be 1-64 characters",
    });
  }
  const renew = deps.renew ?? ((args) => renewImageRenderClaimLease(args));
  const intervalMs = deps.intervalMs ?? IMAGE_RENDER_CLAIM_HEARTBEAT_INTERVAL_MS;
  const leaseSeconds = deps.leaseSeconds ?? IMAGE_RENDER_CLAIM_HEARTBEAT_LEASE_SECONDS;
  const setTimeoutFn = deps.setTimeoutFn ?? ((handler, timeout) => setTimeout(handler, timeout));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));

  let lostOwnership = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;

  const schedule = (): void => {
    if (stopped || lostOwnership) {
      return;
    }
    timer = setTimeoutFn(tick, intervalMs);
  };

  const runRenewal = async (): Promise<void> => {
    try {
      const result = await renew({
        claimId: deps.claimId,
        ownerToken: deps.ownerToken,
        leaseSeconds,
      });
      if (result.renewed !== true) {
        lostOwnership = true;
      }
    } catch {
      // Liveness/renewal failure: fail closed. Never logged, never retried.
      lostOwnership = true;
    }
  };

  const tick = (): void => {
    if (stopped || lostOwnership || inFlight !== null) {
      return;
    }
    const run = runRenewal().finally(() => {
      inFlight = null;
      if (!stopped && !lostOwnership) {
        schedule();
      }
    });
    inFlight = run;
    // Defensive: runRenewal already swallows all errors, so this never fires;
    // it guarantees no unhandled rejection can ever escape the controller.
    run.catch(() => {
      lostOwnership = true;
    });
  };

  schedule();

  return {
    get lostOwnership() {
      return lostOwnership;
    },
    async assertStillOwned(): Promise<void> {
      if (lostOwnership) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "CLAIM_SUBSYSTEM_UNAVAILABLE",
        });
      }
    },
    async stop(): Promise<void> {
      if (stopped && timer === null && inFlight === null) {
        return;
      }
      stopped = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight.catch(() => undefined);
      }
    },
  };
}
