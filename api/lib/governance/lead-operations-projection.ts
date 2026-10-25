/**
 * R6-F lead-operations projection (F1).
 *
 * One read-only, lead-scoped operational read model for R6 lead autonomy.
 * Derives everything from durable authorities and owns NO mutable operational
 * state — there is no second lifecycle state machine. The CRM pipeline state
 * (`leads.status`) remains owned exclusively by the CRM router; this
 * projection only reads it.
 *
 * Layering (mirrors r5-operations-projection.ts):
 *   collectLeadOperationsEvidence  — all IO, read-only, column allow-lists
 *   deriveLeadBlockers             — pure, zero I/O
 *   deriveLeadOperationalState     — pure, explicit clock
 *   projectLeadOperations          — composition entry point
 *
 * Honesty invariants:
 * - Stream areas without landed authority (identity A, scoring B,
 *   qualification C, nurture/handoff D, conversion E) report
 *   `supported: false` / `status: "unavailable"` — never guessed.
 * - Security/ownership blockers come only from explicit fail-closed evidence,
 *   never from absence of data.
 * - The privacy area (F-owned) is authoritative: the durable
 *   `lead_privacy_states` row is the single source of privacy/suppression
 *   operational state.
 *
 * Secret/PII discipline: only allow-listed, non-PII columns are selected.
 * `leads.name/email/phone/company/jobTitle/notes/customFields` and
 * `lead_activities.description` are NEVER read here.
 */

import { desc, eq } from "drizzle-orm";
import { leadActivities, leads } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  LEAD_BLOCKER_CLASS_POLICY,
  type LeadBlockerClass,
  type LeadBlockerHealthImpact,
  type LeadRecoveryClass,
} from "./lead-blocker-taxonomy";
import {
  leadPrivacyGateFor,
  readLeadPrivacyEvidence,
  type LeadPrivacyEvidence,
} from "./lead-privacy-store";

type Db = ReturnType<typeof getDb>;

export const LEAD_OPERATIONAL_HEALTH = [
  "HEALTHY",
  "DEGRADED",
  "BLOCKED_OPERATOR",
  "BLOCKED_CONFIGURATION",
  "AUTO_RECOVERING",
  "UNSUPPORTED",
  "FAIL_CLOSED",
] as const;

export type LeadOperationalHealth = (typeof LEAD_OPERATIONAL_HEALTH)[number];

export const LEAD_SAFE_NEXT_ACTIONS = [
  "none",
  "review_identity_conflict",
  "await_identity_evidence",
  "recompute_stale_score",
  "review_scoring_configuration",
  "review_qualification_review_queue",
  "resolve_qualification_block",
  "resolve_nurture_policy_block",
  "retry_sales_handoff",
  "review_conversion_linkage",
  "review_privacy_suppression",
  "dispose_retention_expired",
  "review_fail_closed_evidence",
  "requeue_stale_operation",
  "integrate_lead_capability",
] as const;

export type LeadSafeNextAction = (typeof LEAD_SAFE_NEXT_ACTIONS)[number];

export const LEAD_STALENESS_THRESHOLDS = {
  /** No recorded lead activity within 30 days ⇒ `isStale` warning indicator. */
  leadActivityMs: 30 * 24 * 60 * 60 * 1000,
} as const;

// ─── Stream area DTOs ───

export interface LeadIdentityArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  identityStatus: string | null;
  identityConfidence: string | null;
}

export interface LeadScoringArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  /** R6-B authoritative score; null until the scoring stream integrates. */
  latestScore: number | null;
  scoreStatus: string | null;
  /** Legacy CRM score column, surfaced read-only for continuity. */
  legacyScore: number | null;
}

export interface LeadQualificationArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  qualificationStatus: string | null;
}

export interface LeadNurtureArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  /** Privacy-gate answer: false ⇒ nurture must not run, regardless of stream. */
  allowed: boolean;
  blockedByPrivacy: boolean;
}

export interface LeadSalesHandoffArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  handoffStatus: string | null;
}

export interface LeadConversionArea {
  supported: boolean;
  status: string;
  unavailableReason?: string;
  conversionStatus: string | null;
  conversionLinked: boolean | null;
}

// ─── Evidence ───

