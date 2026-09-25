import type { AdapterErrorCategory } from "../integrations/adapters/platform-adapter";

/**
 * WBS13.8 — Canonical governed publication recovery policy.
 *
 * One deterministic authority that answers: "a publication attempt failed —
 * what is the next recovery action?" It consumes a NORMALIZED publication
 * failure context (failure stage + optional normalized provider error + the
 * durable queue retry counters) and returns a closed recovery decision that
 * later execution slices can apply without re-classifying anything.
 *
 * PURE POLICY MODULE:
 *  - No provider calls, no network calls, no database access, no clock reads
 *    (the caller supplies `now` explicitly).
 *  - No mutation authority: every decision carries enough structured intent
 *    to drive execution later, but this module authorizes nothing and mutates
 *    nothing. `mutationAuthorized` is always false.
 *  - Deterministic: the same input context always yields the same decision,
 *    including `nextRetryAt` (derived only from the explicit `now`).
 *
 * Semantics centralized here (mirrored 1:1 from the established publishing
 * behavior so nothing silently conflicts):
 *  - Retry schedule: fixed delays of 1 minute, 5 minutes, 15 minutes, indexed
 *    by the upcoming attempt ordinal and clamped at the final slot — the same
 *    schedule the publishing runner and BullMQ publishing queue use today.
 *  - Retry budget boundary: an attempt that fails with
 *    `retryCount + 1 >= maxRetries` (default 3) is terminal; there is no
 *    endless retry.
 *  - Precondition / authority failures never consume retry budget: they fail
 *    closed immediately and stay recoverable only through explicit manual
 *    requeue (the terminal-replay authority) after authority is revalidated.
 *
 * The provider evidence model deliberately excludes tokens, secrets, raw
 * provider responses and raw error text: recovery reasoning never needs them.
 */

// ─── Retry schedule (canonical) ───

/**
 * Fixed backoff delays in milliseconds: 1 minute, 5 minutes, 15 minutes.
 * This is the single canonical definition of the publication retry schedule;
 * the publishing runner and the BullMQ publishing queue options mirror it.
 */
export const PUBLICATION_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;

/** Default retry budget when a queue item does not declare `maxRetries`. */
export const PUBLICATION_DEFAULT_MAX_RETRIES = 3;

// ─── Failure taxonomy ───

/**
 * Publication failure stages, mirroring the durable publication audit
 * `failureStage` vocabulary used by the publishing runner.
 */
export type PublicationFailureStage =
  | "billing"
  | "provider"
  | "runtime"
  | "precondition"
  | "integration"
  | "media";

/**
 * Recovery classes the policy reasons about. The first six are the WBS13.8
 * required classes; `billing` is the repo's additional durable failure stage
 * and is handled explicitly so credit failures are never misclassified as
 * provider failures.
 */
export type PublicationRecoveryClass =
  | "precondition"
  | "auth"
  | "rate_limited"
  | "network"
  | "provider_rejection"
  | "billing"
  | "unknown";

/** Next recovery action a caller may take for a failed publication attempt. */
export type PublicationRecoveryAction =
  | "retry"
  | "fail_terminal"
  | "require_approval"
  | "reconnect"
  | "escalate";

/**
 * Durable queue status a terminal decision lands on. `failed` is the
 * terminally-failed state; `pending_approval` is used only by the
 * require_approval action (approval-authority precondition), which parks the
 * item awaiting a human decision instead of fabricating a failure.
 */
export type PublicationRecoveryTerminalStatus = "failed" | "pending_approval";

/**
 * Refinement of a precondition-stage failure. `approval_authority` routes to
 * the require_approval action; every other kind fails closed terminally.
 */
export type PublicationPreconditionKind =
  | "readiness"
  | "package_integrity"
  | "package_freshness"
  | "destination_mismatch"
  | "approval_authority";

