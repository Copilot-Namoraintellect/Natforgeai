/**
 * Canonical R5 Operations Projection (WBS-R5-F1).
 *
 * One authoritative, deterministic, READ-ONLY operational read model that
 * answers, for a business: "what is NatForgeAI's R5 marketing-operations
 * stack doing right now, and what — if anything — is blocking it?"
 *
 * Design invariants (mirrors the R4-F3 lifecycle projection discipline):
 * - Derived exclusively from durable authorities owned by the capability
 *   streams (R5-A listening, R4 queue/recovery/billing/approval/approval
 *   stores). It introduces NO second lifecycle state machine and owns NO
 *   mutable operational state.
 * - Read-only: never writes anything, never transitions anything, never
 *   "heals" what it observes.
 * - Honest: a stream whose migration has not run yet (A/B/D tables absent)
 *   or an authority that cannot be read surfaces as unavailable — never
 *   guessed, never silently substituted.
 * - Deterministic: explicit-clock pure derivation over normalized evidence;
 *   blocker classification is a pure function (zero I/O).
 * - Tenant-safe: the projection lib is actor-agnostic and never receives
 *   client ownership. Callers decide visibility (admin operator surface may
 *   read any business; nothing user-facing is added here).
 * - Secret-free: only explicit allow-listed columns are selected; provider
 *   tokens, raw payloads and credential material are never read.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  approvalRequests,
  businesses,
  campaigns,
  creativeGenerationClaims,
  creditReservations,
  creditWallets,
  publishingQueue,
  queueReplayRequests,
  queueTerminalFailures,
  socialIntegrations,
  subscriptions,
  subscriptionTiers,
  userUsage,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  R5_BLOCKER_CLASS_POLICY,
  R5_BLOCKER_HEALTH_IMPACT_PRECEDENCE,
  mapFailureCodeToBlockerClass,
  type R5BlockerClass,
  type R5BlockerHealthImpact,
  type R5RecoveryClass,
} from "./r5-blocker-taxonomy";
import {
  readR5InterpretationEvidence,
  readR5ListeningEvidence,
  readR5OpportunityEvidence,
  type R5InterpretationEvidence,
  type R5ListeningEvidence,
  type R5OpportunityEvidence,
} from "./r5-stream-evidence";

// ─── Public vocabulary ───

export const R5_OPERATIONAL_HEALTH = [
  "HEALTHY",
  "DEGRADED",
  "BLOCKED_OPERATOR",
  "BLOCKED_CONFIGURATION",
  "AUTO_RECOVERING",
  "UNSUPPORTED",
  "FAIL_CLOSED",
] as const;

export type R5OperationalHealth = (typeof R5_OPERATIONAL_HEALTH)[number];

/**
 * Closed vocabulary of operator-safe next actions. Mirrors exactly what the
 * operator control plane can surface; a blocker whose only recovery is
 * AUTO_RECOVER maps to "none" (the system is already handling it).
 */
export const R5_SAFE_NEXT_ACTIONS = [
  "none",
  "inspect_pending_approval",
  "request_terminal_replay",
  "await_terminal_replay",
  "resume_budget_continuation",
  "reconnect_provider_integration",
  "refresh_provider_scope",
  "review_model_configuration",
  "requeue_stale_operation",
  "sweep_stale_creative_claims",
  "review_fail_closed_evidence",
  "review_inconsistent_authority",
  "await_capability_integration",
] as const;

export type R5SafeNextAction = (typeof R5_SAFE_NEXT_ACTIONS)[number];

export const R5_STALENESS_THRESHOLDS = {
  /** A listening binding with no success within this window is stale. */
  listeningSuccessMs: 24 * 60 * 60 * 1000,
  /** A business with no successful activity within this window is stale. */
  businessActivityMs: 7 * 24 * 60 * 60 * 1000,
  /** Failures newer than this (with no newer success) leave DEGRADED traces. */
  recentFailureMs: 24 * 60 * 60 * 1000,
} as const;

// ─── Evidence (normalized, pure) ───

export interface R5PendingApprovalEvidence {
  id: number;
  approvalType: string;
  riskLevel: string;
  createdAt: Date | null;
}

export interface R5RetryingItemEvidence {
  id: number;
  nextRetryAt: Date | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
}

