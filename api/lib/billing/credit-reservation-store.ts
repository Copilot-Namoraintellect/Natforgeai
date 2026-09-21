/**
 * Durable credit reservation store (WBS 4F / Wave 2 / WBS8B).
 *
 * Gives the WBS8A governed reservation contract durable persistence in the
 * `credit_reservations` table. Every state decision is delegated to the
 * contract module (api/lib/billing/credit-reservation.ts); this store only
 * translates those decisions into database operations:
 *
 * - reserve: insert-first claim on the unique authorities (reservationId,
 *   idempotencyKey, and userId + reservationReference); an ER_DUP_ENTRY
 *   reread checks the natural reference first, so an exact same-reservation
 *   replay returns the committed row while the same reference bound to a
 *   different identity fails closed. No select-before-insert observation is
 *   trusted as the concurrency authority;
 * - settle / release: guarded conditional UPDATE
 *   (`WHERE state = 'reserved' AND <key> IS NULL`) makes each terminal
 *   transition apply at most once under concurrency; a lost race rereads the
 *   winner and reports either an idempotent replay or a terminal conflict;
 * - same settle/release key replay returns the existing terminal state.
 *
 * Explicitly out of scope for this slice: wallet balance mutation and any
 * change to deductCredits / refundCredits. No table other than
 * credit_reservations is touched here.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  creditReservations,
  type CreditReservationRecord,
} from "@db/schema";
import { isMySqlDuplicateKeyError } from "./credit-engine";
import {
  buildCreditReservationAttribution,
  buildCreditReservationId,
  buildCreditReservationIdempotencyKey,
  CreditReservationError,
  normalizeReservationTransitionKey,
  validateReserveCreditsInput,
  type CreditReservation,
  type CreditReservationAttribution,
  type CreditReservationDuplicateClassification,
  type ReleaseCreditReservationInput,
  type ReserveCreditsInput,
  type SettleCreditReservationInput,
} from "./credit-reservation";

type StoreDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam. The default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape, so callers that already
 * own a transaction can pass it through. Tests supply pure fakes and never
 * touch a real database.
 */
export interface CreditReservationStoreExecutor {
  select: StoreDb["select"];
  insert: StoreDb["insert"];
  update: StoreDb["update"];
  execute: StoreDb["execute"];
}

function resolveDb(executor?: CreditReservationStoreExecutor): CreditReservationStoreExecutor {
  return executor ?? getDb();
}

export interface DurableReserveCreditsInput extends ReserveCreditsInput {
  executor?: CreditReservationStoreExecutor;
}

export interface DurableSettleCreditReservationInput extends SettleCreditReservationInput {
  executor?: CreditReservationStoreExecutor;
}

export interface DurableReleaseCreditReservationInput extends ReleaseCreditReservationInput {
  executor?: CreditReservationStoreExecutor;
}

export interface DurableReserveCreditsResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export interface DurableSettleCreditReservationResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export interface DurableReleaseCreditReservationResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

function rowToAttribution(row: CreditReservationRecord): CreditReservationAttribution {
  return {
    userId: row.userId,
    campaignId: row.campaignId,
    workflowOperationId: row.workflowOperationId,
    workflowAttemptId: row.workflowAttemptId,
    stageId: row.stageId,
    artifactId: row.artifactId,
    packageId: row.packageId,
    agentType: row.agentType,
    model: row.model,
    provider: row.provider,
  };
}

/**
 * Maps a persisted row to the governed contract record. `releasedAmount` is
 * derived: release always returns the full held amount, so it equals
 * reservedAmount exactly when the row reached the released state.
 */
function rowToCreditReservation(row: CreditReservationRecord): CreditReservation {
  return {
    reservationId: row.reservationId,
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    amount: row.reservedAmount,
    settledAmount: row.settledAmount,
    releasedAmount: row.state === "released" ? row.reservedAmount : null,
    attribution: rowToAttribution(row),
    reason: row.reason,
    createdAt: row.reservedAt ? row.reservedAt.toISOString() : null,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
  };
}