/**
 * Normalized provider failure reference. `category`/`code`/`retryable` reuse
 * the governed adapter normalization
 * (`AdapterProviderError`): `retryable` answers "could a retry of the
 * identical operation succeed?", never "should the runner retry?" — this
 * policy owns that second decision.
 */
export interface PublicationProviderFailureRef {
  readonly category: AdapterErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
}

/** Normalized input context for one failed publication attempt. */
export interface PublicationFailureContext {
  /** Durable audit failure stage for this attempt. */
  readonly stage: PublicationFailureStage;
  /** Explicit decision clock — the only time source, for determinism. */
  readonly now: Date;
  /** Durable queue `retryCount` before this failure (0 for a first attempt). */
  readonly retryCount: number;
  /** Durable queue `maxRetries`; defaults to PUBLICATION_DEFAULT_MAX_RETRIES. */
  readonly maxRetries?: number | null;
  /** Required when `stage` is "precondition"; ignored otherwise. */
  readonly preconditionKind?: PublicationPreconditionKind;
  /** Normalized provider error when `stage` is "provider" or "runtime". */
  readonly provider?: PublicationProviderFailureRef | null;
}

/** Closed recovery decision for one failed publication attempt. */
export interface PublicationRecoveryDecision {
  readonly recoveryClass: PublicationRecoveryClass;
  readonly action: PublicationRecoveryAction;
  /** True only when another automated attempt is scheduled. */
  readonly retryable: boolean;
  /** True only when a later attempt may call the provider again. */
  readonly callProviderAgain: boolean;
  /** Retry counter before this failure. */
  readonly retryCount: number;
  /**
   * Retry counter the decision implies. Retry/escalate decisions consume one
   * attempt (retryCount + 1); fail-fast terminal decisions
   * (precondition/auth/provider_rejection) deliberately leave the budget
   * untouched so authority/credential/payload failures never consume
   * meaningless retries.
   */
  readonly nextRetryCount: number;
  readonly maxRetries: number;
  /** Backoff delay for a retry decision; null otherwise. */
  readonly delayMs: number | null;
  /** Deterministic next attempt time: explicit `now` + `delayMs`; null otherwise. */
  readonly nextRetryAt: Date | null;
  /** True when no further automated attempt will occur for this decision. */
  readonly terminal: boolean;
  /** Durable terminal status; null while a retry is scheduled. */
  readonly terminalStatus: PublicationRecoveryTerminalStatus | null;
  /** True when the outcome must be escalated to an operator alert channel. */
  readonly escalationRequired: boolean;
  /** Human-readable, sanitized reason; never echoes raw provider/error text. */
  readonly safeReason: string;
  /** Echo of the input failure stage for downstream correlation. */
  readonly failureStage: PublicationFailureStage;
  /** Normalized decision time (the explicit `now`). */
  readonly decidedAt: Date;
  /** Pure policy: execution authority is always false here. */
  readonly mutationAuthorized: false;
}

const FAILURE_STAGES: readonly PublicationFailureStage[] = [
  "billing",
  "provider",
  "runtime",
  "precondition",
  "integration",
  "media",
];

const PROVIDER_CATEGORIES: readonly AdapterErrorCategory[] = [
  "auth",
  "validation",
  "rate_limited",
  "network",
  "provider",
  "unsupported",
];

const PRECONDITION_KINDS: readonly PublicationPreconditionKind[] = [
  "readiness",
  "package_integrity",
  "package_freshness",
  "destination_mismatch",
  "approval_authority",
];

function assertValidStage(stage: PublicationFailureStage): void {
  if (!FAILURE_STAGES.includes(stage)) {
    throw new TypeError(`Malformed publication failure stage: ${String(stage)}`);
  }
}