export interface R5OpenTerminalFailureEvidence {
  id: number;
  queueName: string;
  terminalReason: string;
  errorCode: string | null;
  failedAt: Date | null;
}

export interface R5OperationsEvidence {
  businessFound: boolean;
  business: { id: number; userId: number; name: string } | null;
  /** Authority areas that could not be read at all. */
  areasUnavailable: string[];
  listening: R5ListeningEvidence;
  /** Interpretation (R5-B) 24h activity, read-only via the guarded bridge. */
  interpretation: R5InterpretationEvidence;
  /** Opportunity detection (R5-D) candidate counts, read-only via the guarded bridge. */
  opportunity: R5OpportunityEvidence;
  policy: { pendingApprovals: R5PendingApprovalEvidence[] };
  engagement: {
    campaignIds: number[];
    workflowStates: Record<string, number>;
    costPausedCount: number;
    queueCounts: Record<string, number>;
    safetyBlockedCount: number;
    retryingItems: R5RetryingItemEvidence[];
    failedItems: { id: number; lastError: string | null }[];
    staleClaimCount: number;
    runningClaimCount: number;
  };
  queueRecovery: {
    openTerminalFailures: R5OpenTerminalFailureEvidence[];
    openReplayRequests: number;
  };
  billingQuota: {
    walletRowExists: boolean;
    walletExhausted: boolean;
    openReservationCount: number;
    usage: {
      campaignsCreated: number;
      maxCampaigns: number | null;
      successfulResults: number;
      maxResults: number | null;
    } | null;
  };
  providers: {
    integrations: { id: number; platform: string; status: string }[];
    expiredCount: number;
    disconnectedCount: number;
  };
  activity: {
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureClass: R5RecoveryClass | null;
    lastFailureCode: string | null;
    lastFailureArea: string | null;
  };
}

export interface R5DerivedBlocker {
  blockerClass: R5BlockerClass;
  recoveryClass: R5RecoveryClass;
  healthImpact: R5BlockerHealthImpact;
  area: string;
  /** Bounded, human-readable evidence pointer. Never secrets/payloads. */
  evidence: string;
  since: Date | null;
  safeNextAction: R5SafeNextAction;
}

// ─── Pure derivation ───

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

const SAFE_ACTION_BY_BLOCKER: Record<R5BlockerClass, R5SafeNextAction> = {
  PROVIDER_AUTH_EXPIRED: "reconnect_provider_integration",
  PROVIDER_SCOPE_MISSING: "refresh_provider_scope",
  RATE_LIMITED: "none",
  QUEUE_UNAVAILABLE: "none",
  REDIS_UNAVAILABLE: "none",
  MODEL_TIMEOUT: "none",
  MODEL_CONFIGURATION_MISSING: "review_model_configuration",
  POLICY_REQUIRES_APPROVAL: "inspect_pending_approval",
  BUDGET_EXHAUSTED: "resume_budget_continuation",
  QUOTA_EXHAUSTED: "none",
  STALE_OPERATION: "requeue_stale_operation",
  UNSUPPORTED_PROVIDER_CAPABILITY: "reconnect_provider_integration",
  OWNERSHIP_MISMATCH: "review_fail_closed_evidence",
  MALFORMED_EXTERNAL_PAYLOAD: "review_fail_closed_evidence",
  SECURITY_REJECTION: "review_fail_closed_evidence",
};

/**
 * Derive the open blocker set for a business from normalized evidence.
 * Pure: deterministic, explicit-clock-free (uses only evidence timestamps),
 * zero I/O. Security/ownership classes are only ever produced from explicit
 * evidence, never inferred from absence of data.
 */
