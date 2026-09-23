import { TRPCError } from "@trpc/server";
import {
  deriveImageRenderAttemptIdentity,
  getCompletedImageRenderResult,
  type GetCompletedImageRenderResultResult,
  type ImageRenderReplayResult,
} from "./image-render-claim";
import {
  coordinateImageRenderAttempt,
  createDefaultImageRenderClaimCoordinatorDeps,
  type ImageRenderClaimCoordinatorDeps,
  type ImageRenderClaimOwnerContext,
  type ImageRenderCoordinatorInput,
  type ImageRenderCoordinatorIntent,
  type ImageRenderCoordinatorResult,
} from "./image-render-claim-coordinator";
import type { ImageRenderLineageInput } from "./image-render-lineage";

// ─── Dormant image-render claim replay gate (B2B-2B) ───
//
// Pure orchestration boundary that composes exactly four established
// primitives — deriveImageRenderAttemptIdentity, coordinateImageRenderAttempt,
// getCompletedImageRenderResult, and a safe replay-response projection — into
// one closed decision for a single logical premium-image attempt. This module
// adds no hashing, no canonicalization, no classification, and no database
// queries of its own; every identity, classification, and lookup is delegated.
//
// TRUST BOUNDARY — caller preconditions (enforced by the future request owner,
// NOT by this gate):
//   1. userId must come from authoritative authenticated server context.
//   2. contentPostId must be verified as owned by that userId BEFORE calling.
// This gate performs no ownership lookup and accepts no caller-controlled
// "ownershipVerified" flag, no campaign identity, and no campaign sentinel.
//
// DORMANCY: production integration is forbidden until B2B-3. Nothing in the
// production request path imports or invokes this module; it renders nothing,
// bills nothing, persists nothing, and performs no claim mutation of its own —
// total claim mutation is controlled solely by the existing coordinator.
//
// AUTHORIZATION SEMANTICS of the closed result union:
//   - proceed (acquired/rearmed): authorizes ONLY entry into future
//     fresh-generation orchestration. It does not independently authorize
//     billing; deduction still flows through the existing credit engine under
//     the coordinator's owner context.
//   - replay: authorizes returning a verified stored result only. It
//     authorizes no rendering and no billing — the original attempt already
//     settled its deduction.
//   - blocked / unavailable: authorize no work at all.
//
// Raw clientAttemptId, raw refinement/guidance text, ownerToken,
// activeClaimKey, requestAttemptKey, intentFingerprint, deductionKey,
// deductionRecorded, claim ids, generated-image ids, completion timestamps and
// dependency errors are never returned in non-proceed results and must never
// be logged or serialized by callers. Only proceed carries the coordinator's
// opaque, frozen owner context, passed through by reference — never cloned,
// reconstructed, widened, or serialized here.

export type ImageRenderClaimGateIntent = ImageRenderCoordinatorIntent;

export interface ImageRenderClaimGateInput {
  /** Authoritative authenticated user id (caller-verified). */
  userId: number;
  /** Authoritative content post id, verified owned by userId (caller-verified). */
  contentPostId: number;
  /** Validated client attempt token. Never returned, persisted, or logged. */
  clientAttemptId: string;
  /** Complete material render intent — all ten B1 fields. */
  intent: ImageRenderClaimGateIntent;
  /**
   * Production lineage authority (WBS12D) bound into the attempt
   * intentFingerprint before classification; a completed attempt under
   * different authority is never replayed (intent_conflict).
   */
  lineage?: ImageRenderLineageInput | null;
  /** Ownership credential proposed by the future request owner. */
  ownerToken: string;
  /** Proposed lease expiry for the claim row (concrete Date only). */
  leaseExpiresAt: Date;
}