function assertContextShape(context: PublicationFailureContext): number {
  if (!context || typeof context !== "object") {
    throw new TypeError("Invalid publication failure context: expected an object");
  }
  assertValidStage(context.stage);
  if (!(context.now instanceof Date) || Number.isNaN(context.now.getTime())) {
    throw new TypeError("Invalid publication failure context: `now` must be a valid Date");
  }
  if (!Number.isInteger(context.retryCount) || context.retryCount < 0) {
    throw new TypeError(`Malformed retryCount: ${String(context.retryCount)}`);
  }
  const maxRetries = context.maxRetries ?? PUBLICATION_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new TypeError(`Malformed maxRetries: ${String(context.maxRetries)}`);
  }
  if (context.stage === "precondition") {
    const kind = context.preconditionKind ?? "readiness";
    if (!PRECONDITION_KINDS.includes(kind)) {
      throw new TypeError(`Malformed preconditionKind: ${String(context.preconditionKind)}`);
    }
  }
  if (context.provider != null) {
    if (!PROVIDER_CATEGORIES.includes(context.provider.category)) {
      throw new TypeError(`Malformed provider category: ${String(context.provider.category)}`);
    }
    if (typeof context.provider.code !== "string" || context.provider.code.length === 0) {
      throw new TypeError("Malformed provider error code: expected a non-empty string");
    }
  }
  return maxRetries;
}

/**
 * Canonical backoff delay for the upcoming attempt ordinal
 * (`retryCount + 1`), clamped at the final schedule slot. The schedule is
 * fixed, so the same ordinal always yields the same delay.
 */
export function resolvePublicationRetryDelayMs(nextAttemptOrdinal: number): number {
  if (!Number.isInteger(nextAttemptOrdinal) || nextAttemptOrdinal < 1) {
    throw new TypeError(`Malformed retry attempt ordinal: ${String(nextAttemptOrdinal)}`);
  }
  const index = Math.min(nextAttemptOrdinal - 1, PUBLICATION_RETRY_DELAYS_MS.length - 1);
  return PUBLICATION_RETRY_DELAYS_MS[index];
}

/**
 * Pure recovery-class mapping from the durable failure stage and the
 * normalized provider error classification. Fixed rule order, first match
 * wins; the same context always yields the same class.
 */
export function classifyPublicationRecoveryClass(context: {
  readonly stage: PublicationFailureStage;
  readonly provider?: PublicationProviderFailureRef | null;
}): PublicationRecoveryClass {
  assertValidStage(context.stage);
  switch (context.stage) {
    case "precondition":
      return "precondition";
    case "integration":
      return "auth";
    case "media":
      return "provider_rejection";
    case "billing":
      return "billing";
    case "provider":
    case "runtime": {
      const category = context.provider?.category;
      if (category === "auth") return "auth";
      if (category === "rate_limited") return "rate_limited";
      if (category === "network") return "network";
      if (category === "validation" || category === "unsupported") return "provider_rejection";
      if (category === "provider") {
        // Generic provider failure: the provider classification decides.
        return context.provider?.retryable ? "rate_limited" : "provider_rejection";
      }
      return "unknown";
    }
  }
}

