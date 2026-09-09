import { TRPCError } from "@trpc/server";
import {
  acquireImageRenderClaim,
  lookupImageRenderAttempt,
  rearmFailedImageRenderClaim,
  deriveImageRenderAttemptIdentity,
  type AcquireImageRenderClaimResult,
  type ImageRenderAttemptIdentityInput,
  type ImageRenderAttemptLookup,
  type ImageRenderClaim,
  type RearmImageRenderClaimResult,
} from "./image-render-claim";

// ─── Dormant image-render claim coordinator (B2B-1) ───
//
// Classifies one logical premium-image attempt and drives the B1 claim
// primitive through injected dependencies. This module is entirely dormant:
// no production request path imports or invokes it, it performs no rendering,
// no billing, no persistence of its own, and it never touches a database row
// except through the injected claim operations.
//
// TRUST BOUNDARY — caller preconditions (enforced by the future request owner,
// NOT by this coordinator):
//   1. userId must come from authoritative authenticated server context.
//   2. contentPostId must be verified as owned by that userId BEFORE calling.
// This coordinator deliberately accepts no caller-controlled
// "ownershipVerified" flag, no campaign identity, and no campaign sentinel.
// It is not an authorization system; ownership remains the existing
// user-scoped post lookup.
//
// Raw clientAttemptId, raw refinement/guidance text, ownerToken,
// activeClaimKey, and deductionKey are never returned in blocked diagnostic
// outcomes and must never be logged or serialized by callers.
//
// Completed-result replay is intentionally NOT implemented here: completed
// attempts return "completed_replay_required" and authorize nothing. B2B-2
// must add an authoritative durable claim-to-result link before activation;
// until then the coordinator refuses to infer results from timestamps or
// "latest image for post".

export type ImageRenderCoordinatorIntent = Omit<
  ImageRenderAttemptIdentityInput,
  "clientAttemptId"
>;

export interface ImageRenderCoordinatorInput {
  /** Authoritative authenticated user id (caller-verified). */
  userId: number;
  /** Authoritative content post id, verified owned by userId (caller-verified). */
  contentPostId: number;
  /** Validated client attempt token. Never returned, persisted, or logged. */
  clientAttemptId: string;
  /** Complete material render intent — all ten B1 fields. */
  intent: ImageRenderCoordinatorIntent;
  /** Ownership credential proposed by the future request owner. */
  ownerToken: string;
  /** Proposed lease expiry for the claim row. */
  leaseExpiresAt: Date;
}

export interface ImageRenderClaimCoordinatorDeps {
  lookupAttempt(args: {
    requestAttemptKey: string;
    expectedIntentFingerprint: string;
  }): Promise<ImageRenderAttemptLookup>;
  acquireClaim(args: {
    userId: number;
    contentPostId: number;
    ownerToken: string;
    leaseExpiresAt: Date;
    identity: ImageRenderAttemptIdentityInput;
  }): Promise<AcquireImageRenderClaimResult>;
  rearmFailedClaim(args: {
    userId: number;
    contentPostId: number;
    requestAttemptKey: string;
    intentFingerprint: string;
    ownerToken: string;
    leaseExpiresAt: Date;
  }): Promise<RearmImageRenderClaimResult>;
}

export type ImageRenderCoordinatorOutcome =
  | "acquired"
  | "rearmed"
  | "completed_replay_required"
  | "already_running"
  | "stale_blocked"
  | "intent_conflict"
  | "active_post_conflict"
  | "ambiguous_deduction_blocked"
  | "legacy_attempt_blocked"
  | "claim_subsystem_unavailable";

export type BlockedImageRenderCoordinatorOutcome = Exclude<
  ImageRenderCoordinatorOutcome,
  "acquired" | "rearmed"
>;

/**
 * INTERNAL ownership context. Returned only on acquired/rearmed outcomes.
 *
 * Trust boundary: this structure authorizes nothing by itself — the caller
 * still owns verification, rendering, billing, and terminal transitions. It
 * must never be serialized, logged, sent to a client, or stored in an
 * external payload. Blocked outcomes never carry this context.
 */
export interface ImageRenderClaimOwnerContext {
  readonly claimId: number;
  readonly ownerToken: string;
  readonly requestAttemptKey: string;
  readonly intentFingerprint: string;
  readonly deductionKey: string;
}