export function deriveR5Blockers(
  evidence: R5OperationsEvidence
): R5DerivedBlocker[] {
  const blockers: R5DerivedBlocker[] = [];
  const push = (
    blockerClass: R5BlockerClass,
    area: string,
    evidenceText: string,
    since: Date | null
  ) => {
    const policy = R5_BLOCKER_CLASS_POLICY[blockerClass];
    blockers.push({
      blockerClass,
      recoveryClass: policy.recoveryClass,
      healthImpact: policy.healthImpact,
      area,
      evidence: evidenceText.slice(0, 300),
      since,
      safeNextAction: SAFE_ACTION_BY_BLOCKER[blockerClass],
    });
  };

  // Listening (R5-A authority).
  if (evidence.listening.available) {
    for (const binding of evidence.listening.bindings) {
      if (binding.mechanism === "unsupported" || binding.status === "unsupported") {
        push(
          "UNSUPPORTED_PROVIDER_CAPABILITY",
          "listening",
          `binding ${binding.integrationId} (${binding.platform}) has no supported listening mechanism`,
          binding.lastFailureAt
        );
        continue;
      }
      const integration = evidence.providers.integrations.find(
        (i) => i.id === binding.integrationId
      );
      if (integration && integration.status === "expired") {
        push(
          "PROVIDER_AUTH_EXPIRED",
          "listening",
          `integration ${binding.integrationId} (${binding.platform}) credential expired`,
          binding.lastFailureAt
        );
        continue;
      }
      if (integration && integration.status === "disconnected") {
        push(
          "PROVIDER_AUTH_EXPIRED",
          "listening",
          `integration ${binding.integrationId} (${binding.platform}) is disconnected`,
          binding.lastFailureAt
        );
        continue;
      }
      if (binding.status === "stale") {
        push(
          "STALE_OPERATION",
          "listening",
          `binding ${binding.integrationId} (${binding.platform}) has no fresh ingestion success`,
          binding.lastSuccessAt
        );
        continue;
      }
      if (binding.status === "blocked") {        const mapped = mapFailureCodeToBlockerClass(binding.lastFailureCode);
        if (mapped && mapped !== "RATE_LIMITED") {
          // Trust the A-owned failure class for non-transient codes.
          if (
            binding.lastFailureClass === "FAIL_CLOSED" &&
            (mapped === "OWNERSHIP_MISMATCH" ||
              mapped === "MALFORMED_EXTERNAL_PAYLOAD" ||
              mapped === "SECURITY_REJECTION")
          ) {
            push(mapped, "listening", `binding ${binding.integrationId}: ${binding.lastFailureCode}`, binding.lastFailureAt);
            continue;
          }
          if (mapped === "PROVIDER_SCOPE_MISSING") {
            push("PROVIDER_SCOPE_MISSING", "listening", `binding ${binding.integrationId}: ${binding.lastFailureCode}`, binding.lastFailureAt);
            continue;
          }
          if (mapped === "PROVIDER_AUTH_EXPIRED") {
            push("PROVIDER_AUTH_EXPIRED", "listening", `binding ${binding.integrationId}: ${binding.lastFailureCode}`, binding.lastFailureAt);
            continue;
          }
        }
        // Blocked without a decisive code: operator must inspect.
        push(
          "STALE_OPERATION",
          "listening",
          `binding ${binding.integrationId} is blocked (${binding.lastFailureCode ?? "no failure code"})`,
          binding.lastFailureAt
        );
        continue;
      }
      if (binding.status === "active" && binding.lastFailureClass === "OPERATOR_ACTION") {
        push(
          "STALE_OPERATION",
          "listening",
          `binding ${binding.integrationId} reports operator-action failure (${binding.lastFailureCode ?? "unspecified"})`,
          binding.lastFailureAt
        );
        continue;
      }
      if (binding.status === "active" && binding.lastFailureClass === "AUTO_RECOVER") {
        const mapped = mapFailureCodeToBlockerClass(binding.lastFailureCode) ?? "RATE_LIMITED";
        if (mapped === "RATE_LIMITED" || mapped === "MODEL_TIMEOUT" || mapped === "QUEUE_UNAVAILABLE" || mapped === "REDIS_UNAVAILABLE") {
          push(mapped, "listening", `binding ${binding.integrationId}: ${binding.lastFailureCode}`, binding.lastFailureAt);
        }
      }
    }
  }

  // Policy / approvals (R4 authority reused as E-facing decision backlog).
  if (evidence.policy.pendingApprovals.length > 0) {
    const oldest = evidence.policy.pendingApprovals.reduce((a, b) =>
      (a.createdAt?.getTime() ?? 0) <= (b.createdAt?.getTime() ?? 0) ? a : b
    );
    push(
      "POLICY_REQUIRES_APPROVAL",
      "policy",
      `${evidence.policy.pendingApprovals.length} approval(s) pending (oldest #${oldest.id} ${oldest.approvalType})`,
      oldest.createdAt
    );
  }

  // Engagement work (R4 publishing/claims authorities).
  if (evidence.engagement.safetyBlockedCount > 0) {
    push(
      "POLICY_REQUIRES_APPROVAL",
      "engagement",
      `${evidence.engagement.safetyBlockedCount} publishing item(s) held by safety review`,
      null
    );
  }
  if (evidence.engagement.staleClaimCount > 0) {
    push(
      "STALE_OPERATION",
      "engagement",
      `${evidence.engagement.staleClaimCount} creative generation claim(s) stale`,
      null
    );
  }
  for (const item of evidence.engagement.failedItems) {
    const mapped = mapFailureCodeToBlockerClass(item.lastError);
    if (mapped) {
      push(mapped, "engagement", `publishing item ${item.id}: ${mapped}`, null);
    }
  }

  // Queue recovery (terminal failures are operator-decision replay candidates).
  if (evidence.queueRecovery.openTerminalFailures.length > 0) {
    const first = evidence.queueRecovery.openTerminalFailures[0];
    push(
      "STALE_OPERATION",
      "queue_recovery",
      `${evidence.queueRecovery.openTerminalFailures.length} terminal failure(s) open (latest #${first.id} ${first.queueName}/${first.terminalReason})`,
      first.failedAt
    );
  }

  // Billing / quota.
  if (evidence.billingQuota.walletExhausted) {
    push("BUDGET_EXHAUSTED", "billing_quota", "credit wallet balance is zero", null);
  }
  if (evidence.billingQuota.usage) {
    const { campaignsCreated, maxCampaigns, successfulResults, maxResults } =
      evidence.billingQuota.usage;
    if (maxCampaigns !== null && campaignsCreated >= maxCampaigns) {
      push(
        "QUOTA_EXHAUSTED",
        "billing_quota",
        `campaign quota reached (${campaignsCreated}/${maxCampaigns})`,
        null
      );
    }
    if (maxResults !== null && successfulResults >= maxResults) {
      push(
        "QUOTA_EXHAUSTED",
        "billing_quota",
        `successful-results quota reached (${successfulResults}/${maxResults})`,
        null
      );
    }
  }

  return blockers;
}