function buildSafeReason(input: {
  recoveryClass: PublicationRecoveryClass;
  action: PublicationRecoveryAction;
  stage: PublicationFailureStage;
  preconditionKind: PublicationPreconditionKind;
  nextRetryCount: number;
  maxRetries: number;
}): string {
  switch (input.action) {
    case "retry":
      switch (input.recoveryClass) {
        case "rate_limited":
          return "Provider rate limit reached; a bounded retry is scheduled.";
        case "network":
          return "Network or timeout failure while contacting the provider; a bounded retry is scheduled.";
        case "billing":
          return "Publishing could not be charged; a bounded retry is scheduled. If it persists, resolve credits and recover the item manually.";
        default:
          return "Publication failed for an unidentified reason; a bounded conservative retry is scheduled.";
      }
    case "escalate":
      return `Publication failed after ${input.nextRetryCount} of ${input.maxRetries} attempts; the retry budget is exhausted and the item is escalated for operator recovery.`;
    case "reconnect":
      return "Publication credential failure: the platform integration is disconnected or its token expired or was revoked. Reconnect the integration to recover.";
    case "require_approval":
      return "Publication authority is incomplete: a required approval is missing. A human approval decision is required before this item can publish or be recovered.";
    case "fail_terminal":
      switch (input.preconditionKind) {
        case "package_integrity":
          return "Publication authority precondition failed: the publish package failed integrity checks. The item is terminal until authority is revalidated and it is manually requeued.";
        case "package_freshness":
          return "Publication authority precondition failed: the publish package no longer matches the current content. The item is terminal until authority is revalidated and it is manually requeued.";
        case "destination_mismatch":
          return "Publication authority precondition failed: the package destination no longer matches the resolved integration. The item is terminal until authority is revalidated and it is manually requeued.";
        case "readiness":
        default:
          if (input.stage === "media") {
            return "Publication payload failed a local media check and was never sent to the provider. The item is terminal until the payload is fixed and it is manually requeued.";
          }
          if (input.stage === "provider" || input.stage === "runtime") {
            return "The provider rejected the publication payload; the item is terminal until the payload is corrected and it is manually requeued.";
          }
          return "Publication readiness precondition failed; the item is terminal until authority is revalidated and it is manually requeued.";
      }
  }
}

/**
 * Canonical recovery decision for one failed publication attempt.
 * Deterministic and side-effect free: identical contexts produce identical
 * decisions, and `nextRetryAt` is derived only from the explicit `now`.
 */
export function decidePublicationRecovery(
  context: PublicationFailureContext
): PublicationRecoveryDecision {
  const maxRetries = assertContextShape(context);
  const retryCount = context.retryCount;
  const now = context.now;
  const recoveryClass = classifyPublicationRecoveryClass(context);
  const preconditionKind: PublicationPreconditionKind =
    context.stage === "precondition" ? (context.preconditionKind ?? "readiness") : "readiness";

  const base = {
    recoveryClass,
    retryCount,
    maxRetries,
    failureStage: context.stage,
    decidedAt: now,
    mutationAuthorized: false as const,
  };

  switch (recoveryClass) {
    case "precondition": {
      const needsApproval = preconditionKind === "approval_authority";
      const action: PublicationRecoveryAction = needsApproval ? "require_approval" : "fail_terminal";
      return {
        ...base,
        action,
        retryable: false,
        callProviderAgain: false,
        // Fail-fast authority failures never consume retry budget.
        nextRetryCount: retryCount,
        delayMs: null,
        nextRetryAt: null,
        terminal: true,
        terminalStatus: needsApproval ? "pending_approval" : "failed",
        escalationRequired: false,
        safeReason: buildSafeReason({
          recoveryClass,
          action,
          stage: context.stage,
          preconditionKind,
          nextRetryCount: retryCount,
          maxRetries,
        }),
      };
    }

    case "auth": {
      const action: PublicationRecoveryAction = "reconnect";
      return {
        ...base,
        action,
        retryable: false,
        callProviderAgain: false,
        nextRetryCount: retryCount,
        delayMs: null,
        nextRetryAt: null,
        terminal: true,
        terminalStatus: "failed",
        escalationRequired: false,
        safeReason: buildSafeReason({
          recoveryClass,
          action,
          stage: context.stage,
          preconditionKind,
          nextRetryCount: retryCount,
          maxRetries,
        }),
      };
    }

    case "provider_rejection": {
      const action: PublicationRecoveryAction = "fail_terminal";
      // Local media checks (no provider call was made) stay silent, matching
      // current behavior; provider-side rejections are escalated for an operator.
      const escalationRequired = context.stage === "provider" || context.stage === "runtime";
      return {
        ...base,
        action,
        retryable: false,
        callProviderAgain: false,
        nextRetryCount: retryCount,
        delayMs: null,
        nextRetryAt: null,
        terminal: true,
        terminalStatus: "failed",
        escalationRequired,
        safeReason: buildSafeReason({
          recoveryClass,
          action,
          stage: context.stage,
          preconditionKind,
          nextRetryCount: retryCount,
          maxRetries,
        }),
      };
    }

    case "billing":
    case "rate_limited":
    case "network":
    case "unknown": {
      const nextRetryCount = retryCount + 1;
      if (nextRetryCount >= maxRetries) {
        const action: PublicationRecoveryAction = "escalate";
        return {
          ...base,
          action,
          retryable: false,
          callProviderAgain: false,
          nextRetryCount,
          delayMs: null,
          nextRetryAt: null,
          terminal: true,
          terminalStatus: "failed",
          escalationRequired: true,
          safeReason: buildSafeReason({
            recoveryClass,
            action,
            stage: context.stage,
            preconditionKind,
            nextRetryCount,
            maxRetries,
          }),
        };
      }
      const action: PublicationRecoveryAction = "retry";
      const delayMs = resolvePublicationRetryDelayMs(nextRetryCount);
      return {
        ...base,
        action,
        retryable: true,
        callProviderAgain: true,
        nextRetryCount,
        delayMs,
        nextRetryAt: new Date(now.getTime() + delayMs),
        terminal: false,
        terminalStatus: null,
        escalationRequired: false,
        safeReason: buildSafeReason({
          recoveryClass,
          action,
          stage: context.stage,
          preconditionKind,
          nextRetryCount,
          maxRetries,
        }),
      };
    }
  }
}

