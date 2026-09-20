/**
 * Credit Reservation & Attribution Contract.
 *
 * WBS 4F / Wave 2 / WBS8A scope:
 * - governed reservation state machine: reserved -> settled | released, with
 *   terminal exclusivity (settled cannot release, released cannot settle) and
 *   idempotent same-transition replay;
 * - deterministic reservationId and idempotency key derived from a canonical,
 *   caller-supplied identity payload (no random UUIDs, no Date.now);
 * - immutable first-class correlation attribution (userId, campaignId,
 *   workflowOperationId, workflowAttemptId, stageId, artifactId, packageId,
 *   agentType, model, provider);
 * - in-memory registry with idempotent replay and fail-closed conflict
 *   detection;
 * - pure contract only: no wallet mutation, no database access, no provider
 *   calls. The later durable ledger implementation persists the records this
 *   contract defines and must route every transition through the same state
 *   machine rather than re-interpreting states locally.
 */

import { createHash } from "crypto";

export type CreditReservationState = "reserved" | "settled" | "released";

export type TerminalCreditReservationState = "settled" | "released";

export type CreditReservationKeyKind = "reserve" | "settle" | "release";

export type CreditReservationDuplicateClassification =
  | "none"
  | "idempotent_replay"
  | "reservation_identity_conflict"
  | "idempotency_key_conflict";

/**
 * Immutable correlation attribution recorded at reservation time. Every field
 * except userId is nullable: a reservation may be attributed to a campaign, a
 * workflow operation/attempt/stage, an artifact or package, and the agent
 * (type, model, provider) that will consume it — or to none of them.
 */
export interface CreditReservationAttribution {
  userId: number;
  campaignId: number | null;
  workflowOperationId: string | null;
  workflowAttemptId: string | null;
  stageId: string | null;
  artifactId: string | null;
  packageId: string | null;
  agentType: string | null;
  model: string | null;
  provider: string | null;
}

/**
 * Deterministic identity input. The reservationId is a hash of this payload,
 * so every field must be caller-supplied business data: no wall-clock time and
 * no random identifiers may participate in identity construction.
 */
export interface CreditReservationIdentityInput {
  /** Positive integer owning user. */
  userId: number;
  /** Deterministic business reference for the reservation (e.g. a charge key or workflow-scoped reference). */
  reservationReference: string;
  campaignId?: number | null;
  workflowOperationId?: string | null;
  workflowAttemptId?: string | null;
  stageId?: string | null;
  /** Trusted external idempotency key. Recorded and validated, but the canonical identity wins on conflict. */
  externalIdempotencyKey?: string | null;
}

/** Data required to reserve credits. Describes intent only; performs no hold. */
export interface ReserveCreditsInput extends CreditReservationIdentityInput {
  /** Credits to hold. Must be a positive finite number. */
  amount: number;
  /** Human-readable purpose of the hold. Required, non-empty after trim. */
  reason: string;
  artifactId?: string | null;
  packageId?: string | null;
  agentType?: string | null;
  model?: string | null;
  provider?: string | null;
  /** Caller-declared correlation timestamp (ISO 8601). Recorded, never part of identity. */
  asOf?: string | null;
}

/** Data required to settle a reservation. Applies the terminal transition only. */
export interface SettleCreditReservationInput {
  reservationId: string;
  /** Deterministic settle idempotency key supplied by the caller. */
  settleKey: string;
  /** Final amount to consume. Defaults to the full reserved amount; must be positive and <= reserved amount. */
  settledAmount?: number;
  /** Caller-declared correlation timestamp (ISO 8601). Recorded, never part of identity. */
  asOf?: string | null;
}

/** Data required to release a reservation. Applies the terminal transition only. */
export interface ReleaseCreditReservationInput {
  reservationId: string;
  /** Deterministic release idempotency key supplied by the caller. */
  releaseKey: string;
  /** Human-readable release cause (e.g. workflow_failed). Descriptive only. */
  reason?: string | null;
  /** Caller-declared correlation timestamp (ISO 8601). Recorded, never part of identity. */
  asOf?: string | null;
}

export interface CreditReservation {
  reservationId: string;
  idempotencyKey: string;
  state: CreditReservationState;
  /** Credits held at reservation time. Immutable after creation. */
  amount: number;
  /** Final consumed amount. Null until settled. */
  settledAmount: number | null;
  /** Credits returned to the wallet. Null until released; equals amount on release. */
  releasedAmount: number | null;
  attribution: CreditReservationAttribution;
  reason: string;
  createdAt: string | null;
  settledAt: string | null;
  releasedAt: string | null;
}

