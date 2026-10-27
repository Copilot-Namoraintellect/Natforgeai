// ─── R6-D Nurture / Sales Handoff — execution transport seam (contract §11) ───
//
// The safe provider/CRM execution seam. Governed dispatch commands flow
// through NurtureTransport ONLY; server-side service code builds the command
// (never model output directly), the capability gate has already passed, and
// the executionIdentity is the transport idempotency key.
//
// THE ONLY IMPLEMENTATION SHIPPED IN R6-D IS THE FAKE, TEST-ONLY IN-MEMORY
// TRANSPORT BELOW. It performs no network I/O, contacts no real lead, and is
// used solely by tests. Real CRM/provider transports are R6-X activation
// slots behind the same interface — nothing in R6-D calls a real provider.

import type { DispatchContent } from "./nurture-content-boundary";

export interface HandoffDispatchCommand {
  /** Transport idempotency key — replays converge, no duplicate effect. */
  readonly executionIdentity: string;
  readonly handoffId: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly leadId: string;
  readonly channel: string;
  /** Server-validated draft content only (contentHash pinned). */
  readonly content: DispatchContent;
}

export type HandoffDispatchOutcome = "ACCEPTED" | "REJECTED" | "FAILURE";

export interface HandoffDispatchResult {
  readonly executionIdentity: string;
  readonly outcome: HandoffDispatchOutcome;
  /** Bounded acknowledgement label; fake transports label themselves. */
  readonly providerAck: string | null;
  readonly occurredAt: string;
}

export interface NurtureTransport {
  dispatch(command: HandoffDispatchCommand): Promise<HandoffDispatchResult>;
}

// ─── FAKE / TEST-ONLY implementation ───

export const FAKE_TRANSPORT_ACK = "fake-transport:accepted:test-only" as const;

export interface FakeNurtureTransportOptions {
  /** Deterministic clock for tests (ISO string). */
  now?: string;
  /** Fail the first N dispatch attempts with outcome FAILURE (default 0). */
  failFirstAttempts?: number;
  /** Reject every dispatch with outcome REJECTED (default false). */
  rejectAll?: boolean;
}

export interface FakeNurtureTransport extends NurtureTransport {
  /** Durable fake ledger: executionIdentity ⇒ first outcome (replay-safe). */
  readonly outcomes: ReadonlyMap<string, HandoffDispatchResult>;
  readonly attempts: ReadonlyArray<{ executionIdentity: string; handoffId: string }>;
}

/**
 * ⚠️ TEST-ONLY. Explicitly fake in-memory transport (contract §10). The ack
 * label is self-describing; no network I/O ever happens here. Replays of the
 * same executionIdentity converge to the FIRST recorded outcome — mirroring
 * how a real idempotent provider behaves — so duplicate dispatch never
 * duplicates the external effect.
 */
export function createFakeNurtureTransport(options: FakeNurtureTransportOptions = {}): FakeNurtureTransport {
  const outcomes = new Map<string, HandoffDispatchResult>();
  const attempts: Array<{ executionIdentity: string; handoffId: string }> = [];
  let failuresRemaining = options.failFirstAttempts ?? 0;

  return {
    outcomes,
    attempts,
    async dispatch(command: HandoffDispatchCommand): Promise<HandoffDispatchResult> {
      attempts.push({ executionIdentity: command.executionIdentity, handoffId: command.handoffId });
      const existing = outcomes.get(command.executionIdentity);
      if (existing) return existing; // idempotent replay — first outcome wins

      const occurredAt = options.now ?? new Date().toISOString();
      let outcome: HandoffDispatchOutcome;
      if (options.rejectAll) {
        outcome = "REJECTED";
      } else if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        outcome = "FAILURE";
      } else {
        outcome = "ACCEPTED";
      }
      const result: HandoffDispatchResult = Object.freeze({
        executionIdentity: command.executionIdentity,
        outcome,
        providerAck: outcome === "ACCEPTED" ? FAKE_TRANSPORT_ACK : null,
        occurredAt,
      });
      outcomes.set(command.executionIdentity, result);
      return result;
    },
  };
}