export interface ImageRenderClaimGateDeps {
  /** Injected coordinator, matching coordinateImageRenderAttempt's signature. */
  coordinateImageRenderAttempt: (
    input: ImageRenderCoordinatorInput,
    deps: ImageRenderClaimCoordinatorDeps
  ) => Promise<ImageRenderCoordinatorResult>;
  /** Coordinator dependency wiring, passed through verbatim. */
  coordinatorDeps: ImageRenderClaimCoordinatorDeps;
  /** Injected completed-result lookup (read-only replay resolution). */
  getCompletedImageRenderResult: (args: {
    userId: number;
    contentPostId: number;
    requestAttemptKey: string;
    intentFingerprint: string;
  }) => Promise<GetCompletedImageRenderResultResult>;
}

export const IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON =
  "claim_subsystem_unavailable" as const;

export type ImageRenderClaimGateUnavailableReason =
  typeof IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON;

export type ImageRenderClaimGateBlockedReason =
  | "already_running"
  | "stale_blocked"
  | "intent_conflict"
  | "active_post_conflict"
  | "ambiguous_deduction_blocked"
  | "legacy_attempt_blocked"
  | "completed_without_result"
  | "linked_result_missing_or_mismatched"
  | "completed_result_not_found";

/**
 * Safe external replay projection: exactly the eight established successful
 * response fields from the image router. generatedImageId and completedAt are
 * internal and are deliberately excluded. creditsCharged is the original
 * stored value (including zero). jobId follows the established service
 * convention providerJobId || "premium".
 */
export interface ImageRenderReplayResponse {
  readonly success: true;
  readonly imageUrl: string;
  readonly provider: string;
  readonly jobId: string;
  readonly creditsCharged: number;
  readonly qualityTier: string;
  readonly qualityLabel: string;
  readonly isDraft: boolean;
}

export type ImageRenderClaimGateResult =
  | {
      readonly status: "proceed";
      /** Exact frozen coordinator owner object, passed through by reference. */
      readonly owner: ImageRenderClaimOwnerContext;
    }
  | { readonly status: "replay"; readonly response: ImageRenderReplayResponse }
  | {
      readonly status: "blocked";
      readonly reason: ImageRenderClaimGateBlockedReason;
    }
  | {
      readonly status: "unavailable";
      readonly reason: ImageRenderClaimGateUnavailableReason;
    };

// ─── Input validation (reject before any dependency call) ───