/** Fails closed unless the persisted row matches the requested reservation. */
function assertRowMatchesRequest(
  row: CreditReservationRecord,
  amount: number,
  attribution: CreditReservationAttribution,
  reservationId: string
): void {
  const rowAttribution = rowToAttribution(row);
  const mismatched =
    row.reservationId !== reservationId ||
    row.reservedAmount !== amount ||
    (Object.keys(attribution) as (keyof CreditReservationAttribution)[]).some(
      (field) => rowAttribution[field] !== attribution[field]
    );
  if (mismatched) {
    throw new CreditReservationError(
      "RESERVATION_IDENTITY_CONFLICT",
      `Reservation ${reservationId} already exists with a conflicting amount or attribution.`
    );
  }
}

function internalError(message: string): CreditReservationError {
  return new CreditReservationError("INTERNAL_RESERVATION_STORE_ERROR", message);
}

/**
 * Durable reserve. The INSERT claims the unique authorities (reservationId,
 * idempotencyKey, userId + reservationReference). On a duplicate-key error the
 * committed winner is reread — natural reference first — through the same
 * database route:
 *
 * - same (userId, reservationReference) bound to a different reservation
 *   identity -> RESERVATION_IDENTITY_CONFLICT (fails closed);
 * - external idempotency key already bound to a different reservation ->
 *   IDEMPOTENCY_KEY_CONFLICT (fails closed);
 * - exact same logical reservation -> idempotent replay, after verifying the
 *   persisted amount and full attribution match the request.
 *
 * The unique constraint on (userId, reservationReference) is the concurrency
 * authority for the natural-reference rule; nothing here relies on a
 * select-before-insert observation.
 */
