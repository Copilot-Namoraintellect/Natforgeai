// ─── Publication idempotency authority (WBS13.6) ───
//
// Durable authority proving that a retry of a publication operation cannot
// double-publish. One deterministic operation identity anchors the contract:
//
//   operationId = publication:<platform>:<queueItemId>
//
// derived through the accepted adapter identity utility
// (derivePublicationOperationId), so:
//   - a retry of the same queue item reuses the SAME operation identity;
//   - a different queue item (or platform) is a DIFFERENT operation;
//   - package identity correlates through the receipt, never re-derives it.
//
// The decision helper resolvePublicationExecutionDisposition is pure: it
// projects durable state (queue row snapshot + stored receipt) onto one
// disposition BEFORE any provider invocation:
//
//   execute        — no durable success; exactly one provider call permitted
//   retry          — durable retryable failure; provider call permitted
//   replay_success — durable success with a correlated receipt; the stored
//                    receipt answers the caller and NO provider call is made
//   terminal       — terminal failure, not-ready state, or an integrity
//                    violation (package mismatch, receipt drift); NO provider
//                    call is ever made
//
// Fail-closed guarantees:
//   - a persisted success is sufficient to stop a later retry from reaching
//     the provider (replay_success answers from durable evidence);
//   - a package mismatch against an already-successful operation is terminal:
//     the old receipt is never borrowed for different content;
//   - a failed/retryable state never resolves as success;
//   - durable drift (a success receipt with an unpublished queue row, or a
//     receipt bound to a different operation) is terminal, never executed.
//
// Pure module: no database, no provider/network calls. Persistence stays with
// the existing publishing_queue columns + audit_events (see
// publication-receipt-store.ts); scheduling/due-ness stays with the runner.

import { TRPCError } from "@trpc/server";
import {
  derivePublicationOperationId,
  type PublicationOperationIdentity,
} from "../integrations/adapters/platform-adapter";
import {
  buildLegacyReceiptFromQueueSuccess,
  normalizePublicationReceipt,
  type PublicationReceipt,
} from "./publication-receipt";

// ─── Queue state snapshot ───

/** Durable publishing_queue statuses, mirroring the schema enum. */
export const PUBLICATION_QUEUE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "failed",
  "safety_blocked",
  "retrying",
] as const;
export type PublicationQueueStatus = (typeof PUBLICATION_QUEUE_STATUSES)[number];

const QUEUE_STATUS_SET: ReadonlySet<string> = new Set(PUBLICATION_QUEUE_STATUSES);

/**
 * Fail-closed-normalized projection of the durable publishing_queue row. The
 * disposition helper never trusts a raw row: malformed snapshots are
 * rejected, never guessed.
 */
export interface PublicationQueueStateSnapshot {
  readonly queueItemId: number;
  readonly platform: string;
  readonly status: PublicationQueueStatus;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly nextRetryAt: Date | null;
  readonly externalPostId: string | null;
  readonly publishedAt: Date | null;
}

function failState(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: `Publication operation state: ${message}` });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveId(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    failState(`invalid ${name}: expected a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInt(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    failState(`invalid ${name}: expected a non-negative safe integer`);
  }
  return value;
}

function normalizeNullableTimestamp(value: unknown, name: string): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) failState(`invalid ${name}: unparseable date`);
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) failState(`invalid ${name}: unparseable timestamp`);
    return parsed;
  }
  failState(`invalid ${name}: expected a Date, ISO string, or null`);
}

function normalizeNullableText(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failState(`invalid ${name}: expected a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) failState(`invalid ${name}: expected at most ${max} characters`);
  return trimmed;
}

/**
 * Normalize a raw publishing_queue row projection into the state snapshot.
 * Platform is lowercased (the schema stores free-form platform text; the
 * operation identity is case-normalized by the accepted derivation).
 */