export interface R5OperationalStateDerivation {
  health: R5OperationalHealth;
  blockers: R5DerivedBlocker[];
  safeNextAction: R5SafeNextAction;
  isStale: boolean;
  staleness: { lastActivityAgeMs: number | null; thresholdMs: number };
  capabilitiesPresent: number;
  notes: string[];
}

/**
 * Classify operational health from evidence + open blockers. Priority:
 * fail_closed > operator > configuration > auto > none; UNSUPPORTED only when
 * no R5 capability evidence exists at all (listening bindings, recent
 * interpretation activity, open/handed-off opportunity candidates, policy
 * backlog, engagement campaigns or provider integrations); DEGRADED when a
 * recent failure left traces but nothing is currently blocked.
 */
export function deriveR5OperationalState(
  evidence: R5OperationsEvidence,
  blockers: R5DerivedBlocker[],
  now: Date
): R5OperationalStateDerivation {
  const notes: string[] = [];
  const capabilityAreas = [
    evidence.listening.available && evidence.listening.bindings.length > 0,
    evidence.interpretation.available && evidence.interpretation.interpretationsLast24h > 0,
    evidence.opportunity.available &&
      (evidence.opportunity.openCandidates > 0 || evidence.opportunity.handedOff > 0),
    evidence.policy.pendingApprovals.length > 0,
    evidence.engagement.campaignIds.length > 0,
    evidence.providers.integrations.length > 0,
  ];
  const capabilitiesPresent = capabilityAreas.filter(Boolean).length;

  if (capabilitiesPresent === 0) {
    return {
      health: "UNSUPPORTED",
      blockers,
      safeNextAction: "await_capability_integration",
      isStale: false,
      staleness: { lastActivityAgeMs: null, thresholdMs: R5_STALENESS_THRESHOLDS.businessActivityMs },
      capabilitiesPresent,
      notes: ["no R5 capability evidence for this business"],
    };
  }

  let worst: R5BlockerHealthImpact = "none";
  for (const blocker of blockers) {
    if (
      R5_BLOCKER_HEALTH_IMPACT_PRECEDENCE[blocker.healthImpact] >
      R5_BLOCKER_HEALTH_IMPACT_PRECEDENCE[worst]
    ) {
      worst = blocker.healthImpact;
    }
  }

  let health: R5OperationalHealth;
  switch (worst) {
    case "fail_closed":
      health = "FAIL_CLOSED";
      break;
    case "operator":
      // Any operator/governance blocker (approval waits included) means a
      // human must act before work continues.
      health = "BLOCKED_OPERATOR";
      break;
    case "configuration":
      health = "BLOCKED_CONFIGURATION";
      break;
    case "auto": {
      const retryScheduled = evidence.engagement.retryingItems.some(
        (i) => i.nextRetryAt && i.nextRetryAt.getTime() > now.getTime()
      );
      health = "AUTO_RECOVERING";
      if (!retryScheduled) {
        notes.push(
          "auto-recoverable failures present; no future retry currently scheduled"
        );
      }
      break;
    }
    default: {
      const recentFailure =
        evidence.activity.lastFailureAt &&
        now.getTime() - evidence.activity.lastFailureAt.getTime() <=
          R5_STALENESS_THRESHOLDS.recentFailureMs;
      health = recentFailure ? "DEGRADED" : "HEALTHY";
      if (recentFailure) notes.push("recent failure trace without an open blocker");
    }
  }

  const priority = ["fail_closed", "operator", "configuration", "auto", "none"] as const;
  let safeNextAction: R5SafeNextAction = "none";
  for (const impact of priority) {
    const match = blockers.find((b) => b.healthImpact === impact && b.safeNextAction !== "none");
    if (match) {
      safeNextAction = match.safeNextAction;
      break;
    }
  }

  const lastActivity = evidence.activity.lastSuccessAt;
  const lastActivityAgeMs = lastActivity ? now.getTime() - lastActivity.getTime() : null;
  const isStale =
    lastActivityAgeMs !== null
      ? lastActivityAgeMs > R5_STALENESS_THRESHOLDS.businessActivityMs
      : false;

  return {
    health,
    blockers,
    safeNextAction,
    isStale,
    staleness: { lastActivityAgeMs, thresholdMs: R5_STALENESS_THRESHOLDS.businessActivityMs },
    capabilitiesPresent,
    notes,
  };
}