export async function reserveCreditReservation(
  input: DurableReserveCreditsInput
): Promise<DurableReserveCreditsResult> {
  validateReserveCreditsInput(input);

  const reservationId = buildCreditReservationId(input);
  const idempotencyKey = buildCreditReservationIdempotencyKey(input);
  const attribution = buildCreditReservationAttribution(input);
  const reason = input.reason.trim();
  const reference = input.reservationReference.trim().replace(/\s+/g, " ");
  const db = resolveDb(input.executor);

  const reservedAt = input.asOf ? new Date(input.asOf) : undefined;
  try {
    await db.insert(creditReservations).values({
      reservationId,
      idempotencyKey,
      reservationReference: reference,
      userId: input.userId,
      campaignId: attribution.campaignId,
      workflowOperationId: attribution.workflowOperationId,
      workflowAttemptId: attribution.workflowAttemptId,
      stageId: attribution.stageId,
      artifactId: attribution.artifactId,
      packageId: attribution.packageId,
      agentType: attribution.agentType,
      model: attribution.model,
      provider: attribution.provider,
      reservedAmount: input.amount,
      settledAmount: null,
      state: "reserved",
      reason,
      settleKey: null,
      releaseKey: null,
      releaseReason: null,
      ...(reservedAt ? { reservedAt } : {}),
      settledAt: null,
      releasedAt: null,
    });
  } catch (err) {
    if (isMySqlDuplicateKeyError(err)) {
      const [byReference] = await db
        .select()
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.userId, input.userId),
            eq(creditReservations.reservationReference, reference)
          )
        )
        .limit(1);

      if (byReference && byReference.reservationId !== reservationId) {
        throw new CreditReservationError(
          "RESERVATION_IDENTITY_CONFLICT",
          `Reservation reference "${reference}" for user ${input.userId} is already bound to a different reservation identity (${byReference.reservationId}).`
        );
      }

      const winner =
        byReference ??
        (
          await db
            .select()
            .from(creditReservations)
            .where(eq(creditReservations.idempotencyKey, idempotencyKey))
            .limit(1)
        )[0] ??
        (await selectReservationById(db, reservationId));

      if (!winner) {
        throw internalError(
          `Reservation duplicate-key collision detected but no committed winner for reference "${reference}" / key ${idempotencyKey} could be retrieved`
        );
      }
      if (winner.reservationId !== reservationId) {
        throw new CreditReservationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Idempotency key "${idempotencyKey}" is already bound to reservation ${winner.reservationId}.`
        );
      }
      assertRowMatchesRequest(winner, input.amount, attribution, reservationId);
      return {
        reservation: rowToCreditReservation(winner),
        duplicateClassification: "idempotent_replay",
      };
    }
    throw err;
  }

  return {
    reservation: {
      reservationId,
      idempotencyKey,
      state: "reserved",
      amount: input.amount,
      settledAmount: null,
      releasedAmount: null,
      attribution,
      reason,
      createdAt: input.asOf ?? null,
      settledAt: null,
      releasedAt: null,
    },
    duplicateClassification: "none",
  };
}

async function selectReservationById(
  db: CreditReservationStoreExecutor,
  reservationId: string
): Promise<CreditReservationRecord | undefined> {
  const [row] = await db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.reservationId, reservationId))
    .limit(1);
  return row;
}

/**
 * Durable settle. Applies `reserved -> settled` at most once via a guarded
 * conditional UPDATE; the guard is the concurrency authority, not the prior
 * SELECT. A repeated call with the same settleKey returns the existing
 * terminal state (idempotent replay); a different key, or any settle attempt
 * against a terminal reservation, fails closed.
 */
export async function settleCreditReservation(
  input: DurableSettleCreditReservationInput
): Promise<DurableSettleCreditReservationResult> {
  const settleKey = normalizeReservationTransitionKey(input.settleKey, "Settle");
  const db = resolveDb(input.executor);

  const row = await selectReservationById(db, input.reservationId);
  if (!row) {
    throw new CreditReservationError(
      "RESERVATION_NOT_FOUND",
      `Credit reservation ${input.reservationId} does not exist.`
    );
  }

  if (row.settleKey !== null) {
    if (row.settleKey !== settleKey) {
      throw new CreditReservationError(
        "RESERVATION_TERMINAL_STATE",
        `Reservation ${input.reservationId} is already settled under a different settle key.`
      );
    }
    const requested = input.settledAmount ?? row.reservedAmount;
    if (row.settledAmount !== null && requested !== row.settledAmount) {
      throw new CreditReservationError(
        "IDEMPOTENCY_KEY_CONFLICT",
        `Settle key "${settleKey}" was replayed with a different settled amount.`
      );
    }
    return { reservation: rowToCreditReservation(row), duplicateClassification: "idempotent_replay" };
  }

  if (row.state !== "reserved") {
    throw new CreditReservationError(
      "RESERVATION_TERMINAL_STATE",
      `Cannot settle reservation ${input.reservationId} in terminal state "${row.state}".`
    );
  }

  const settledAmount = input.settledAmount ?? row.reservedAmount;
  if (!Number.isFinite(settledAmount) || settledAmount <= 0) {
    throw new CreditReservationError(
      "INVALID_SETTLEMENT_AMOUNT",
      `Settled amount must be a positive finite number, got ${String(settledAmount)}.`
    );
  }
  if (settledAmount > row.reservedAmount) {
    throw new CreditReservationError(
      "INVALID_SETTLEMENT_AMOUNT",
      `Cannot settle ${settledAmount} credits against a reservation of ${row.reservedAmount}.`
    );
  }

  const settledAt = input.asOf ? new Date(input.asOf) : new Date();
  const updateResult = await db.execute(sql`
    UPDATE credit_reservations
    SET state = 'settled',
        settledAmount = ${settledAmount},
        settleKey = ${settleKey},
        settledAt = ${settledAt},
        updatedAt = NOW()
    WHERE id = ${row.id} AND state = 'reserved' AND settleKey IS NULL
  `);
  const affectedRows = (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;

  if (affectedRows === 0) {
    // Lost a settle race: reread the winner through the same route. Only an
    // identical settle key replay is accepted; anything else fails closed.
    const winner = await selectReservationById(db, input.reservationId);
    if (winner && winner.settleKey === settleKey && winner.state === "settled") {
      return { reservation: rowToCreditReservation(winner), duplicateClassification: "idempotent_replay" };
    }
    throw new CreditReservationError(
      "RESERVATION_TERMINAL_STATE",
      `Reservation ${input.reservationId} reached a terminal state concurrently; settle was not applied.`
    );
  }

  return {
    reservation: rowToCreditReservation({ ...row, state: "settled", settledAmount, settleKey, settledAt }),
    duplicateClassification: "none",
  };
}

/**
 * Durable release. Applies `reserved -> released` at most once via a guarded
 * conditional UPDATE. A repeated call with the same releaseKey returns the
 * existing terminal state (idempotent replay); a different key, or any
 * release attempt against a terminal reservation, fails closed. Release
 * always returns the full held amount.
 */
export async function releaseCreditReservation(
  input: DurableReleaseCreditReservationInput
): Promise<DurableReleaseCreditReservationResult> {
  const releaseKey = normalizeReservationTransitionKey(input.releaseKey, "Release");
  const db = resolveDb(input.executor);

  const row = await selectReservationById(db, input.reservationId);
  if (!row) {
    throw new CreditReservationError(
      "RESERVATION_NOT_FOUND",
      `Credit reservation ${input.reservationId} does not exist.`
    );
  }

  if (row.releaseKey !== null) {
    if (row.releaseKey !== releaseKey) {
      throw new CreditReservationError(
        "RESERVATION_TERMINAL_STATE",
        `Reservation ${input.reservationId} is already released under a different release key.`
      );
    }
    return { reservation: rowToCreditReservation(row), duplicateClassification: "idempotent_replay" };
  }

  if (row.state !== "reserved") {
    throw new CreditReservationError(
      "RESERVATION_TERMINAL_STATE",
      `Cannot release reservation ${input.reservationId} in terminal state "${row.state}".`
    );
  }

  const releaseReason = input.reason?.trim() ? input.reason.trim() : null;
  const releasedAt = input.asOf ? new Date(input.asOf) : new Date();
  const updateResult = await db.execute(sql`
    UPDATE credit_reservations
    SET state = 'released',
        releaseKey = ${releaseKey},
        releaseReason = ${releaseReason},
        releasedAt = ${releasedAt},
        updatedAt = NOW()
    WHERE id = ${row.id} AND state = 'reserved' AND releaseKey IS NULL
  `);
  const affectedRows = (updateResult as unknown as [{ affectedRows?: number }?])?.[0]?.affectedRows ?? 0;

  if (affectedRows === 0) {
    const winner = await selectReservationById(db, input.reservationId);
    if (winner && winner.releaseKey === releaseKey && winner.state === "released") {
      return { reservation: rowToCreditReservation(winner), duplicateClassification: "idempotent_replay" };
    }
    throw new CreditReservationError(
      "RESERVATION_TERMINAL_STATE",
      `Reservation ${input.reservationId} reached a terminal state concurrently; release was not applied.`
    );
  }

  return {
    reservation: rowToCreditReservation({
      ...row,
      state: "released",
      releaseKey,
      releaseReason,
      releasedAt,
    }),
    duplicateClassification: "none",
  };
}

/** Read a persisted reservation by its deterministic id; null when absent. */
export async function getCreditReservation(
  reservationId: string,
  executor?: CreditReservationStoreExecutor
): Promise<CreditReservation | null> {
  const db = resolveDb(executor);
  const row = await selectReservationById(db, reservationId);
  return row ? rowToCreditReservation(row) : null;
}