export function normalizePublicationQueueState(
  row: unknown
): PublicationQueueStateSnapshot {
  if (!isPlainObject(row)) failState("queue row must be a structured object");
  const queueItemId = normalizePositiveId(row.id ?? row.queueItemId, "queue item id");
  const platformText = normalizeNullableText(row.platform, "platform", 64);
  if (!platformText) failState("invalid platform: expected a non-empty string");
  const status = typeof row.status === "string" ? row.status.trim() : "";
  if (!QUEUE_STATUS_SET.has(status)) {
    failState(`invalid queue status: ${JSON.stringify(row.status)}`);
  }
  return Object.freeze({
    queueItemId,
    platform: platformText.toLowerCase(),
    status: status as PublicationQueueStatus,
    retryCount: normalizeNonNegativeInt(row.retryCount ?? 0, "retryCount"),
    maxRetries: normalizeNonNegativeInt(row.maxRetries ?? 3, "maxRetries"),
    nextRetryAt: normalizeNullableTimestamp(row.nextRetryAt ?? null, "nextRetryAt"),
    externalPostId: normalizeNullableText(row.externalPostId, "externalPostId", 1024),
    publishedAt: normalizeNullableTimestamp(row.publishedAt ?? null, "publishedAt"),
  });
}

// ─── Operation identity ───

/**
 * The one deterministic publication operation identity contract (WBS13.6):
 * the accepted queue-item/platform derivation, fail-closed validated. Every
 * authority in this module binds to this identity and nothing else.
 */
export function resolvePublicationOperationIdentity(input: {
  queueItemId: unknown;
  platform: unknown;
}): PublicationOperationIdentity {
  const queueItemId = normalizePositiveId(input.queueItemId, "queueItemId");
  const platform = normalizeNullableText(input.platform, "platform", 64);
  if (!platform) failState("invalid platform: expected a non-empty string");
  return { operationId: derivePublicationOperationId({ platform, queueItemId }) };
}

// ─── Operation state ───

/** Governed package binding expected by the current execution attempt. */
export interface PublicationExpectedPackageBinding {
  readonly publishPackageId: string;
  readonly packageFingerprintSha256: string;
}

/**
 * Normalized operation state the disposition decision is pure over:
 * durable queue state + stored receipt + the package this attempt is bound
 * to + optional open-attempt evidence.
 */
export interface PublicationOperationState {
  readonly operationId: string;
  readonly queue: PublicationQueueStateSnapshot;
  /** Canonical stored receipt, when one was persisted for this operation. */
  readonly receipt: PublicationReceipt | null;
  /** Governed package binding for this attempt; null on the legacy path. */
  readonly expectedPackage: PublicationExpectedPackageBinding | null;
  /**
   * Attempt ordinal already evidenced durably (publication_attempt), when
   * known. Distinguishes an in-flight operation from a fresh one; a crash
   * between attempt evidence and outcome leaves the row executable but
   * annotated, never a false success.
   */
  readonly openAttemptOrdinal: number | null;
}

function normalizeExpectedPackage(
  value: unknown
): PublicationExpectedPackageBinding | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) failState("expectedPackage must be a structured object or null");
  const publishPackageId = normalizeNullableText(
    value.publishPackageId,
    "publishPackageId",
    128
  );
  if (!publishPackageId) failState("invalid publishPackageId: expected a non-empty string");
  const fingerprint = value.packageFingerprintSha256;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint.trim().toLowerCase())) {
    failState("invalid packageFingerprintSha256: expected 64-character lowercase SHA-256 hex");
  }
  return Object.freeze({
    publishPackageId,
    packageFingerprintSha256: fingerprint.trim().toLowerCase(),
  });
}

function normalizeOpenAttemptOrdinal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return normalizePositiveId(value, "openAttemptOrdinal");
}

/**
 * Assemble the normalized operation state from raw projections. Fail closed:
 * malformed queue rows, malformed stored receipts, and malformed package
 * bindings throw instead of guessing.
 */
