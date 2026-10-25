// ─── R6-A Lead Identity — pure derivation (status, confidence, type, resolution) ───
//
// Deterministic evidence → identity-state functions (contract §4, §5, §8).
// No I/O, no clock, no model. Identity confidence is a bounded honest
// ordinal — never a probability, never client-supplied, never derived from
// R5 opportunity confidence (evidence only, not identity authority).

import type {
  IdentityStatus,
  IdentityConfidence,
  IdentityType,
  LinkingEvidenceType,
} from "./lead-identity-contract";

const TERMINAL_STATUSES: readonly IdentityStatus[] = ["suppressed", "merged", "archived"];

export function isTerminalIdentityStatus(status: IdentityStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses eligible for deterministic automatic merge (contract §8). */
export function isMergeEligibleStatus(status: IdentityStatus): boolean {
  return status === "active" || status === "anonymous" ||
    status === "partially_identified" || status === "resolved";
}

export interface IdentityEvidenceSummary {
  readonly hasActor: boolean;
  readonly linkingKeyTypes: readonly LinkingEvidenceType[];
  readonly hasAuthenticatedCustomerReference: boolean;
  readonly hasCrmExternalReference: boolean;
  readonly conflictDetected: boolean;
}

function distinctLinkingKeyTypeCount(summary: IdentityEvidenceSummary): number {
  return new Set(summary.linkingKeyTypes).size;
}

/**
 * Evidence-driven identity status. Terminal statuses are preserved;
 * `conflicting` is sticky (cleared only by R6-F operator resolution — never
 * by automatic transitions). Everything else derives from evidence only.
 */
export function deriveIdentityStatus(
  current: IdentityStatus,
  summary: IdentityEvidenceSummary
): IdentityStatus {
  if (isTerminalIdentityStatus(current)) return current;
  if (current === "conflicting") return current;
  if (summary.conflictDetected) return "conflicting";
  if (
    summary.hasAuthenticatedCustomerReference ||
    summary.hasCrmExternalReference ||
    distinctLinkingKeyTypeCount(summary) >= 2
  ) {
    return "resolved";
  }
  if (summary.linkingKeyTypes.length >= 1) return "partially_identified";
  if (summary.hasActor) return "active";
  return "anonymous";
}

export interface IdentityConfidenceInput {
  readonly hasActor: boolean;
  readonly handoffObservationCount: number;
  readonly linkingKeyTypeCount: number;
  readonly hasAuthenticatedCustomerReference: boolean;
}

export function deriveIdentityConfidence(input: IdentityConfidenceInput): IdentityConfidence {
  if (
    input.hasAuthenticatedCustomerReference ||
    input.linkingKeyTypeCount >= 2 ||
    (input.linkingKeyTypeCount >= 1 && input.handoffObservationCount >= 2)
  ) {
    return "high";
  }
  if (input.linkingKeyTypeCount >= 1 || input.handoffObservationCount >= 2) return "medium";
  if (input.hasActor) return "low";
  return "unknown";
}

// ─── Primary identity type precedence (contract §3) ───

const IDENTITY_TYPE_TIER: Record<IdentityType, number> = {
  authenticated_customer_reference: 1,
  crm_external_reference: 2,
  email_hash: 3,
  phone_hash: 4,
  provider_actor: 5,
  anonymous_thread: 6,
  unknown: 7,
};

/**
 * Adopt a new primary identity type only when its precedence tier is strictly
 * stronger than the incumbent; equal-tier evidence (email vs phone) never
 * displaces the first-evidenced type. Deterministic and history-preserving.
 */
export function adoptPrimaryIdentityType(
  current: IdentityType,
  evidenced: IdentityType
): IdentityType {
  if (IDENTITY_TYPE_TIER[evidenced] < IDENTITY_TYPE_TIER[current]) return evidenced;
  return current;
}

export function linkingEvidenceTypeToIdentityType(keyType: LinkingEvidenceType): IdentityType {
  return keyType;
}

// ─── Deterministic resolution classification (contract §8, A3/A4) ───
//
// Verdicts: MATCH | NO_MATCH | CONFLICT | INSUFFICIENT_EVIDENCE.
// Only authoritative evidence can produce MATCH across distinct identities:
// a verified linking key shared within the same tenant + business scope.
// Provider-actor evidence alone never merges two identities; a cross-provider
// equivalence question backed only by actor evidence is INSUFFICIENT_EVIDENCE.

export const RESOLUTION_VERDICTS = ["MATCH", "NO_MATCH", "CONFLICT", "INSUFFICIENT_EVIDENCE"] as const;
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

export interface IdentityResolutionQuestion {
  /** Provider-scoped actor hash (R5 actorKey), if actor-present. */
  readonly actorKey: string | null;
  readonly provider: string | null;
  /** Authoritative verified linking keys, if any. */
  readonly emailHash?: string | null;
  readonly phoneHash?: string | null;
  readonly customerReferenceHash?: string | null;
  /** True when the question explicitly spans two providers/channels. */
  readonly crossChannel: boolean;
}

export interface ResolutionCandidateView {
  readonly leadId: string;
  readonly businessScope: number | null;
  readonly identityStatus: IdentityStatus;
  readonly emailIdentityHash: string | null;
  readonly phoneIdentityHash: string | null;
  readonly customerReferenceHash: string | null;
}

export interface ResolutionDecision {
  readonly verdict: ResolutionVerdict;
  /** Merge is required to honor the match (distinct identities, authoritative key). */
  readonly requiresMerge: boolean;
  readonly reason: string;
}

function questionLinkingKeys(question: IdentityResolutionQuestion): LinkingEvidenceType[] {
  const keys: LinkingEvidenceType[] = [];
  if (question.emailHash) keys.push("email_hash");
  if (question.phoneHash) keys.push("phone_hash");
  if (question.customerReferenceHash) {
    keys.push("authenticated_customer_reference");
  }
  return keys;
}

/**
 * Classify an identity resolution question against at most one candidate
 * identity (same actor coordinates) and at most one linking-key owner. The
 * service performs the DB lookups; this function decides — pure and total.
 */
export function classifyIdentityResolution(
  question: IdentityResolutionQuestion,
  candidate: ResolutionCandidateView | null,
  linkingKeyOwner: (ResolutionCandidateView & { keyType: LinkingEvidenceType }) | null
): ResolutionDecision {
  if (linkingKeyOwner) {
    if (candidate && linkingKeyOwner.leadId === candidate.leadId) {
      return { verdict: "MATCH", requiresMerge: false, reason: "linking key already bound to this identity" };
    }
    const owner = linkingKeyOwner;
    const scope = candidate?.businessScope ?? null;
    if (owner.businessScope !== scope) {
      return {
        verdict: "CONFLICT",
        requiresMerge: false,
        reason: "authoritative linking key is owned by an identity in a different business scope; automatic merge blocked",
      };
    }
    if (!isMergeEligibleStatus(owner.identityStatus)) {
      return {
        verdict: "CONFLICT",
        requiresMerge: false,
        reason: "linking key owner is in a terminal/conflicting state; automatic merge blocked",
      };
    }
    return {
      verdict: "MATCH",
      requiresMerge: true,
      reason: `shared authoritative ${linkingKeyOwner.keyType} evidence within one business scope`,
    };
  }

  const linkingKeys = questionLinkingKeys(question);
  if (linkingKeys.length > 0 && !candidate) {
    // Authoritative key with no owner and no actor candidate: nothing to bind to.
    return { verdict: "NO_MATCH", requiresMerge: false, reason: "no identity holds this authoritative key" };
  }

  if (candidate) {
    return { verdict: "MATCH", requiresMerge: false, reason: "same tenant + business scope + actor coordinates" };
  }

  if (question.crossChannel) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      requiresMerge: false,
      reason: "cross-channel equivalence backed only by unverified channel actor evidence",
    };
  }
  return { verdict: "NO_MATCH", requiresMerge: false, reason: "no identity matches the supplied coordinates" };
}

/** Normalized business scope for merge eligibility (null = tenant-unattributed). */
export function normalizedBusinessScope(businessId: number | null): number | null {
  return businessId === null ? null : businessId;
}

export function sameBusinessScope(a: number | null, b: number | null): boolean {
  return normalizedBusinessScope(a) === normalizedBusinessScope(b);
}
