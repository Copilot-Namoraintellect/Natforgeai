/**
 * Wallet-backed credit reservation authority (WBS 4F / Wave 2 / WBS8C1).
 *
 * Single transaction-owning billing authority that combines the credit
 * wallet, outstanding reservation holds, and the durable WBS8B reservation
 * transitions. Every mutating operation owns db.transaction(...): wallet
 * reads, the wallet row lock, reservation transitions, and wallet deductions
 * commit or roll back together.
 *
 * Concurrency model: reservation capacity decisions for one user are
 * serialized by locking the user's credit_wallets row
 * (SELECT ... FOR UPDATE) inside the transaction. The outstanding-holds SUM
 * runs after the reservation insert within the same transaction, so a new
 * hold is counted against capacity before commit; an overcommit or spend-limit
 * breach throws and rolls back the whole transaction, including the new
 * reservation row.
 *
 * Scope: this slice establishes the authority only. Existing billing callers
 * are migrated in later slices; deductCredits / refundCredits behavior is
 * unchanged, and reserve/release never mutate wallet balances (a reservation
 * is a logical hold; only settlement deducts).
 */

import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creditTransactions } from "@db/schema";
import {
  deductCredits,
  ensureWallet,
  getCreditsSpentThisMonth,
  type CreditEngineDbExecutor,
} from "./credit-engine";
import {
  getCreditReservation,
  releaseCreditReservation,
  reserveCreditReservation,
  settleCreditReservation,
} from "./credit-reservation-store";
import {
  CreditReservationError,
  type CreditReservation,
  type CreditReservationDuplicateClassification,
  type ReleaseCreditReservationInput,
  type ReserveCreditsInput,
  type SettleCreditReservationInput,
} from "./credit-reservation";

export type WalletReservationExecutor = CreditEngineDbExecutor;

export type ReserveWalletCreditsInput = ReserveCreditsInput;

export interface SettleWalletCreditsInput extends SettleCreditReservationInput {
  /** credit_transactions type for the settlement deduction. Defaults to agent_deduction. */
  type?: typeof creditTransactions.$inferInsert["type"];
  /** Deduction description. Defaults to a deterministic settlement description. */
  description?: string;
}

export type ReleaseWalletCreditsInput = ReleaseCreditReservationInput;

export interface ReserveWalletCreditsResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
  walletBalance: number;
  /** Active reserved holds for the user after this operation. */
  reservedAmount: number;
  availableBalance: number;
}

export interface SettleWalletCreditsResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
  /** Wallet balance after the settlement deduction; current balance on replay. */
  newBalance: number;
  /** True when this call was an exact settle replay and no deduction ran. */
  alreadyDeducted?: boolean;
}

export interface ReleaseWalletCreditsResult {
  reservation: CreditReservation;
  duplicateClassification: CreditReservationDuplicateClassification;
}

export interface AvailableCreditBalance {
  walletBalance: number;
  reservedAmount: number;
  availableBalance: number;
}

interface LockedCreditWallet {
  id: number;
  userId: number;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  spendLimit: number | null;
}

/**
 * Per-user serialization authority for reservation capacity decisions.
 * Locks the user's wallet row for the duration of the transaction.
 */
async function lockCreditWalletRow(
  db: WalletReservationExecutor,
  userId: number
): Promise<LockedCreditWallet> {
  const result = await db.execute(sql`
    SELECT id, userId, balance, lifetimeEarned, lifetimeSpent, spendLimit
    FROM credit_wallets
    WHERE userId = ${userId}
    FOR UPDATE
  `);
  const rows = result[0] as unknown as LockedCreditWallet[];
  const row = rows?.[0];
  if (!row) {
    throw new CreditReservationError(
      "WALLET_NOT_FOUND",
      `Credit wallet for user ${userId} could not be locked.`
    );
  }
  return row;
}

/**
 * Active reserved holds for a user. Runs inside the caller's transaction, so
 * it sees the transaction's own uncommitted reservation rows; the
 * state = 'reserved' filter excludes settled and released holds.
 */