// ─── Manual recovery (requeue) eligibility ───

/** Durable publishing_queue statuses relevant to manual recovery. */
export type PublishingQueueRecoveryStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "published"
  | "failed"
  | "safety_blocked"
  | "retrying";

/**
 * Recovery path a successful eligibility evaluation routes to. Only the
 * existing product mechanisms are named — no new UI/API action is introduced
 * here.
 */
export type ManualRecoveryPath =
  | "terminal_replay"
  | "reconnect_then_terminal_replay"
  | "resolve_approval_block";

/** Billing evidence states, mirroring the terminal-replay billing authority. */
export type ManualRecoveryBillingEvidence =
  | "exact_single_deduction"
  | "missing"
  | "ambiguous";

/** Normalized evidence for the pure manual-recovery eligibility check. */
export interface ManualRecoveryEligibilityInput {
  /** Current durable publishing_queue status. */
  readonly status: PublishingQueueRecoveryStatus;
  /** Recovery class of the terminal failure being recovered. */
  readonly recoveryClass: PublicationRecoveryClass;
  /** A durable queue_terminal_failures row anchors the replay authority. */
  readonly hasTerminalFailureRecord: boolean;
  /** precondition: readiness + package integrity/freshness re-run clean. */
  readonly authorityRevalidated?: boolean;
  /** auth: the platform integration has been reconnected. */
  readonly integrationConnected?: boolean;
  /** billing: prior publishing deduction evidence state. */
  readonly billingEvidence?: ManualRecoveryBillingEvidence;
}

/** Closed eligibility result for manually recovering a terminal queue item. */
export interface ManualRecoveryEligibility {
  readonly eligible: boolean;
  /** Existing product path the recovery must follow; null when ineligible. */
  readonly recoveryPath: ManualRecoveryPath | null;
  /** Authority that must be (re)validated before any requeue; empty when ineligible. */
  readonly requiredAuthority: readonly string[];
  /** Sanitized, human-readable explanation; null when eligible. */
  readonly reason: string | null;
  /** Pure policy: execution authority is always false here. */
  readonly mutationAuthorized: false;
}

const RECOVERY_CLASSES: readonly PublicationRecoveryClass[] = [
  "precondition",
  "auth",
  "rate_limited",
  "network",
  "provider_rejection",
  "billing",
  "unknown",
];