export function buildPublicationOperationState(input: {
  queue: unknown;
  receipt?: unknown;
  expectedPackage?: unknown;
  openAttemptOrdinal?: unknown;
}): PublicationOperationState {
  const queue = normalizePublicationQueueState(input.queue);
  const operation = resolvePublicationOperationIdentity({
    queueItemId: queue.queueItemId,
    platform: queue.platform,
  });
  let receipt: PublicationReceipt | null = null;
  if (input.receipt !== null && input.receipt !== undefined) {
    receipt = normalizePublicationReceipt(input.receipt);
    if (
      receipt.queueItemId !== queue.queueItemId ||
      receipt.platform !== queue.platform
    ) {
      failState("stored receipt is bound to a different queue item or platform");
    }
  }
  return Object.freeze({
    operationId: operation.operationId,
    queue,
    receipt,
    expectedPackage: normalizeExpectedPackage(input.expectedPackage ?? null),
    openAttemptOrdinal: normalizeOpenAttemptOrdinal(input.openAttemptOrdinal ?? null),
  });
}

// ─── Execution disposition ───

export const PUBLICATION_TERMINAL_REASONS = [
  /** Durable terminal failure (failed / safety_blocked). */
  "already_terminal",
  /** Queue state cannot accept execution (draft / pending_approval). */
  "not_ready",
  /** Retry budget exhausted (defensive; the runner normally terminalises). */
  "attempts_exhausted",
  /** Attempted package cannot be reconciled with durable success. */
  "package_mismatch",
  /** Durable evidence contradicts itself; fail closed. */
  "receipt_state_drift",
] as const;
export type PublicationTerminalReason = (typeof PUBLICATION_TERMINAL_REASONS)[number];

/**
 * The pre-invocation publication decision. `replay_success` and `terminal`
 * both prohibit a provider call; only `execute` and `retry` permit exactly
 * one. `replay_success.replayedWithoutProviderCall` is a type-level literal
 * guarantee that the stored receipt — never a fresh provider call — answered.
 */
export type PublicationExecutionDisposition =
  | {
      readonly outcome: "execute";
      readonly operationId: string;
      readonly queueItemId: number;
      readonly platform: string;
      readonly attemptOrdinal: number;
      readonly maxRetries: number;
      readonly openAttemptOrdinal: number | null;
    }
  | {
      readonly outcome: "retry";
      readonly operationId: string;
      readonly queueItemId: number;
      readonly platform: string;
      readonly attemptOrdinal: number;
      readonly retryCount: number;
      readonly maxRetries: number;
      readonly nextRetryAt: Date | null;
      readonly openAttemptOrdinal: number | null;
    }
  | {
      readonly outcome: "replay_success";
      readonly operationId: string;
      readonly queueItemId: number;
      readonly platform: string;
      readonly receipt: PublicationReceipt;
      readonly replayedWithoutProviderCall: true;
    }
  | {
      readonly outcome: "terminal";
      readonly operationId: string;
      readonly queueItemId: number;
      readonly platform: string;
      readonly reason: PublicationTerminalReason;
      readonly message: string;
    };

function terminal(
  state: PublicationOperationState,
  reason: PublicationTerminalReason,
  message: string
): PublicationExecutionDisposition {
  return Object.freeze({
    outcome: "terminal",
    operationId: state.operationId,
    queueItemId: state.queue.queueItemId,
    platform: state.queue.platform,
    reason,
    message,
  });
}

/**
 * Prove the expected package binding against durable success. A governed
 * attempt may only replay a receipt that records the SAME package id and
 * fingerprint; a legacy success receipt (or a queue row alone, which carries
 * no package anchor) can never be proven to belong to the attempted package,
 * so it fails closed instead of borrowing the old receipt.
 */