export interface ReserveCreditsResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export interface SettleCreditReservationResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export interface ReleaseCreditReservationResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export class CreditReservationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CreditReservationError";
    this.code = code;
  }
}

export const TERMINAL_RESERVATION_STATES: ReadonlySet<CreditReservationState> = new Set([
  "settled",
  "released",
]);

const VALID_RESERVATION_TRANSITIONS: Record<CreditReservationState, Set<CreditReservationState>> = {
  reserved: new Set(["settled", "released"]),
  settled: new Set(),
  released: new Set(),
};

/**
 * Governed reservation state machine.
 *
 * - reserved -> settled and reserved -> released are the only mutating
 *   transitions;
 * - same-state replay is an idempotent no-op (returns current);
 * - a terminal state (settled, released) rejects every different next state,
 *   failing closed.
 */
export function transitionReservationState(
  current: CreditReservationState,
  next: CreditReservationState
): CreditReservationState {
  if (current === next) return current;
  if (TERMINAL_RESERVATION_STATES.has(current)) {
    throw new CreditReservationError(
      "RESERVATION_TERMINAL_STATE",
      `Cannot transition reservation from terminal state "${current}" to "${next}".`
    );
  }
  if (!VALID_RESERVATION_TRANSITIONS[current].has(next)) {
    throw new CreditReservationError(
      "INVALID_RESERVATION_TRANSITION",
      `Invalid reservation transition: "${current}" -> "${next}".`
    );
  }
  return next;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeReference(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical identity payload for a credit reservation. The same authorised
 * reservation request always produces the same payload and reservationId.
 * Timestamps and random identifiers are deliberately excluded.
 */
export function buildCreditReservationIdentityPayload(
  input: CreditReservationIdentityInput
): Record<string, unknown> {
  return {
    userId: input.userId,
    campaignId: input.campaignId ?? null,
    workflowOperationId: normalizeOptional(input.workflowOperationId),
    workflowAttemptId: normalizeOptional(input.workflowAttemptId),
    stageId: normalizeOptional(input.stageId),
    reservationReference: normalizeReference(input.reservationReference),
  };
}

/** Deterministic reservation identity: sha256 over the canonical identity payload. */
export function buildCreditReservationId(input: CreditReservationIdentityInput): string {
  return sha256(canonicalize(buildCreditReservationIdentityPayload(input)));
}

/** The reservation claim key. An external idempotency key wins when supplied. */
export function buildCreditReservationIdempotencyKey(input: CreditReservationIdentityInput): string {
  if (input.externalIdempotencyKey && input.externalIdempotencyKey.trim().length > 0) {
    return input.externalIdempotencyKey.trim();
  }
  return buildCreditReservationId(input);
}

export function buildCreditReservationAttribution(
  input: ReserveCreditsInput
): CreditReservationAttribution {
  return {
    userId: input.userId,
    campaignId: input.campaignId ?? null,
    workflowOperationId: normalizeOptional(input.workflowOperationId),
    workflowAttemptId: normalizeOptional(input.workflowAttemptId),
    stageId: normalizeOptional(input.stageId),
    artifactId: normalizeOptional(input.artifactId),
    packageId: normalizeOptional(input.packageId),
    agentType: normalizeOptional(input.agentType),
    model: normalizeOptional(input.model),
    provider: normalizeOptional(input.provider),
  };
}

/** Fails closed unless amount is a positive finite number. */
export function assertPositiveReservationAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new CreditReservationError(
      "INVALID_RESERVATION_AMOUNT",
      `Reservation amount must be a positive finite number, got ${String(amount)}.`
    );
  }
}

function validateIdentityInput(input: CreditReservationIdentityInput): void {
  if (
    typeof input.userId !== "number" ||
    !Number.isInteger(input.userId) ||
    input.userId <= 0
  ) {
    throw new CreditReservationError(
      "INVALID_RESERVATION_IDENTITY",
      `Reservation userId must be a positive integer, got ${String(input.userId)}.`
    );
  }
  if (normalizeReference(input.reservationReference).length === 0) {
    throw new CreditReservationError(
      "INVALID_RESERVATION_IDENTITY",
      "Reservation reference must be a non-empty string."
    );
  }
}

interface CreditReservationKeyBinding {
  reservationId: string;
  kind: CreditReservationKeyKind;
}