const REQUIRED_AUTHORITY: Record<PublicationRecoveryClass, readonly string[]> = {
  precondition: [
    "publication readiness",
    "publish package integrity and freshness",
    "destination binding",
  ],
  auth: ["reconnected platform integration", "operator replay request"],
  rate_limited: ["operator replay request"],
  network: ["operator replay request"],
  provider_rejection: ["corrected publication payload", "operator replay request"],
  billing: ["exactly one prior publishing deduction", "operator replay request"],
  unknown: ["operator replay request"],
};

const QUEUE_RECOVERY_STATUSES: readonly PublishingQueueRecoveryStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "failed",
  "safety_blocked",
  "retrying",
];

function ineligible(
  recoveryPath: ManualRecoveryPath | null,
  reason: string
): ManualRecoveryEligibility {
  return {
    eligible: false,
    recoveryPath,
    requiredAuthority: [],
    reason,
    mutationAuthorized: false,
  };
}

function eligible(recoveryClass: PublicationRecoveryClass): ManualRecoveryEligibility {
  return {
    eligible: true,
    recoveryPath: recoveryClass === "auth" ? "reconnect_then_terminal_replay" : "terminal_replay",
    requiredAuthority: REQUIRED_AUTHORITY[recoveryClass],
    reason: null,
    mutationAuthorized: false,
  };
}

/**
 * Pure eligibility for manually recovering a queue item through the existing
 * product mechanisms (terminal replay / reconnect / approval flow).
 *
 * Safety invariants:
 *  - A successfully published item is NEVER requeue-eligible: requeueing it
 *    would duplicate publication.
 *  - Only a durable `failed` item with a terminal-failure record is a
 *    candidate; every class must revalidate its own authority first
 *    (reconnect for credentials, authority revalidation for preconditions,
 *    exactly-one billing deduction for billing failures).
 *  - Approval-blocked items are not terminal failures: their recovery path is
 *    the approval flow, never a blind requeue.
 */
export function evaluateManualRecoveryEligibility(
  input: ManualRecoveryEligibilityInput
): ManualRecoveryEligibility {
  if (!input || typeof input !== "object") {
    throw new TypeError("Invalid manual recovery input: expected an object");
  }
  if (!QUEUE_RECOVERY_STATUSES.includes(input.status)) {
    throw new TypeError(`Malformed publishing queue status: ${String(input.status)}`);
  }
  if (!RECOVERY_CLASSES.includes(input.recoveryClass)) {
    throw new TypeError(`Malformed recovery class: ${String(input.recoveryClass)}`);
  }

  // 1. Published success can never be requeued into duplicate publication.
  if (input.status === "published") {
    return ineligible(
      null,
      "Queue item is already published; requeueing it would duplicate publication."
    );
  }

  // 2. Already recovering: only an in-flight replay request may resume it.
  if (input.status === "retrying") {
    return ineligible(
      null,
      "Queue item is already recovering; only an in-flight replay request may resume it."
    );
  }

  // 3. Approval-blocked items are recovered through the approval flow.
  if (input.status === "pending_approval" || input.status === "safety_blocked") {
    return ineligible(
      "resolve_approval_block",
      "Queue item is blocked on content approval authority, not a terminal failure; resolve it through the approval flow."
    );
  }

  // 4. Only a durable terminal failure is a requeue candidate.
  if (input.status !== "failed") {
    return ineligible(
      null,
      `Queue item status "${input.status}" is not a terminal failed state.`
    );
  }
  if (!input.hasTerminalFailureRecord) {
    return ineligible(
      null,
      "No durable terminal-failure record anchors a replay for this queue item."
    );
  }

  // 5. Class-specific authority that must be revalidated before requeue.
  switch (input.recoveryClass) {
    case "auth":
      if (input.integrationConnected !== true) {
        return ineligible(
          "reconnect_then_terminal_replay",
          "The platform integration must be reconnected before a requeue is safe."
        );
      }
      return eligible("auth");
    case "precondition":
      if (input.authorityRevalidated !== true) {
        return ineligible(
          null,
          "Publication authority must be revalidated before a requeue is safe."
        );
      }
      return eligible("precondition");
    case "billing":
      if (input.billingEvidence !== "exact_single_deduction") {
        return ineligible(
          null,
          input.billingEvidence === "ambiguous"
            ? "Billing evidence for this queue item is ambiguous; replay would risk an uncharged or double charge."
            : "No prior publishing deduction evidence exists for this queue item; replay would risk an uncharged or double charge."
        );
      }
      return eligible("billing");
    default:
      return eligible(input.recoveryClass);
  }
}