export type ImageRenderCoordinatorResult =
  | { outcome: "acquired"; owner: ImageRenderClaimOwnerContext }
  | { outcome: "rearmed"; owner: ImageRenderClaimOwnerContext }
  | { outcome: BlockedImageRenderCoordinatorOutcome };

// ─── Pure decision model ───
//
// State precedence (highest first):
//   1. subsystem failure            (handled by the coordinator, never here)
//   2. intent conflict / unknown legacy intent
//   3. completed replay required
//   4. deduction-recorded ambiguity
//   5. running (active / stale lease)
//   6. failed pre-deduction rearm
//   7. absent attempt acquisition
//
// Consequences: a completed row is never treated as absent merely because
// its activeClaimKey is null; a failed row with deductionRecorded=true is
// never rearmed; a stale running row is never treated as failed; and an
// intent mismatch outranks every status-based outcome.

export type ImageRenderAttemptPureDecision =
  | { kind: "acquire" }
  | { kind: "rearm" }
  | { kind: "blocked"; outcome: BlockedImageRenderCoordinatorOutcome };

export function classifyImageRenderAttempt(
  lookup: ImageRenderAttemptLookup
): ImageRenderAttemptPureDecision {
  if (!lookup.found) {
    return { kind: "acquire" };
  }
  if (lookup.intentComparison === "conflict") {
    return { kind: "blocked", outcome: "intent_conflict" };
  }
  if (lookup.intentComparison === "unknown") {
    return { kind: "blocked", outcome: "legacy_attempt_blocked" };
  }
  if (lookup.status === "completed") {
    return { kind: "blocked", outcome: "completed_replay_required" };
  }
  if (lookup.status === "failed") {
    if (lookup.deductionRecorded === true) {
      return { kind: "blocked", outcome: "ambiguous_deduction_blocked" };
    }
    return { kind: "rearm" };
  }
  if (lookup.leaseState === "stale") {
    return { kind: "blocked", outcome: "stale_blocked" };
  }
  return { kind: "blocked", outcome: "already_running" };
}

// ─── Input validation (reject before any dependency call) ───