/**
 * Injectable in-memory registry for the reservation contract. Create a fresh
 * instance per request or test scope. Persistence, wallet holds and ledger
 * writes are explicitly out of scope for this module: the durable ledger
 * implementation will persist the records and enforce the same transitions.
 */
export class InMemoryCreditReservationRegistry {
  private reservations = new Map<string, CreditReservation>();
  private naturalReferenceIndex = new Map<string, string>(); // userId:reference -> reservationId
  private keyIndex = new Map<string, CreditReservationKeyBinding>();

  private naturalReferenceKey(input: CreditReservationIdentityInput): string {
    return `${input.userId}:${normalizeReference(input.reservationReference)}`;
  }

  private requireReservation(reservationId: string): CreditReservation {
    const id = normalizeOptional(reservationId);
    const reservation = id ? this.reservations.get(id) : undefined;
    if (!reservation) {
      throw new CreditReservationError(
        "RESERVATION_NOT_FOUND",
        `Credit reservation ${String(reservationId)} does not exist.`
      );
    }
    return reservation;
  }

  private requireTransitionKey(key: string | null | undefined, kind: string): string {
    const normalized = normalizeOptional(key);
    if (!normalized) {
      throw new CreditReservationError(
        "INVALID_RESERVATION_TRANSITION_KEY",
        `${kind} key must be a non-empty string.`
      );
    }
    return normalized;
  }

  private assertKeyAvailable(key: string, reservationId: string, kind: CreditReservationKeyKind): void {
    const binding = this.keyIndex.get(key);
    if (binding && (binding.reservationId !== reservationId || binding.kind !== kind)) {
      throw new CreditReservationError(
        "IDEMPOTENCY_KEY_CONFLICT",
        `${kind} key "${key}" is already bound to reservation ${binding.reservationId} (${binding.kind}).`
      );
    }
  }

  /**
   * Register or replay a reservation. Replays (same canonical identity, same
   * amount, same attribution) return the existing frozen reservation; any
   * conflicting reuse of the reservation identity, natural reference, or
   * external idempotency key fails closed.
   */
  reserveCredits(input: ReserveCreditsInput): ReserveCreditsResult {
    validateIdentityInput(input);
    assertPositiveReservationAmount(input.amount);

    const reason = normalizeReference(input.reason ?? "");
    if (reason.length === 0) {
      throw new CreditReservationError(
        "INVALID_RESERVATION_REASON",
        "Reservation reason must be a non-empty string."
      );
    }

    const reservationId = buildCreditReservationId(input);
    const idempotencyKey = buildCreditReservationIdempotencyKey(input);
    const attribution = buildCreditReservationAttribution(input);

    const existing = this.reservations.get(reservationId);
    if (existing) {
      if (
        existing.amount !== input.amount ||
        canonicalize(existing.attribution) !== canonicalize(attribution)
      ) {
        throw new CreditReservationError(
          "RESERVATION_IDENTITY_CONFLICT",
          `Reservation ${reservationId} already exists with a conflicting amount or attribution.`
        );
      }
      return { reservation: existing, duplicateClassification: "idempotent_replay" };
    }

    const naturalKey = this.naturalReferenceKey(input);
    const boundId = this.naturalReferenceIndex.get(naturalKey);
    if (boundId && boundId !== reservationId) {
      throw new CreditReservationError(
        "RESERVATION_IDENTITY_CONFLICT",
        `Reservation reference "${naturalKey}" is already bound to a different reservation identity (${boundId}).`
      );
    }

    if (input.externalIdempotencyKey) {
      this.assertKeyAvailable(input.externalIdempotencyKey.trim(), reservationId, "reserve");
    }

    const reservation = deepFreeze({
      reservationId,
      idempotencyKey,
      state: "reserved" as CreditReservationState,
      amount: input.amount,
      settledAmount: null,
      releasedAmount: null,
      attribution: deepFreeze(attribution),
      reason,
      createdAt: normalizeOptional(input.asOf),
      settledAt: null,
      releasedAt: null,
    });

    this.reservations.set(reservationId, reservation);
    this.naturalReferenceIndex.set(naturalKey, reservationId);
    if (input.externalIdempotencyKey) {
      this.keyIndex.set(input.externalIdempotencyKey.trim(), {
        reservationId,
        kind: "reserve",
      });
    }
    return { reservation, duplicateClassification: "none" };
  }