function packageGate(
  state: PublicationOperationState
): PublicationExecutionDisposition | null {
  const expected = state.expectedPackage;
  if (!expected) return null;
  const receipt = state.receipt;
  const mismatched =
    !receipt ||
    receipt.publishPackageId !== expected.publishPackageId ||
    receipt.packageFingerprintSha256 !== expected.packageFingerprintSha256;
  if (mismatched) {
    return terminal(
      state,
      "package_mismatch",
      "The attempted publish package does not match the package recorded by the durable " +
        "publication success; refusing to reuse the existing receipt for different content."
    );
  }
  return null;
}

/**
 * Pure pre-invocation decision for one publication operation. The runner
 * consults this BEFORE any provider call; `replay_success` and `terminal`
 * never reach the provider. Scheduling/due-ness (scheduledAt / nextRetryAt
 * windows) deliberately stays with the runner — this contract answers only
 * idempotency, never timing.
 */
export function resolvePublicationExecutionDisposition(
  state: PublicationOperationState
): PublicationExecutionDisposition {
  if (!state || typeof state !== "object") {
    failState("disposition requires a normalized operation state");
  }
  const queue = state.queue;
  const base = {
    operationId: state.operationId,
    queueItemId: queue.queueItemId,
    platform: queue.platform,
  };

  // A stored receipt must be bound to THIS operation (guaranteed by
  // buildPublicationOperationState) and agree with durable queue state.
  const durableSuccess = queue.status === "published" && queue.publishedAt !== null;
  const receiptSuccess = state.receipt !== null;
  if (receiptSuccess && !durableSuccess) {
    return terminal(
      state,
      "receipt_state_drift",
      "A durable publication success receipt exists but the queue row is not published; " +
        "refusing to execute or fabricate an outcome."
    );
  }

  if (durableSuccess) {
    const gate = packageGate(state);
    if (gate) return gate;
    const receipt =
      state.receipt ??
      buildLegacyReceiptFromQueueSuccess({
        queueItemId: queue.queueItemId,
        platform: queue.platform,
        status: queue.status,
        externalPostId: queue.externalPostId,
        publishedAt: queue.publishedAt,
      });
    if (!receipt) {
      // Unreachable for a published row with publishedAt, but never guess.
      return terminal(
        state,
        "receipt_state_drift",
        "Durable published state could not produce a receipt; failing closed."
      );
    }
    return Object.freeze({
      outcome: "replay_success",
      ...base,
      receipt,
      replayedWithoutProviderCall: true as const,
    });
  }

  switch (queue.status) {
    case "approved":
      return Object.freeze({
        outcome: "execute",
        ...base,
        attemptOrdinal: queue.retryCount + 1,
        maxRetries: queue.maxRetries,
        openAttemptOrdinal: state.openAttemptOrdinal,
      });
    case "retrying":
      if (queue.retryCount >= queue.maxRetries) {
        return terminal(
          state,
          "attempts_exhausted",
          `Retry budget exhausted (${queue.retryCount}/${queue.maxRetries}) without durable success.`
        );
      }
      return Object.freeze({
        outcome: "retry",
        ...base,
        attemptOrdinal: queue.retryCount + 1,
        retryCount: queue.retryCount,
        maxRetries: queue.maxRetries,
        nextRetryAt: queue.nextRetryAt,
        openAttemptOrdinal: state.openAttemptOrdinal,
      });
    case "failed":
    case "safety_blocked":
      return terminal(
        state,
        "already_terminal",
        `Queue item is ${queue.status}; a retry cannot change a durable terminal outcome.`
      );
    case "draft":
    case "pending_approval":
      return terminal(
        state,
        "not_ready",
        `Queue item is ${queue.status} and is not eligible for publication execution.`
      );
    case "published":
      // published without publishedAt: not a provable durable success.
      return terminal(
        state,
        "receipt_state_drift",
        "Queue row is published without a publication timestamp; failing closed."
      );
    default:
      return terminal(
        state,
        "receipt_state_drift",
        `Unhandled durable queue status ${JSON.stringify(queue.status)}; failing closed.`
      );
  }
}