export interface LeadOperationsEvidence {
  leadFound: boolean;
  lead: {
    id: number;
    userId: number;
    businessId: number | null;
    campaignId: number | null;
    status: string;
    score: number;
    createdAt: Date | null;
    updatedAt: Date | null;
    lastContact: Date | null;
    nextFollowUp: Date | null;
  } | null;
  /** Area names whose authority read failed entirely. */
  areasUnavailable: string[];
  identity: LeadIdentityArea;
  scoring: LeadScoringArea;
  qualification: LeadQualificationArea;
  nurture: LeadNurtureArea;
  salesHandoff: LeadSalesHandoffArea;
  conversion: LeadConversionArea;
  privacy: LeadPrivacyEvidence;
  activity: {
    lastActivityAt: Date | null;
    lastSuccessfulTransitionAt: Date | null;
    statusChangeCount: number;
  };
}

export interface LeadDerivedBlocker {
  blockerClass: LeadBlockerClass;
  recoveryClass: LeadRecoveryClass;
  healthImpact: LeadBlockerHealthImpact;
  area: string;
  /** Bounded, human-readable evidence pointer. Never secrets/PII/payloads. */
  evidence: string;
  since: Date | null;
  safeNextAction: LeadSafeNextAction;
}

export interface LeadOperationalStateDerivation {
  health: LeadOperationalHealth;
  blockers: LeadDerivedBlocker[];
  safeNextAction: LeadSafeNextAction;
  operatorActionRequired: boolean;
  isStale: boolean;
  staleness: { lastActivityAgeMs: number | null; thresholdMs: number };
  capabilitiesPresent: number;
  notes: string[];
}

// ─── Constants for future-area honesty ───

const STREAM_NOT_INTEGRATED = "stream_not_integrated";

function unsupportedArea<T extends { supported: boolean; status: string; unavailableReason?: string }>(
  extra: Omit<T, "supported" | "status" | "unavailableReason">
): T {
  return {
    supported: false,
    status: "unavailable",
    unavailableReason: STREAM_NOT_INTEGRATED,
    ...extra,
  } as T;
}

// ─── Evidence collection (all IO) ───