  /**
   * Settle a reservation: consume settledAmount (defaulting to the full held
   * amount; never more than the held amount) and reach the terminal `settled`
   * state. Same-key replays are idempotent; a different key against a settled
   * or released reservation fails closed.
   */
  settleCreditReservation(
    input: SettleCreditReservationInput
  ): SettleCreditReservationResult {
    const settleKey = this.requireTransitionKey(input.settleKey, "Settle");
    const reservation = this.requireReservation(input.reservationId);
    const settledAmount = input.settledAmount ?? reservation.amount;

    const binding = this.keyIndex.get(settleKey);
    if (binding) {
      if (binding.reservationId !== reservation.reservationId || binding.kind !== "settle") {
        throw new CreditReservationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Settle key "${settleKey}" is already bound to reservation ${binding.reservationId} (${binding.kind}).`
        );
      }
      if (reservation.settledAmount !== null && settledAmount !== reservation.settledAmount) {
        throw new CreditReservationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Settle key "${settleKey}" was replayed with a different settled amount.`
        );
      }
      return { reservation, duplicateClassification: "idempotent_replay" };
    }

    if (!Number.isFinite(settledAmount) || settledAmount <= 0) {
      throw new CreditReservationError(
        "INVALID_SETTLEMENT_AMOUNT",
        `Settled amount must be a positive finite number, got ${String(settledAmount)}.`
      );
    }
    if (settledAmount > reservation.amount) {
      throw new CreditReservationError(
        "INVALID_SETTLEMENT_AMOUNT",
        `Cannot settle ${settledAmount} credits against a reservation of ${reservation.amount}.`
      );
    }

    // Only a same-key replay (handled above) may touch a terminal reservation;
    // a new settle attempt against one fails closed.
    if (TERMINAL_RESERVATION_STATES.has(reservation.state)) {
      throw new CreditReservationError(
        "RESERVATION_TERMINAL_STATE",
        `Cannot settle reservation in terminal state "${reservation.state}".`
      );
    }

    const nextState = transitionReservationState(reservation.state, "settled");
    const updated = deepFreeze({
      ...reservation,
      state: nextState,
      settledAmount,
      settledAt: normalizeOptional(input.asOf),
    });
    this.reservations.set(reservation.reservationId, updated);
    this.keyIndex.set(settleKey, { reservationId: reservation.reservationId, kind: "settle" });
    return { reservation: updated, duplicateClassification: "none" };
  }

  /**
   * Release a reservation: return the full held amount and reach the terminal
   * `released` state. Same-key replays are idempotent; releasing a settled (or
   * otherwise terminal) reservation fails closed.
   */
  releaseCreditReservation(
    input: ReleaseCreditReservationInput
  ): ReleaseCreditReservationResult {
    const releaseKey = this.requireTransitionKey(input.releaseKey, "Release");
    const reservation = this.requireReservation(input.reservationId);

    const binding = this.keyIndex.get(releaseKey);
    if (binding) {
      if (binding.reservationId !== reservation.reservationId || binding.kind !== "release") {
        throw new CreditReservationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Release key "${releaseKey}" is already bound to reservation ${binding.reservationId} (${binding.kind}).`
        );
      }
      return { reservation, duplicateClassification: "idempotent_replay" };
    }

    // Only a same-key replay (handled above) may touch a terminal reservation;
    // a new release attempt against one fails closed.
    if (TERMINAL_RESERVATION_STATES.has(reservation.state)) {
      throw new CreditReservationError(
        "RESERVATION_TERMINAL_STATE",
        `Cannot release reservation in terminal state "${reservation.state}".`
      );
    }

    const nextState = transitionReservationState(reservation.state, "released");
    const updated = deepFreeze({
      ...reservation,
      state: nextState,
      releasedAmount: reservation.amount,
      releasedAt: normalizeOptional(input.asOf),
    });
    this.reservations.set(reservation.reservationId, updated);
    this.keyIndex.set(releaseKey, {
      reservationId: reservation.reservationId,
      kind: "release",
    });
    return { reservation: updated, duplicateClassification: "none" };
  }

  findReservation(reservationId: string): CreditReservation | null {
    const id = normalizeOptional(reservationId);
    return (id && this.reservations.get(id)) || null;
  }

  findReservationByIdempotencyKey(key: string): CreditReservation | null {
    const normalized = normalizeOptional(key);
    if (!normalized) return null;
    const binding = this.keyIndex.get(normalized);
    if (!binding) return null;
    return this.reservations.get(binding.reservationId) ?? null;
  }

  /** Read-only view of every stored reservation. Records are frozen. */
  snapshot(): CreditReservation[] {
    return Array.from(this.reservations.values());
  }
}