// ─── Output projection ───

export interface R5BusinessOperationsProjection {
  business: { id: number; userId: number; name: string } | null;
  generatedAt: string;
  health: R5OperationalHealth;
  blockers: R5DerivedBlocker[];
  safeNextAction: R5SafeNextAction;
  staleness: { isStale: boolean; lastActivityAgeMs: number | null; thresholdMs: number };
  listening: R5ListeningEvidence;
  interpretation: R5InterpretationEvidence;
  opportunity: R5OpportunityEvidence;
  policy: { pendingCount: number; pendingApprovals: R5PendingApprovalEvidence[] };
  engagement: R5OperationsEvidence["engagement"];
  queueRecovery: {
    openTerminalFailureCount: number;
    openReplayRequestCount: number;
  };
  billingQuota: {
    walletExhausted: boolean;
    openReservationCount: number;
    usage: R5OperationsEvidence["billingQuota"]["usage"];
  };
  providers: R5OperationsEvidence["providers"];
  activity: R5OperationsEvidence["activity"];
  capabilitiesPresent: number;
  notes: string[];
}

// ─── Evidence collection (DB) ───

type Db = ReturnType<typeof getDb>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Collect normalized evidence for one business from durable authorities.
 * Read-only. Never selects token/credential/payload columns.
 */