const COORDINATOR_CLIENT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidPositiveId(value: unknown, name: string): asserts value is number {
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

function assertValidCoordinatorInput(
  input: ImageRenderCoordinatorInput
): void {
  assertValidPositiveId(input.userId, "userId");
  assertValidPositiveId(input.contentPostId, "contentPostId");
  if (
    typeof input.clientAttemptId !== "string" ||
    !COORDINATOR_CLIENT_ATTEMPT_ID_PATTERN.test(input.clientAttemptId)
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

// ─── Dependency-result well-formedness (malformed => fail closed) ───

const CLAIM_STATUSES = ["running", "completed", "failed"];
const INTENT_COMPARISONS = ["match", "conflict", "unknown"];
const LEASE_STATES = ["active", "stale", "none"];

function isWellFormedLookup(
  lookup: unknown
): lookup is ImageRenderAttemptLookup {
  if (!lookup || typeof lookup !== "object") return false;
  const value = lookup as ImageRenderAttemptLookup;
  if (typeof value.found !== "boolean") return false;
  if (!value.found) return true;
  return (
    typeof value.claimId === "number" &&
    value.claimId > 0 &&
    typeof value.userId === "number" &&
    typeof value.contentPostId === "number" &&
    CLAIM_STATUSES.includes(value.status as string) &&
    INTENT_COMPARISONS.includes(value.intentComparison as string) &&
    typeof value.deductionRecorded === "boolean" &&
    typeof value.activeClaimKeyPresent === "boolean" &&
    LEASE_STATES.includes(value.leaseState as string)
  );
}

// ─── Owner context construction (strict integrity check) ───

function ownerContextFromClaim(
  claim: unknown,
  identity: { requestAttemptKey: string; intentFingerprint: string; deductionKey: string }
): ImageRenderClaimOwnerContext | null {
  if (!claim || typeof claim !== "object") return null;
  const candidate = claim as Partial<ImageRenderClaim>;
  if (
    typeof candidate.id !== "number" ||
    candidate.id <= 0 ||
    typeof candidate.ownerToken !== "string" ||
    candidate.ownerToken.length === 0 ||
    candidate.ownerToken.length > 64
  ) {
    return null;
  }
  // The returned row must be THIS attempt's row. A mismatch means the
  // dependency returned a row for a different attempt — fail closed.
  if (candidate.requestAttemptKey !== identity.requestAttemptKey) return null;
  if (candidate.intentFingerprint !== identity.intentFingerprint) return null;
  if (candidate.deductionKey !== identity.deductionKey) return null;
  return Object.freeze({
    claimId: candidate.id,
    ownerToken: candidate.ownerToken,
    requestAttemptKey: candidate.requestAttemptKey,
    intentFingerprint: candidate.intentFingerprint,
    deductionKey: candidate.deductionKey,
  });
}

// ─── Race re-read classification (at most ONE re-read, never a loop) ───

type RaceRereadClassification =
  | { kind: "blocked"; outcome: BlockedImageRenderCoordinatorOutcome }
  | { kind: "not_found" }
  | { kind: "undecidable" };

function classifyRaceReread(
  lookup: unknown,
  input: ImageRenderCoordinatorInput
): RaceRereadClassification {
  if (!isWellFormedLookup(lookup)) {
    return { kind: "undecidable" };
  }
  if (!lookup.found) {
    return { kind: "not_found" };
  }
  if (
    lookup.userId !== input.userId ||
    lookup.contentPostId !== input.contentPostId
  ) {
    return { kind: "undecidable" };
  }
  const decision = classifyImageRenderAttempt(lookup);
  if (decision.kind === "blocked") {
    return { kind: "blocked", outcome: decision.outcome };
  }
  // A race re-read must never authorize work; acquire/rearm decisions after a
  // lost race are anomalous and fail closed.
  return { kind: "undecidable" };
}

const SUBSYSTEM_UNAVAILABLE: ImageRenderCoordinatorResult = {
  outcome: "claim_subsystem_unavailable",
};

// ─── Coordinator ───

/**
 * Dormant request-attempt coordinator. Derives the B1 attempt identity,
 * classifies the durable attempt state, and performs at most one mutation
 * (acquire OR rearm) plus at most one deterministic race re-read. No sleeps,
 * no loops, no token minting, no rendering, no billing.
 *
 * Only "acquired" and "rearmed" authorize future work — and in B2B-1 even
 * those authorize nothing, because no production caller invokes this
 * function. Blocked outcomes never carry ownership credentials.
 */
export async function coordinateImageRenderAttempt(
  input: ImageRenderCoordinatorInput,
  deps: ImageRenderClaimCoordinatorDeps
): Promise<ImageRenderCoordinatorResult> {
  assertValidCoordinatorInput(input);

  // Derive the full attempt identity through the B1 helper exactly once.
  // Derivation failure (malformed token/ids/intent) rejects before any
  // dependency call.
  const attempt: ImageRenderAttemptIdentityInput = {
    ...input.intent,
    clientAttemptId: input.clientAttemptId,
  };
  const identity = deriveImageRenderAttemptIdentity({
    userId: input.userId,
    contentPostId: input.contentPostId,
    attempt,
  });

  let lookup: ImageRenderAttemptLookup;
  try {
    lookup = await deps.lookupAttempt({
      requestAttemptKey: identity.requestAttemptKey,
      expectedIntentFingerprint: identity.intentFingerprint,
    });
  } catch {
    return SUBSYSTEM_UNAVAILABLE;
  }
  if (!isWellFormedLookup(lookup)) {
    return SUBSYSTEM_UNAVAILABLE;
  }
  if (
    lookup.found &&
    (lookup.userId !== input.userId || lookup.contentPostId !== input.contentPostId)
  ) {
    // A row under this attempt key that belongs to another user/post is a
    // data-integrity failure. Never reinterpret it — fail closed.
    return SUBSYSTEM_UNAVAILABLE;
  }

  const decision = classifyImageRenderAttempt(lookup);

  if (decision.kind === "blocked") {
    return { outcome: decision.outcome };
  }

  if (decision.kind === "acquire") {
    let acquireResult: AcquireImageRenderClaimResult;
    try {
      acquireResult = await deps.acquireClaim({
        userId: input.userId,
        contentPostId: input.contentPostId,
        ownerToken: input.ownerToken,
        leaseExpiresAt: input.leaseExpiresAt,
        identity: attempt,
      });
    } catch {
      return SUBSYSTEM_UNAVAILABLE;
    }

    if (acquireResult.acquired) {
      const owner = ownerContextFromClaim(acquireResult.claim, identity);
      return owner ? { outcome: "acquired", owner } : SUBSYSTEM_UNAVAILABLE;
    }

    // Duplicate-key race: at most one deterministic re-read by
    // requestAttemptKey. If our own attempt's row now exists, a concurrent
    // request with the SAME key won — classify its state and never authorize
    // a second owner. If it does not exist, the active user/post key belongs
    // to a different attempt (or a legacy null-key claim): classify from the
    // primitive's authoritative conflict reason. Stale claims are never
    // mutated or taken over.
    let reread: ImageRenderAttemptLookup;
    try {
      reread = await deps.lookupAttempt({
        requestAttemptKey: identity.requestAttemptKey,
        expectedIntentFingerprint: identity.intentFingerprint,
      });
    } catch {
      return SUBSYSTEM_UNAVAILABLE;
    }
    const raced = classifyRaceReread(reread, input);
    if (raced.kind === "blocked") {
      return { outcome: raced.outcome };
    }
    if (raced.kind === "undecidable") {
      return SUBSYSTEM_UNAVAILABLE;
    }
    if (acquireResult.reason === "active_claim_conflict") {
      return { outcome: "active_post_conflict" };
    }
    if (acquireResult.reason === "stale_claim_conflict") {
      return { outcome: "stale_blocked" };
    }
    return SUBSYSTEM_UNAVAILABLE;
  }

  // decision.kind === "rearm": failed, same intent, deductionRecorded=false.
  let rearmResult: RearmImageRenderClaimResult;
  try {
    rearmResult = await deps.rearmFailedClaim({
      userId: input.userId,
      contentPostId: input.contentPostId,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: input.ownerToken,
      leaseExpiresAt: input.leaseExpiresAt,
    });
  } catch {
    return SUBSYSTEM_UNAVAILABLE;
  }

  if (rearmResult.rearmed) {
    const owner = ownerContextFromClaim(rearmResult.claim, identity);
    return owner ? { outcome: "rearmed", owner } : SUBSYSTEM_UNAVAILABLE;
  }

  switch (rearmResult.reason) {
    case "intent_conflict":
      return { outcome: "intent_conflict" };
    case "deduction_recorded":
      return { outcome: "ambiguous_deduction_blocked" };
    case "active_key_occupied":
      return { outcome: "active_post_conflict" };
    case "not_found":
    case "not_failed": {
      // The row's state changed concurrently between lookup and rearm: one
      // deterministic re-read, classify, and never loop.
      let reread: ImageRenderAttemptLookup;
      try {
        reread = await deps.lookupAttempt({
          requestAttemptKey: identity.requestAttemptKey,
          expectedIntentFingerprint: identity.intentFingerprint,
        });
      } catch {
        return SUBSYSTEM_UNAVAILABLE;
      }
      const raced = classifyRaceReread(reread, input);
      if (raced.kind === "blocked") {
        return { outcome: raced.outcome };
      }
      return SUBSYSTEM_UNAVAILABLE;
    }
    default:
      return SUBSYSTEM_UNAVAILABLE;
  }
}

/**
 * Default dependencies wrapping the B1 claim primitive. Exported so the
 * future request owner (B2B-3 service integration) can wire them explicitly.
 * Dormant: nothing in the production request path constructs or invokes the
 * coordinator today.
 */
export function createDefaultImageRenderClaimCoordinatorDeps(): ImageRenderClaimCoordinatorDeps {
  return {
    lookupAttempt: ({ requestAttemptKey, expectedIntentFingerprint }) =>
      lookupImageRenderAttempt({
        requestAttemptKey,
        expectedIntentFingerprint,
      }),
    acquireClaim: (args) => acquireImageRenderClaim(args),
    rearmFailedClaim: (args) => rearmFailedImageRenderClaim(args),
  };
}