const GATE_CLIENT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidPositiveId(
  value: unknown,
  name: string
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${name}: ${String(value)}`,
    });
  }
}

function assertValidGateInput(input: ImageRenderClaimGateInput): void {
  assertValidPositiveId(input.userId, "userId");
  assertValidPositiveId(input.contentPostId, "contentPostId");
  if (
    typeof input.clientAttemptId !== "string" ||
    !GATE_CLIENT_ATTEMPT_ID_PATTERN.test(input.clientAttemptId)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Invalid clientAttemptId: must be 1-64 characters of [A-Za-z0-9_-]",
    });
  }
  if (
    typeof input.ownerToken !== "string" ||
    input.ownerToken.length === 0 ||
    input.ownerToken.length > 64
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid ownerToken: must be 1-64 characters",
    });
  }
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    Number.isNaN(input.leaseExpiresAt.getTime())
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid leaseExpiresAt: expected a valid Date",
    });
  }
}

// ─── Safe replay projection ───

function toImageRenderReplayResponse(
  result: ImageRenderReplayResult
): ImageRenderReplayResponse {
  return {
    success: true,
    imageUrl: result.imageUrl,
    provider: result.provider,
    jobId: result.providerJobId || "premium",
    creditsCharged: result.creditsCharged,
    qualityTier: result.qualityTier,
    qualityLabel: result.qualityLabel,
    isDraft: result.isDraft,
  };
}

// ─── Gate ───

/**
 * Dormant claim/replay gate. Validates input, derives the B1 attempt identity
 * exactly once, invokes the coordinator at most once, and — only on
 * completed_replay_required — resolves the durable result at most once.
 * No retries, no loops, no sleeps, no logging, no mutation beyond what the
 * coordinator itself performs. Never falls through to proceed.
 *
 * Replay-failure mapping note: the completed-result lookup's
 * "not_completed_or_not_found" source reason is surfaced under the stable
 * gate reason "completed_result_not_found" (the completed claim's durable
 * result could not be resolved). All other blocked reasons preserve the
 * source-defined names.
 */
export async function evaluateImageRenderClaimGate(
  input: ImageRenderClaimGateInput,
  deps: ImageRenderClaimGateDeps
): Promise<ImageRenderClaimGateResult> {
  assertValidGateInput(input);

  const identity = deriveImageRenderAttemptIdentity({
    userId: input.userId,
    contentPostId: input.contentPostId,
    attempt: {
      ...input.intent,
      clientAttemptId: input.clientAttemptId,
      lineage: input.lineage,
    },
  });

  const coordinatorInput: ImageRenderCoordinatorInput = {
    userId: input.userId,
    contentPostId: input.contentPostId,
    clientAttemptId: input.clientAttemptId,
    intent: input.intent,
    lineage: input.lineage,
    ownerToken: input.ownerToken,
    leaseExpiresAt: input.leaseExpiresAt,
  };

  let coordinatorResult: ImageRenderCoordinatorResult;
  try {
    coordinatorResult = await deps.coordinateImageRenderAttempt(
      coordinatorInput,
      deps.coordinatorDeps
    );
  } catch {
    return {
      status: "unavailable",
      reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
    };
  }

  switch (coordinatorResult.outcome) {
    case "acquired":
    case "rearmed":
      // Authorizes future orchestration entry only — never billing by itself.
      // The exact frozen owner object is passed through untouched.
      return { status: "proceed", owner: coordinatorResult.owner };

    case "completed_replay_required": {
      let replay: GetCompletedImageRenderResultResult;
      try {
        replay = await deps.getCompletedImageRenderResult({
          userId: input.userId,
          contentPostId: input.contentPostId,
          requestAttemptKey: identity.requestAttemptKey,
          intentFingerprint: identity.intentFingerprint,
        });
      } catch {
        return {
          status: "unavailable",
          reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
        };
      }

      if (replay.replayable) {
        return {
          status: "replay",
          response: toImageRenderReplayResponse(replay.result),
        };
      }

      switch (replay.reason) {
        case "intent_conflict":
          return { status: "blocked", reason: "intent_conflict" };
        case "completed_without_result":
          return { status: "blocked", reason: "completed_without_result" };
        case "linked_result_missing_or_mismatched":
          return {
            status: "blocked",
            reason: "linked_result_missing_or_mismatched",
          };
        case "not_completed_or_not_found":
          // Source name "not_completed_or_not_found" is surfaced under the
          // stable gate reason "completed_result_not_found".
          return { status: "blocked", reason: "completed_result_not_found" };
        default:
          // Malformed dependency outcome: fail closed, never proceed.
          return {
            status: "unavailable",
            reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
          };
      }
    }

    case "already_running":
    case "stale_blocked":
    case "intent_conflict":
    case "active_post_conflict":
    case "ambiguous_deduction_blocked":
    case "legacy_attempt_blocked":
      // Coordinator blocked outcomes map directly, name preserved.
      return { status: "blocked", reason: coordinatorResult.outcome };

    case "claim_subsystem_unavailable":
      return {
        status: "unavailable",
        reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
      };

    default:
      // Unknown coordinator outcome: fail closed, never fall through.
      return {
        status: "unavailable",
        reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
      };
  }
}

/**
 * Default dependency wiring composing the dormant primitives. Exported so the
 * future B2B-3 service integration can construct the gate explicitly. Dormant:
 * nothing in the production request path constructs or invokes the gate today.
 */
export function createDefaultImageRenderClaimGateDeps(): ImageRenderClaimGateDeps {
  return {
    coordinateImageRenderAttempt,
    coordinatorDeps: createDefaultImageRenderClaimCoordinatorDeps(),
    getCompletedImageRenderResult: ({
      userId,
      contentPostId,
      requestAttemptKey,
      intentFingerprint,
    }) =>
      getCompletedImageRenderResult({
        userId,
        contentPostId,
        requestAttemptKey,
        intentFingerprint,
      }),
  };
}