async function sumActiveReservedHolds(
  db: WalletReservationExecutor,
  userId: number
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(reservedAmount), 0) AS total
    FROM credit_reservations
    WHERE userId = ${userId} AND state = 'reserved'
  `);
  const rows = result[0] as unknown as { total: number }[];
  return Number(rows?.[0]?.total ?? 0);
}

/**
 * Deterministic deduction idempotency key: reservation identity + settle key
 * only. Never derives from Date.now or randomness, so a retried settlement
 * reclaims the same credit_transactions identity.
 */
export function buildSettleDeductionIdempotencyKey(
  reservationId: string,
  settleKey: string
): string {
  return createHash("sha256")
    .update(`credit-reservation-settle:${reservationId}:${settleKey}`, "utf8")
    .digest("hex");
}

/**
 * Settlement deduction metadata: safe reservation attribution only. Null
 * attribution fields are omitted rather than stored as undefined/null junk.
 */
export function buildSettleDeductionMetadata(
  reservation: CreditReservation
): Record<string, string | number> {
  const metadata: Record<string, string | number> = {
    reservationId: reservation.reservationId,
  };
  const attribution = reservation.attribution;
  if (attribution.campaignId !== null) metadata.campaignId = attribution.campaignId;
  if (attribution.workflowOperationId !== null) {
    metadata.workflowOperationId = attribution.workflowOperationId;
  }
  if (attribution.workflowAttemptId !== null) {
    metadata.workflowAttemptId = attribution.workflowAttemptId;
  }
  if (attribution.stageId !== null) metadata.stageId = attribution.stageId;
  if (attribution.artifactId !== null) metadata.artifactId = attribution.artifactId;
  if (attribution.packageId !== null) metadata.packageId = attribution.packageId;
  if (attribution.agentType !== null) metadata.agentType = attribution.agentType;
  if (attribution.model !== null) metadata.model = attribution.model;
  if (attribution.provider !== null) metadata.provider = attribution.provider;
  return metadata;
}

/**
 * Reserve wallet credits. Transaction order: ensure wallet -> lock wallet row
 * (SELECT ... FOR UPDATE) -> durable reservation insert -> capacity check.
 *
 * Capacity: available = wallet.balance - SUM(reservedAmount where state =
 * 'reserved'); the SUM runs after the insert in the same transaction, so a
 * new hold counts against itself. Overcommit or spend-limit breach throws and
 * rolls back the entire transaction, including the reservation row. An exact
 * idempotent replay never re-validates capacity and never double-counts its
 * own hold.
 */
export async function reserveWalletCredits(
  input: ReserveWalletCreditsInput
): Promise<ReserveWalletCreditsResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await ensureWallet(input.userId, tx);
    const wallet = await lockCreditWalletRow(tx, input.userId);

    const { reservation, duplicateClassification } = await reserveCreditReservation({
      ...input,
      executor: tx,
    });

    const outstanding = await sumActiveReservedHolds(tx, input.userId);

    if (duplicateClassification !== "idempotent_replay") {
      const available = wallet.balance - outstanding;
      if (available < 0) {
        throw new CreditReservationError(
          "INSUFFICIENT_CREDIT_CAPACITY",
          `Insufficient available credit capacity. Balance: ${wallet.balance}. Reserved (including this hold of ${reservation.amount}): ${outstanding}. Available: ${Math.max(0, available)}.`
        );
      }
      if (wallet.spendLimit !== null && wallet.spendLimit > 0) {
        const spentThisMonth = await getCreditsSpentThisMonth(input.userId, tx);
        if (spentThisMonth + outstanding > wallet.spendLimit) {
          throw new CreditReservationError(
            "RESERVATION_SPEND_LIMIT_EXCEEDED",
            `Reservation would exceed the AI spend limit. Limit: ${wallet.spendLimit} credits/month. Spent: ${spentThisMonth}. Active reserved holds (including this hold of ${reservation.amount}): ${outstanding}.`
          );
        }
      }
    }

    return {
      reservation,
      duplicateClassification,
      walletBalance: wallet.balance,
      reservedAmount: outstanding,
      availableBalance: Math.max(0, wallet.balance - outstanding),
    };
  });
}

/**
 * Settle wallet credits atomically: lock wallet -> durable settle transition
 * -> deduct exactly settledAmount via deductCredits (executor seam, no nested
 * transaction) with a deterministic deduction idempotency key and safe
 * attribution metadata. Settlement and deduction commit together; any failure
 * rolls back the reservation to reserved and leaves the wallet and
 * credit_transactions untouched. An exact settle replay skips the deduction
 * and returns the prior settled result.
 */
export async function settleWalletCredits(
  input: SettleWalletCreditsInput
): Promise<SettleWalletCreditsResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const existing = await getCreditReservation(input.reservationId, tx);
    if (!existing) {
      throw new CreditReservationError(
        "RESERVATION_NOT_FOUND",
        `Credit reservation ${input.reservationId} does not exist.`
      );
    }
    const wallet = await lockCreditWalletRow(tx, existing.attribution.userId);

    const { reservation, duplicateClassification } = await settleCreditReservation({
      ...input,
      executor: tx,
    });

    if (duplicateClassification === "idempotent_replay") {
      return {
        reservation,
        duplicateClassification,
        newBalance: wallet.balance,
        alreadyDeducted: true,
      };
    }

    const settledAmount = reservation.settledAmount;
    if (settledAmount === null) {
      throw new CreditReservationError(
        "INTERNAL_RESERVATION_ENGINE_ERROR",
        `Settled reservation ${reservation.reservationId} is missing its settled amount.`
      );
    }

    const { newBalance } = await deductCredits({
      userId: reservation.attribution.userId,
      amount: settledAmount,
      type: input.type ?? "agent_deduction",
      description: input.description ?? `Settle credit reservation ${reservation.reservationId}`,
      metadata: buildSettleDeductionMetadata(reservation),
      idempotencyKey: buildSettleDeductionIdempotencyKey(reservation.reservationId, input.settleKey),
      executor: tx,
    });

    return { reservation, duplicateClassification, newBalance };
  });
}

/**
 * Release wallet credits. A reservation is a logical hold and never deducted
 * wallet.balance, so release only transitions reserved -> released inside a
 * transaction (freeing capacity) and intentionally creates no refund or
 * admin-adjustment transaction. Exact replay is idempotent.
 */
export async function releaseWalletCredits(
  input: ReleaseWalletCreditsInput
): Promise<ReleaseWalletCreditsResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const { reservation, duplicateClassification } = await releaseCreditReservation({
      ...input,
      executor: tx,
    });
    return { reservation, duplicateClassification };
  });
}

/**
 * Governed read of spendable capacity: walletBalance, active reservedAmount,
 * and availableBalance = max(0, walletBalance - reservedAmount). Lock-free;
 * the legacy checkCredits() remains unchanged for existing callers.
 */
export async function getAvailableCreditBalance(
  userId: number
): Promise<AvailableCreditBalance> {
  const db = getDb();
  const wallet = await ensureWallet(userId, db);
  const reservedAmount = await sumActiveReservedHolds(db, userId);
  return {
    walletBalance: wallet.balance,
    reservedAmount,
    availableBalance: Math.max(0, wallet.balance - reservedAmount),
  };
}