export async function collectLeadOperationsEvidence(
  db: Db,
  leadId: number,
  _now: Date
): Promise<LeadOperationsEvidence> {
  const [leadRow] = await db
    .select({
      id: leads.id,
      userId: leads.userId,
      businessId: leads.businessId,
      campaignId: leads.campaignId,
      status: leads.status,
      score: leads.score,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
      lastContact: leads.lastContact,
      nextFollowUp: leads.nextFollowUp,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!leadRow) {
    return {
      leadFound: false,
      lead: null,
      areasUnavailable: [],
      identity: unsupportedArea<LeadIdentityArea>({ identityStatus: null, identityConfidence: null }),
      scoring: unsupportedArea<LeadScoringArea>({ latestScore: null, scoreStatus: null, legacyScore: null }),
      qualification: unsupportedArea<LeadQualificationArea>({ qualificationStatus: null }),
      nurture: unsupportedArea<LeadNurtureArea>({ allowed: false, blockedByPrivacy: false }),
      salesHandoff: unsupportedArea<LeadSalesHandoffArea>({ handoffStatus: null }),
      conversion: unsupportedArea<LeadConversionArea>({ conversionStatus: null, conversionLinked: null }),
      privacy: {
        available: false,
        reason: "lead_not_found",
        state: "ACTIVE",
        explicit: false,
        retentionDeadlineAt: null,
        previousState: null,
        source: null,
        actorUserId: null,
        updatedAt: null,
      },
      activity: { lastActivityAt: null, lastSuccessfulTransitionAt: null, statusChangeCount: 0 },
    };
  }

  const areasUnavailable: string[] = [];

  const [privacy, activityRows] = await Promise.all([
    readLeadPrivacyEvidence(db, leadId).catch((err: unknown) => {
      areasUnavailable.push("privacy");
      return {
        available: false as const,
        reason: `privacy_authority_unavailable:${String(err).slice(0, 80)}`,
        state: "ACTIVE" as const,
        explicit: false,
        retentionDeadlineAt: null,
        previousState: null,
        source: null,
        actorUserId: null,
        updatedAt: null,
      };
    }),
    db
      .select({ createdAt: leadActivities.createdAt, type: leadActivities.type })
      .from(leadActivities)
      .where(eq(leadActivities.leadId, leadId))
      .orderBy(desc(leadActivities.createdAt))
      .limit(500),
  ]);

  const gate = leadPrivacyGateFor(privacy.state);

  let lastActivityAt: Date | null = null;
  let lastSuccessfulTransitionAt: Date | null = null;
  let statusChangeCount = 0;
  for (const row of activityRows) {
    const at = row.createdAt ?? null;
    if (at && (!lastActivityAt || at > lastActivityAt)) lastActivityAt = at;
    if (row.type === "status_change") {
      statusChangeCount += 1;
      if (at && (!lastSuccessfulTransitionAt || at > lastSuccessfulTransitionAt)) {
        lastSuccessfulTransitionAt = at;
      }
    }
  }

  return {
    leadFound: true,
    lead: {
      id: leadRow.id,
      userId: leadRow.userId,
      businessId: leadRow.businessId ?? null,
      campaignId: leadRow.campaignId ?? null,
      status: leadRow.status,
      score: leadRow.score ?? 0,
      createdAt: leadRow.createdAt ?? null,
      updatedAt: leadRow.updatedAt ?? null,
      lastContact: leadRow.lastContact ?? null,
      nextFollowUp: leadRow.nextFollowUp ?? null,
    },
    areasUnavailable,
    identity: unsupportedArea<LeadIdentityArea>({ identityStatus: null, identityConfidence: null }),
    scoring: unsupportedArea<LeadScoringArea>({
      latestScore: null,
      scoreStatus: null,
      legacyScore: leadRow.score ?? 0,
    }),
    qualification: unsupportedArea<LeadQualificationArea>({ qualificationStatus: null }),
    nurture: unsupportedArea<LeadNurtureArea>({ allowed: gate.nurtureAllowed, blockedByPrivacy: !gate.nurtureAllowed }),
    salesHandoff: unsupportedArea<LeadSalesHandoffArea>({ handoffStatus: null }),
    conversion: unsupportedArea<LeadConversionArea>({ conversionStatus: null, conversionLinked: null }),
    privacy,
    activity: { lastActivityAt, lastSuccessfulTransitionAt, statusChangeCount },
  };
}

// ─── Pure derivation ───

const SAFE_ACTION_BY_BLOCKER: Record<LeadBlockerClass, LeadSafeNextAction> = {
  IDENTITY_CONFLICT: "review_identity_conflict",
  IDENTITY_INSUFFICIENT_EVIDENCE: "await_identity_evidence",
  SCORE_STALE: "recompute_stale_score",
  SCORE_UNAVAILABLE: "review_scoring_configuration",
  QUALIFICATION_REQUIRES_REVIEW: "review_qualification_review_queue",
  QUALIFICATION_BLOCKED: "resolve_qualification_block",
  NURTURE_POLICY_BLOCKED: "resolve_nurture_policy_block",
  SALES_HANDOFF_FAILED: "retry_sales_handoff",
  CRM_UNAVAILABLE: "requeue_stale_operation",
  CONVERSION_LINKAGE_UNRESOLVED: "review_conversion_linkage",
  PRIVACY_SUPPRESSED: "review_privacy_suppression",
  RETENTION_EXPIRED: "dispose_retention_expired",
  CROSS_TENANT_REJECTION: "review_fail_closed_evidence",
  SECURITY_REJECTION: "review_fail_closed_evidence",
  STALE_OPERATION: "requeue_stale_operation",
  UNSUPPORTED_CAPABILITY: "integrate_lead_capability",
};

function pushBlocker(
  blockers: LeadDerivedBlocker[],
  blockerClass: LeadBlockerClass,
  area: string,
  evidence: string,
  since: Date | null
): void {
  const policy = LEAD_BLOCKER_CLASS_POLICY[blockerClass];
  blockers.push({
    blockerClass,
    recoveryClass: policy.recoveryClass,
    healthImpact: policy.healthImpact,
    area,
    evidence: evidence.slice(0, 300),
    since,
    safeNextAction: SAFE_ACTION_BY_BLOCKER[blockerClass],
  });
}

/**
 * Pure blocker derivation over normalized evidence.
 *
 * Wired blocker sources:
 * - the F-owned privacy gate (authoritative today);
 * - per-area explicit evidence gated on `area.supported === true` — the
 *   R6-X convergence seam for A/B/C/D/E. Today's collectors always mark
 *   those areas `supported: false`, so nothing is derived from absence;
 *   when a stream registers durable evidence, the same fields drive
 *   classification here. Security/tenant classes (CROSS_TENANT_REJECTION,
 *   SECURITY_REJECTION) additionally require explicit fail-closed evidence
 *   and are never produced from these routine area statuses.
 */
export function deriveLeadBlockers(evidence: LeadOperationsEvidence): LeadDerivedBlocker[] {
  const blockers: LeadDerivedBlocker[] = [];
  if (!evidence.leadFound) return blockers;

  const state = evidence.privacy.available ? evidence.privacy.state : null;
  if (state === "SUPPRESSED" || state === "RESTRICTED") {
    pushBlocker(
      blockers,
      "PRIVACY_SUPPRESSED",
      "privacy",
      `lead privacy state is ${state}${evidence.privacy.explicit ? "" : " (implicit)"}`,
      evidence.privacy.updatedAt
    );
  }
  if (state === "RETENTION_EXPIRED" || state === "ARCHIVED") {
    pushBlocker(
      blockers,
      "RETENTION_EXPIRED",
      "privacy",
      state === "ARCHIVED"
        ? "lead is archived (terminal privacy state); retention disposition complete"
        : `retention deadline ${evidence.privacy.retentionDeadlineAt ? evidence.privacy.retentionDeadlineAt.toISOString() : "unknown"} has passed`,
      evidence.privacy.updatedAt
    );
  }

  // ─── A/B/C/D/E convergence seam: explicit evidence only ───
  if (evidence.identity.supported) {
    if (evidence.identity.identityStatus === "conflicting") {
      pushBlocker(blockers, "IDENTITY_CONFLICT", "identity", "identity records conflict; human merge review required", null);
    } else if (evidence.identity.identityStatus === "unresolved") {
      pushBlocker(blockers, "IDENTITY_INSUFFICIENT_EVIDENCE", "identity", "identity evidence collection in progress", null);
    }
  }
  if (evidence.scoring.supported) {
    if (evidence.scoring.scoreStatus === "stale") {
      pushBlocker(blockers, "SCORE_STALE", "scoring", "lead score is older than its freshness window", null);
    } else if (evidence.scoring.scoreStatus === "unavailable") {
      pushBlocker(blockers, "SCORE_UNAVAILABLE", "scoring", "scoring authority cannot produce a score", null);
    }
  }
  if (evidence.qualification.supported) {
    if (evidence.qualification.qualificationStatus === "requires_review") {
      pushBlocker(blockers, "QUALIFICATION_REQUIRES_REVIEW", "qualification", "qualification is parked in a human review queue", null);
    } else if (evidence.qualification.qualificationStatus === "blocked") {
      pushBlocker(blockers, "QUALIFICATION_BLOCKED", "qualification", "a governance decision blocks qualification", null);
    }
  }
  if (evidence.nurture.supported && evidence.nurture.status === "policy_blocked") {
    pushBlocker(blockers, "NURTURE_POLICY_BLOCKED", "nurture", "policy blocks nurture outreach for this lead", null);
  }
  if (evidence.salesHandoff.supported && evidence.salesHandoff.handoffStatus === "failed") {
    pushBlocker(blockers, "SALES_HANDOFF_FAILED", "sales_handoff", "handoff transport failed; bounded retry eligible", null);
  }
  if (evidence.conversion.supported && evidence.conversion.conversionStatus === "linkage_unresolved") {
    pushBlocker(blockers, "CONVERSION_LINKAGE_UNRESOLVED", "conversion", "conversion cannot be deterministically linked to this lead", null);
  }

  return blockers;
}

export function deriveLeadOperationalState(
  evidence: LeadOperationsEvidence,
  blockers: LeadDerivedBlocker[],
  now: Date
): LeadOperationalStateDerivation {
  const notes: string[] = [];

  const capabilityAreas = [
    evidence.leadFound,
    evidence.privacy.available && evidence.privacy.explicit,
  ];
  const capabilitiesPresent = evidence.leadFound
    ? capabilityAreas.filter(Boolean).length
    : 0;

  if (!evidence.leadFound || capabilitiesPresent === 0) {
    return {
      health: "UNSUPPORTED",
      blockers,
      safeNextAction: "integrate_lead_capability",
      operatorActionRequired: false,
      isStale: false,
      staleness: { lastActivityAgeMs: null, thresholdMs: LEAD_STALENESS_THRESHOLDS.leadActivityMs },
      capabilitiesPresent,
      notes: ["no lead capability evidence"],
    };
  }

  let worst: LeadBlockerHealthImpact = "none";
  for (const blocker of blockers) {
    if (blocker.healthImpact === "fail_closed") worst = "fail_closed";
    else if (blocker.healthImpact === "operator" && worst !== "fail_closed") worst = "operator";
    else if (blocker.healthImpact === "configuration" && worst !== "fail_closed" && worst !== "operator")
      worst = "configuration";
    else if (blocker.healthImpact === "auto" && worst === "none") worst = "auto";
  }

  let health: LeadOperationalHealth;
  switch (worst) {
    case "fail_closed":
      health = "FAIL_CLOSED";
      break;
    case "operator":
      health = "BLOCKED_OPERATOR";
      break;
    case "configuration":
      health = "BLOCKED_CONFIGURATION";
      break;
    case "auto":
      health = "AUTO_RECOVERING";
      break;
    default:
      health = "HEALTHY";
  }

  const lastActivityAgeMs =
    evidence.activity.lastActivityAt !== null
      ? Math.max(0, now.getTime() - evidence.activity.lastActivityAt.getTime())
      : null;
  const isStale =
    lastActivityAgeMs !== null && lastActivityAgeMs > LEAD_STALENESS_THRESHOLDS.leadActivityMs;
  if (isStale) notes.push("no recorded lead activity within the staleness window");

  let safeNextAction: LeadSafeNextAction = "none";
  for (const impact of ["fail_closed", "operator", "configuration", "auto", "none"] as const) {
    const blocker = blockers.find((b) => b.healthImpact === impact && b.safeNextAction !== "none");
    if (blocker) {
      safeNextAction = blocker.safeNextAction;
      break;
    }
  }

  const operatorActionRequired = blockers.some(
    (b) => b.recoveryClass === "OPERATOR_ACTION" || b.recoveryClass === "GOVERNANCE_APPROVAL"
  );

  return {
    health,
    blockers,
    safeNextAction,
    operatorActionRequired,
    isStale,
    staleness: { lastActivityAgeMs, thresholdMs: LEAD_STALENESS_THRESHOLDS.leadActivityMs },
    capabilitiesPresent,
    notes,
  };
}

// ─── Projection output ───

export interface LeadOperationsProjection {
  generatedAt: string;
  leadId: number;
  userId: number;
  businessId: number | null;
  campaignId: number | null;
  crmStatus: string;
  identity: LeadIdentityArea;
  scoring: LeadScoringArea;
  qualification: LeadQualificationArea;
  nurture: LeadNurtureArea;
  salesHandoff: LeadSalesHandoffArea;
  conversion: LeadConversionArea;
  privacy: {
    supported: boolean;
    status: LeadPrivacyEvidence["state"] | "unavailable";
    explicit: boolean;
    retentionDeadlineAt: string | null;
    updatedAt: string | null;
    unavailableReason?: string;
  };
  suppression: {
    state: LeadPrivacyEvidence["state"];
    suppressed: boolean;
    restricted: boolean;
  };
  lastActivityAt: string | null;
  lastSuccessfulTransitionAt: string | null;
  staleness: { lastActivityAgeMs: number | null; thresholdMs: number; isStale: boolean };
  health: LeadOperationalHealth;
  blockers: LeadDerivedBlocker[];
  safeNextAction: LeadSafeNextAction;
  operatorActionRequired: boolean;
  capabilitiesPresent: number;
  notes: string[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function projectLeadOperations(input: {
  leadId: number;
  now?: Date;
  executor?: Db;
}): Promise<LeadOperationsProjection> {
  const now = input.now ?? new Date();
  const db = input.executor ?? getDb();
  const evidence = await collectLeadOperationsEvidence(db, input.leadId, now);
  const blockers = deriveLeadBlockers(evidence);
  const derivation = deriveLeadOperationalState(evidence, blockers, now);

  const privacyState = evidence.privacy.state;
  return {
    generatedAt: now.toISOString(),
    leadId: input.leadId,
    userId: evidence.lead?.userId ?? 0,
    businessId: evidence.lead?.businessId ?? null,
    campaignId: evidence.lead?.campaignId ?? null,
    crmStatus: evidence.lead?.status ?? "unknown",
    identity: evidence.identity,
    scoring: evidence.scoring,
    qualification: evidence.qualification,
    nurture: evidence.nurture,
    salesHandoff: evidence.salesHandoff,
    conversion: evidence.conversion,
    privacy: {
      supported: evidence.privacy.available,
      status: evidence.privacy.available ? privacyState : "unavailable",
      explicit: evidence.privacy.explicit,
      retentionDeadlineAt: iso(evidence.privacy.retentionDeadlineAt),
      updatedAt: iso(evidence.privacy.updatedAt),
      ...(evidence.privacy.reason ? { unavailableReason: evidence.privacy.reason } : {}),
    },
    suppression: {
      state: privacyState,
      suppressed: privacyState === "SUPPRESSED",
      restricted: privacyState === "RESTRICTED",
    },
    lastActivityAt: iso(evidence.activity.lastActivityAt),
    lastSuccessfulTransitionAt: iso(evidence.activity.lastSuccessfulTransitionAt),
    staleness: {
      lastActivityAgeMs: derivation.staleness.lastActivityAgeMs,
      thresholdMs: derivation.staleness.thresholdMs,
      isStale: derivation.isStale,
    },
    health: derivation.health,
    blockers: derivation.blockers,
    safeNextAction: derivation.safeNextAction,
    operatorActionRequired: derivation.operatorActionRequired,
    capabilitiesPresent: derivation.capabilitiesPresent,
    notes: derivation.notes,
  };
}