// ─── Normalized recovery event (audit / escalation wiring data) ───

/**
 * Normalized recovery event: everything a later audit-record or alert slice
 * needs to persist/notify WITHOUT re-classifying the failure. Carries the
 * escalation channel mapping for outcomes that must alert (mirroring the
 * existing warning/publishing terminal alert); the builder never calls it.
 */
export interface PublicationRecoveryEvent {
  readonly eventType: "publication_recovery_decision";
  /** ISO decision time (the explicit `now`). */
  readonly occurredAt: string;
  readonly queueItemId: number | null;
  readonly platform: string | null;
  readonly failureStage: PublicationFailureStage;
  readonly recoveryClass: PublicationRecoveryClass;
  readonly action: PublicationRecoveryAction;
  readonly retryable: boolean;
  readonly callProviderAgain: boolean;
  readonly retryCount: number;
  readonly nextRetryCount: number;
  readonly maxRetries: number;
  readonly delayMs: number | null;
  /** ISO next-attempt time; null when no retry is scheduled. */
  readonly nextRetryAt: string | null;
  readonly terminal: boolean;
  readonly terminalStatus: PublicationRecoveryTerminalStatus | null;
  readonly escalationRequired: boolean;
  /** Alert channel mapping when escalation is required; null otherwise. */
  readonly escalationChannel: { readonly severity: "warning"; readonly category: "publishing" } | null;
  readonly safeReason: string;
  readonly providerErrorCode: string | null;
  /** Pure policy: execution authority is always false here. */
  readonly mutationAuthorized: false;
}

/**
 * Build the normalized recovery event for audit/alert wiring. Pure and
 * deterministic: all timestamps come from the decision's explicit clock.
 */
export function buildPublicationRecoveryEvent(input: {
  readonly decision: PublicationRecoveryDecision;
  readonly queueItemId?: number | null;
  readonly platform?: string | null;
  readonly providerErrorCode?: string | null;
}): PublicationRecoveryEvent {
  const decision = input.decision;
  if (!decision || typeof decision !== "object") {
    throw new TypeError("Invalid recovery event input: expected a decision");
  }
  return {
    eventType: "publication_recovery_decision",
    occurredAt: decision.decidedAt.toISOString(),
    queueItemId: input.queueItemId ?? null,
    platform: input.platform ?? null,
    failureStage: decision.failureStage,
    recoveryClass: decision.recoveryClass,
    action: decision.action,
    retryable: decision.retryable,
    callProviderAgain: decision.callProviderAgain,
    retryCount: decision.retryCount,
    nextRetryCount: decision.nextRetryCount,
    maxRetries: decision.maxRetries,
    delayMs: decision.delayMs,
    nextRetryAt: decision.nextRetryAt ? decision.nextRetryAt.toISOString() : null,
    terminal: decision.terminal,
    terminalStatus: decision.terminalStatus,
    escalationRequired: decision.escalationRequired,
    escalationChannel: decision.escalationRequired
      ? { severity: "warning", category: "publishing" }
      : null,
    safeReason: decision.safeReason,
    providerErrorCode: input.providerErrorCode ?? null,
    mutationAuthorized: false,
  };
}