export async function collectR5BusinessEvidence(
  db: Db,
  businessId: number,
  now: Date
): Promise<R5OperationsEvidence> {
  const areasUnavailable: string[] = [];

  const businessRows = await db
    .select({
      id: businesses.id,
      userId: businesses.userId,
      name: businesses.name,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const business = businessRows[0] ?? null;
  if (!business) {
    return {
      businessFound: false,
      business: null,
      areasUnavailable,
      listening: { available: false, reason: "business_not_found", bindings: [] },
      interpretation: {
        available: false,
        reason: "business_not_found",
        interpretationsLast24h: 0,
      },
      opportunity: {
        available: false,
        reason: "business_not_found",
        openCandidates: 0,
        handedOff: 0,
        candidatesLast24h: 0,
      },
      policy: { pendingApprovals: [] },
      engagement: {
        campaignIds: [],
        workflowStates: {},
        costPausedCount: 0,
        queueCounts: {},
        safetyBlockedCount: 0,
        retryingItems: [],
        failedItems: [],
        staleClaimCount: 0,
        runningClaimCount: 0,
      },
      queueRecovery: { openTerminalFailures: [], openReplayRequests: 0 },
      billingQuota: {
        walletRowExists: false,
        walletExhausted: false,
        openReservationCount: 0,
        usage: null,
      },
      providers: { integrations: [], expiredCount: 0, disconnectedCount: 0 },
      activity: {
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureClass: null,
        lastFailureCode: null,
        lastFailureArea: null,
      },
    };
  }

  const userId = business.userId;

  const [listening, interpretation, opportunity, campaignRows, integrationRows, approvalRows, walletRows, usageRows, subscriptionRows] =
    await Promise.all([
      readR5ListeningEvidence(db, businessId, userId, now).catch((err) => {
        areasUnavailable.push("listening");
        return {
          available: false as const,
          reason: `listening_authority_unavailable:${String(err).slice(0, 80)}`,
          bindings: [],
        };
      }),
      readR5InterpretationEvidence(db, businessId, userId, now).catch((err) => {
        areasUnavailable.push("interpretation");
        return {
          available: false as const,
          reason: `interpretation_authority_unavailable:${String(err).slice(0, 80)}`,
          interpretationsLast24h: 0,
        };
      }),
      readR5OpportunityEvidence(db, businessId, userId, now).catch((err) => {
        areasUnavailable.push("opportunity");
        return {
          available: false as const,
          reason: `opportunity_authority_unavailable:${String(err).slice(0, 80)}`,
          openCandidates: 0,
          handedOff: 0,
          candidatesLast24h: 0,
        };
      }),
      db
        .select({
          id: campaigns.id,
          workflowState: campaigns.workflowState,
          workflowContext: campaigns.workflowContext,
        })
        .from(campaigns)
        .where(eq(campaigns.businessId, businessId)),
      db
        .select({ id: socialIntegrations.id, platform: socialIntegrations.platform, status: socialIntegrations.status })
        .from(socialIntegrations)
        .where(eq(socialIntegrations.businessId, businessId)),
      db
        .select({
          id: approvalRequests.id,
          approvalType: approvalRequests.approvalType,
          riskLevel: approvalRequests.riskLevel,
          createdAt: approvalRequests.createdAt,
          campaignId: approvalRequests.campaignId,
          userId: approvalRequests.userId,
        })
        .from(approvalRequests)
        .where(
          and(eq(approvalRequests.status, "pending"), eq(approvalRequests.userId, userId))
        ),
      db
        .select({ balance: creditWallets.balance })
        .from(creditWallets)
        .where(eq(creditWallets.userId, userId))
        .limit(1),
      db
        .select({
          campaignsCreated: userUsage.campaignsCreated,
          successfulResults: userUsage.successfulResults,
        })
        .from(userUsage)
        .where(eq(userUsage.userId, userId))
        .limit(1),
      db
        .select({
          tierId: subscriptions.tierId,
          status: subscriptions.status,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),
    ]);

  const campaignIds = campaignRows.map((c) => c.id);
  const costPausedCount = campaignRows.filter((c) => {
    if (!isPlainObject(c.workflowContext)) return false;
    return c.workflowContext.costPause != null;
  }).length;

  const emptyEngagement = {
    campaignIds,
    workflowStates: countBy(campaignRows, (c) => c.workflowState),
    costPausedCount,
    queueCounts: {} as Record<string, number>,
    safetyBlockedCount: 0,
    retryingItems: [] as R5RetryingItemEvidence[],
    failedItems: [] as { id: number; lastError: string | null }[],
    staleClaimCount: 0,
    runningClaimCount: 0,
  };

  let engagement = { ...emptyEngagement };
  let queueRecovery = {
    openTerminalFailures: [] as R5OpenTerminalFailureEvidence[],
    openReplayRequests: 0,
  };
  let lastSuccessAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let lastFailureClass: R5RecoveryClass | null = null;
  let lastFailureCode: string | null = null;
  let lastFailureArea: string | null = null;
  let openReservationCount = 0;

  if (campaignIds.length > 0) {
    const [queueRows, terminalRows, businessFailureIds, claimRows] = await Promise.all([
        db
          .select({
            id: publishingQueue.id,
            status: publishingQueue.status,
            nextRetryAt: publishingQueue.nextRetryAt,
            retryCount: publishingQueue.retryCount,
            maxRetries: publishingQueue.maxRetries,
            lastError: publishingQueue.lastError,
            publishedAt: publishingQueue.publishedAt,
            campaignId: publishingQueue.campaignId,
          })
          .from(publishingQueue)
          .where(inArray(publishingQueue.campaignId, campaignIds)),
        db
          .select({
            id: queueTerminalFailures.id,
            queueName: queueTerminalFailures.queueName,
            terminalReason: queueTerminalFailures.terminalReason,
            errorCode: queueTerminalFailures.errorCode,
            failedAt: queueTerminalFailures.failedAt,
            campaignId: queueTerminalFailures.campaignId,
          })
          .from(queueTerminalFailures)
          .where(
            and(
              eq(queueTerminalFailures.status, "open"),
              inArray(queueTerminalFailures.campaignId, campaignIds)
            )
          ),
        db
          .select({ id: queueTerminalFailures.id })
          .from(queueTerminalFailures)
          .where(inArray(queueTerminalFailures.campaignId, campaignIds)),
        db
          .select({
            id: creativeGenerationClaims.id,
            leaseExpiresAt: creativeGenerationClaims.leaseExpiresAt,
          })
          .from(creativeGenerationClaims)
          .where(
            and(
              eq(creativeGenerationClaims.status, "running"),
              inArray(creativeGenerationClaims.campaignId, campaignIds)
            )
          ),
      ]);

    const replayRows = businessFailureIds.length
      ? await db
          .select({ id: queueReplayRequests.id })
          .from(queueReplayRequests)
          .where(
            and(
              inArray(queueReplayRequests.status, ["requested", "claimed", "enqueued"]),
              inArray(
                queueReplayRequests.terminalFailureId,
                businessFailureIds.map((r) => r.id)
              )
            )
          )
      : [];

    const staleClaimCount = claimRows.filter(
      (c) => c.leaseExpiresAt && c.leaseExpiresAt.getTime() < now.getTime()
    ).length;

    engagement = {
      ...emptyEngagement,
      queueCounts: countBy(queueRows, (q) => q.status),
      safetyBlockedCount: queueRows.filter((q) => q.status === "safety_blocked").length,
      retryingItems: queueRows
        .filter((q) => q.status === "retrying")
        .map((q) => ({
          id: q.id,
          nextRetryAt: q.nextRetryAt,
          retryCount: q.retryCount,
          maxRetries: q.maxRetries,
          lastError: q.lastError ? q.lastError.slice(0, 200) : null,
        })),
      failedItems: queueRows
        .filter((q) => q.status === "failed")
        .map((q) => ({ id: q.id, lastError: q.lastError ? q.lastError.slice(0, 200) : null })),
      staleClaimCount,
      runningClaimCount: claimRows.length,
    };

    queueRecovery = {
      openTerminalFailures: terminalRows,
      openReplayRequests: replayRows.length,
    };

    // Fold queue-derived activity into the business activity picture:
    // successful publications count as successful downstream activity.
    for (const row of queueRows) {
      if (row.status === "published" && row.publishedAt) {
        lastSuccessAt = maxDate(lastSuccessAt, row.publishedAt);
      }
    }
    for (const failure of terminalRows) {
      if (failure.failedAt) {
        const isNewer =
          !lastFailureAt || failure.failedAt.getTime() > lastFailureAt.getTime();
        if (isNewer) {
          lastFailureAt = failure.failedAt;
          lastFailureClass = "OPERATOR_ACTION";
          lastFailureCode = failure.errorCode;
          lastFailureArea = "queue_recovery";
        }
      }
    }
  }

  // Listening activity fold-in.
  for (const binding of listening.bindings) {
    lastSuccessAt = maxDate(lastSuccessAt, binding.lastSuccessAt);
    if (binding.lastFailureAt) {
      const isNewer = !lastFailureAt || binding.lastFailureAt.getTime() > lastFailureAt.getTime();
      if (isNewer) {
        lastFailureAt = binding.lastFailureAt;
        lastFailureClass = binding.lastFailureClass;
        lastFailureCode = binding.lastFailureCode;
        lastFailureArea = "listening";
      }
    }
  }

  const openReservationRows = await db
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(and(eq(creditReservations.state, "reserved"), eq(creditReservations.userId, userId)));
  openReservationCount = openReservationRows.length;

  const activeSubscription = subscriptionRows.find((s) => s.status === "active");
  let usage: R5OperationsEvidence["billingQuota"]["usage"] = null;
  if (usageRows[0]) {
    let maxCampaigns: number | null = null;
    let maxResults: number | null = null;
    if (activeSubscription) {
      const tierRows = await db
        .select({ maxCampaigns: subscriptionTiers.maxCampaigns, maxResults: subscriptionTiers.maxResults })
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, activeSubscription.tierId))
        .limit(1);
      maxCampaigns = tierRows[0]?.maxCampaigns ?? null;
      maxResults = tierRows[0]?.maxResults ?? null;
    }
    usage = {
      campaignsCreated: usageRows[0].campaignsCreated ?? 0,
      maxCampaigns,
      successfulResults: usageRows[0].successfulResults ?? 0,
      maxResults,
    };
  }

  const pendingApprovals = approvalRows
    .filter((a) => a.campaignId === null || campaignIds.includes(a.campaignId))
    .map((a) => ({
      id: a.id,
      approvalType: a.approvalType,
      riskLevel: a.riskLevel,
      createdAt: a.createdAt,
    }));

  return {
    businessFound: true,
    business,
    areasUnavailable,
    listening,
    interpretation,
    opportunity,
    policy: { pendingApprovals },
    engagement,
    queueRecovery,
    billingQuota: {
      walletRowExists: walletRows.length > 0,
      walletExhausted: walletRows.length > 0 ? walletRows[0].balance <= 0 : false,
      openReservationCount,
      usage,
    },
    providers: {
      integrations: integrationRows,
      expiredCount: integrationRows.filter((i) => i.status === "expired").length,
      disconnectedCount: integrationRows.filter((i) => i.status === "disconnected").length,
    },
    activity: {
      lastSuccessAt,
      lastFailureAt,
      lastFailureClass,
      lastFailureCode,
      lastFailureArea,
    },
  };
}

/**
 * Project the canonical R5 operational state for one business.
 * Read-only; never mutates business state.
 */
export async function projectR5BusinessOperations(input: {
  businessId: number;
  now?: Date;
  executor?: Db;
}): Promise<R5BusinessOperationsProjection> {
  const now = input.now ?? new Date();
  const db = input.executor ?? getDb();
  const evidence = await collectR5BusinessEvidence(db, input.businessId, now);
  const blockers = deriveR5Blockers(evidence);
  const derivation = deriveR5OperationalState(evidence, blockers, now);

  return {
    business: evidence.business,
    generatedAt: now.toISOString(),
    health: derivation.health,
    blockers: derivation.blockers,
    safeNextAction: derivation.safeNextAction,
    staleness: {
      isStale: derivation.isStale,
      lastActivityAgeMs: derivation.staleness.lastActivityAgeMs,
      thresholdMs: derivation.staleness.thresholdMs,
    },
    listening: evidence.listening,
    interpretation: evidence.interpretation,
    opportunity: evidence.opportunity,
    policy: {
      pendingCount: evidence.policy.pendingApprovals.length,
      pendingApprovals: evidence.policy.pendingApprovals,
    },
    engagement: evidence.engagement,
    queueRecovery: {
      openTerminalFailureCount: evidence.queueRecovery.openTerminalFailures.length,
      openReplayRequestCount: evidence.queueRecovery.openReplayRequests,
    },
    billingQuota: {
      walletExhausted: evidence.billingQuota.walletExhausted,
      openReservationCount: evidence.billingQuota.openReservationCount,
      usage: evidence.billingQuota.usage,
    },
    providers: evidence.providers,
    activity: evidence.activity,
    capabilitiesPresent: derivation.capabilitiesPresent,
    notes: derivation.notes,
  };
}
